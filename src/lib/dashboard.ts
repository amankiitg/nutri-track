/**
 * The Today dashboard's data and the pure logic behind what it displays.
 *
 * Every number here comes from a Postgres function (see
 * `supabase/migrations/20260911160000_today_dashboard_functions.sql`). Nothing in this
 * file sums items, counts days or averages anything: those are the questions a database
 * answers correctly once, and a browser answers differently every time an empty day is
 * left out of the loop.
 *
 * What does live here is presentation logic — how a fraction of a target becomes a ring,
 * what the verdict sounds like in English — kept as pure functions so it can be tested
 * without a database or a renderer.
 */
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";

/** The window the verdict line describes. */
export const VERDICT_DAYS = 7;

/**
 * `numeric` arrives as a JSON number through PostgREST, but a numeric-as-string is a
 * documented way for that to differ between versions and settings. Accepting both and
 * converting once here is cheaper than discovering it in a ring that renders "0".
 */
const numeric = z.union([z.number(), z.string()]).transform((value) => Number(value));

const numericOrNull = z
  .union([z.number(), z.string(), z.null()])
  .transform((value) => (value === null ? null : Number(value)));

const dailyTotalsRow = z.object({
  local_date: z.string(),
  meal_count: numeric,
  calories: numeric,
  protein_g: numeric,
  carbs_g: numeric,
  fat_g: numeric,
  fiber_g: numeric,
  target_calories: numericOrNull,
  target_protein_g: numericOrNull,
  target_carbs_g: numericOrNull,
  target_fat_g: numericOrNull,
  remaining_calories: numericOrNull,
  status: z.string().nullable(),
});

export type DailyTotals = z.infer<typeof dailyTotalsRow>;

export const VERDICTS = [
  "no_data",
  "no_target",
  "too_few_days",
  "under",
  "over",
  "on_track",
] as const;

export type Verdict = (typeof VERDICTS)[number];

const weekVerdictRow = z.object({
  window_days: numeric,
  days_logged: numeric,
  days_judged: numeric,
  days_on_track: numeric,
  avg_calories: numericOrNull,
  avg_target_calories: numericOrNull,
  avg_protein_g: numericOrNull,
  avg_target_protein_g: numericOrNull,
  verdict: z.enum(VERDICTS),
});

export type WeekVerdict = z.infer<typeof weekVerdictRow>;

const timelineItem = z.object({
  id: z.string(),
  name: z.string(),
  quantity: numericOrNull,
  unit: z.string().nullable(),
  grams: numericOrNull,
  calories: numeric,
  protein_g: numeric,
  carbs_g: numeric,
  fat_g: numeric,
  fiber_g: numericOrNull,
  confidence: numericOrNull,
  user_edited: z.boolean(),
});

export type TimelineItem = z.infer<typeof timelineItem>;

const timelineMeal = z.object({
  id: z.string(),
  eaten_at: z.string(),
  meal_type: z.string(),
  source: z.string(),
  notes: z.string().nullable(),
  photo_count: numeric,
  calories: numeric,
  protein_g: numeric,
  carbs_g: numeric,
  fat_g: numeric,
  item_count: numeric,
  items: z.array(timelineItem),
});

export type TimelineMeal = z.infer<typeof timelineMeal>;

/**
 * A zod failure here means the database returned something this screen does not
 * understand, which is worth an error rather than a dashboard of zeroes. Returning
 * empty data instead would make a broken deployment look like a day with no meals.
 *
 * The input type is `unknown` rather than `T`, because these schemas convert: a
 * `numeric` may arrive as a string, so the schema's input is wider than its output. A
 * signature of `ZodType<T>` pins both to `T` and silently widens the result back to
 * `string | number`.
 */
function parseOrThrow<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  data: unknown,
  what: string,
): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Unexpected shape from ${what}: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Today's ring and macro bars. `date` is the profile's local date, YYYY-MM-DD. */
export async function fetchDailyTotals(date: string): Promise<DailyTotals> {
  const { data, error } = await supabase.rpc("daily_totals", { p_date: date });
  if (error) throw error;

  const rows = parseOrThrow(z.array(dailyTotalsRow), data, "daily_totals");
  const row = rows[0];
  // The function's anchor row means it always returns exactly one row; if that ever
  // stops being true, say so rather than rendering a zero that is not 0.
  if (!row) throw new Error("daily_totals returned no row");
  return row;
}

/** The trailing-window verdict. */
export async function fetchWeekVerdict(
  date: string,
  days: number = VERDICT_DAYS,
): Promise<WeekVerdict> {
  const { data, error } = await supabase.rpc("week_verdict", { p_end_date: date, p_days: days });
  if (error) throw error;

  const rows = parseOrThrow(z.array(weekVerdictRow), data, "week_verdict");
  const row = rows[0];
  if (!row) throw new Error("week_verdict returned no row");
  return row;
}

/** The day's meals, each with its items and its own totals. */
export async function fetchTimeline(date: string): Promise<TimelineMeal[]> {
  const { data, error } = await supabase.rpc("meals_for_day", { p_date: date });
  if (error) throw error;

  return parseOrThrow(z.array(timelineMeal), data, "meals_for_day");
}

/**
 * Soft-deletes a meal, so the timeline's undo has something to undo.
 *
 * Nothing is deleted from storage here. The photos stay, which is what makes undo
 * possible, and the sweeper will not touch them either while this row still names
 * them — so a meal deleted and never restored keeps its photos indefinitely. That is
 * the deliberate side of the trade: a few megabytes against an undo that works.
 */
export async function deleteMeal(mealId: string): Promise<void> {
  const { error } = await supabase
    .from("meals")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", mealId);
  if (error) throw error;
}

/** Puts a soft-deleted meal back. */
export async function restoreMeal(mealId: string): Promise<void> {
  const { error } = await supabase.from("meals").update({ deleted_at: null }).eq("id", mealId);
  if (error) throw error;
}

export interface RingGeometry {
  /** How much of the ring to draw, 0 to 1. Clamped, so an over-target day is a full ring. */
  fraction: number;
  /** Calories past the target, 0 when under. */
  over: number;
  /** Target minus consumed. Negative once the target is passed. Null without a target. */
  remaining: number | null;
}

export function ringGeometry(consumed: number, target: number | null): RingGeometry {
  if (target === null || target <= 0) {
    // No target is not the same as a target of zero, and a ring drawn at 0 would say
    // "you have eaten nothing" rather than "there is nothing to measure against".
    return { fraction: 0, over: 0, remaining: null };
  }
  const fraction = Math.min(Math.max(consumed / target, 0), 1);
  return {
    fraction,
    over: Math.max(consumed - target, 0),
    remaining: target - consumed,
  };
}

/** A macro bar's filled proportion, or null when there is no target to fill towards. */
export function macroFraction(consumed: number, target: number | null): number | null {
  if (target === null || target <= 0) return null;
  return Math.min(Math.max(consumed / target, 0), 1);
}

/**
 * The weekday for a `YYYY-MM-DD` date from Postgres.
 *
 * Built from the parts and formatted in UTC, never from `new Date("2026-09-11")`. That
 * string parses as UTC midnight, which in any negative-offset zone is the previous day —
 * so a naive version labels today's bar "Thu" for everyone in the Americas. The date is
 * already a calendar date in the profile's zone; it must not be reinterpreted.
 */
export function weekdayName(localDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) return "";
  const [, year, month, day] = match;
  const at = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" }).format(at);
}

/** "12:40" for a timestamp, in the profile's zone rather than the device's. */
export function formatTimeInZone(iso: string, timeZone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}

function kcal(value: number | null): string {
  return value === null ? "—" : Math.round(value).toLocaleString();
}

/**
 * The verdict line, as one sentence.
 *
 * Each state says something different, and none of them is a guess. `no_target` and
 * `too_few_days` exist because the alternatives were worse: a window with no target
 * cannot be judged, and a window with one comparable day produces a confident-looking
 * average that means nothing. Saying so is the honest output.
 */
export function verdictSentence(verdict: WeekVerdict): string {
  const window = Math.round(verdict.window_days);
  const logged = Math.round(verdict.days_logged);
  const judged = Math.round(verdict.days_judged);

  switch (verdict.verdict) {
    case "no_data":
      return `Nothing logged in the last ${window} days yet.`;
    case "no_target":
      return `${logged} day${logged === 1 ? "" : "s"} logged, but no target covers them yet, so there is nothing to compare against.`;
    case "too_few_days": {
      // The noun is always plural: it counts "the last 7 days". Only the verb agrees
      // with the number judged, which is how "1 of the last 7 days has" comes out
      // right and "1 of the last 7 day has" does not.
      return `Only ${judged} of the last ${window} days ${judged === 1 ? "has" : "have"} both meals and a target. A few more and this becomes a real trend.`;
    }
    case "on_track":
      return `Averaging ${kcal(verdict.avg_calories)} kcal over ${judged} of the last ${window} days, against ${kcal(verdict.avg_target_calories)} — on target.`;
    case "under":
      return `Averaging ${kcal(verdict.avg_calories)} kcal over ${judged} of the last ${window} days, against ${kcal(verdict.avg_target_calories)} — under target.`;
    case "over":
      return `Averaging ${kcal(verdict.avg_calories)} kcal over ${judged} of the last ${window} days, against ${kcal(verdict.avg_target_calories)} — over target.`;
  }
}

/** True when the verdict has numbers behind it, so the sentence is worth trusting. */
export function verdictHasNumbers(verdict: Verdict): boolean {
  return verdict === "under" || verdict === "over" || verdict === "on_track";
}

export const MEAL_TYPE_LABELS: Record<string, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
};

export function mealTypeLabel(mealType: string): string {
  return MEAL_TYPE_LABELS[mealType] ?? mealType;
}

/** "120 g", "1 cup", "4 piece" — whichever the parse actually recorded. */
export function quantityLabel(item: TimelineItem): string | null {
  const parts: string[] = [];
  if (item.quantity !== null) parts.push(String(item.quantity));
  if (item.unit !== null && item.unit !== "") parts.push(item.unit);
  if (parts.length > 0) return parts.join(" ");
  if (item.grams !== null) return `${Math.round(item.grams)} g`;
  return null;
}

const weightRow = z.object({
  logged_on: z.string(),
  weight_kg: numeric,
  waist_cm: numericOrNull,
});

export type WeightEntry = z.infer<typeof weightRow>;

/** The most recent weigh-ins, newest first. Keyed by day, so at most one per day. */
export async function fetchRecentWeights(limit = 2): Promise<WeightEntry[]> {
  const { data, error } = await supabase
    .from("weight_log")
    .select("logged_on, weight_kg, waist_cm")
    .order("logged_on", { ascending: false })
    .limit(limit);
  if (error) throw error;

  return parseOrThrow(z.array(weightRow), data, "weight_log");
}

export interface WeightLogInput {
  userId: string;
  date: string;
  weightKg: number;
  /** Undefined leaves any measurement already stored for the day untouched. */
  waistCm?: number | undefined;
}

export interface WeightLogRow {
  user_id: string;
  logged_on: string;
  weight_kg: number;
  source: "manual";
  /**
   * No `| undefined` here, unlike the input. Under `exactOptionalPropertyTypes` that
   * difference is the whole point: the key may be absent, but it may never be present
   * holding undefined, because the upsert would then write a null over a real
   * measurement.
   */
  waist_cm?: number;
}

/**
 * The row handed to the upsert.
 *
 * A separate function because of one detail that is easy to get wrong and invisible
 * from the outside: `waist_cm` is **absent** rather than null when the user did not
 * measure one. An upsert only writes the columns it is given, so omitting the key
 * preserves whatever was recorded earlier that day, while sending `waist_cm: null`
 * would silently erase it — turning "weight only, this morning" into a deletion of last
 * night's measurement.
 */
export function weightLogRow(input: WeightLogInput): WeightLogRow {
  return {
    user_id: input.userId,
    logged_on: input.date,
    weight_kg: input.weightKg,
    source: "manual",
    ...(input.waistCm === undefined ? {} : { waist_cm: input.waistCm }),
  };
}

/**
 * Records today's weight, and today's waist when one was measured.
 *
 * Two writes, deliberately. `weight_log` is the history and is what the trend reads;
 * `profiles.weight_kg` is the value the next BMR/TDEE calculation starts from, so
 * leaving it behind would mean the target is computed from a weight the user has
 * already corrected. This does *not* rewrite today's target — see the note in the
 * Today route: changing the target under a day already in progress is a decision, not
 * an obvious consequence of stepping on a scale.
 *
 * Unlike the profile save, which never overwrites an existing day, this one upserts:
 * the user is explicitly stating today's weight, and correcting a typo has to work.
 */
export async function logWeight(input: WeightLogInput): Promise<void> {
  const { error: logError } = await supabase
    .from("weight_log")
    .upsert(weightLogRow(input), { onConflict: "user_id,logged_on" });
  if (logError) throw logError;

  const { error: profileError } = await supabase
    .from("profiles")
    .update({ weight_kg: input.weightKg })
    .eq("user_id", input.userId);
  if (profileError) throw profileError;
}

/** "+0.4 kg since the last weigh-in", or null when there is nothing to compare. */
export function weightDelta(entries: readonly WeightEntry[]): number | null {
  const latest = entries[0];
  const previous = entries[1];
  if (!latest || !previous) return null;
  // Rounded the way it is displayed, so "+0.0 kg" never appears from a real change.
  const delta = Math.round((latest.weight_kg - previous.weight_kg) * 10) / 10;
  return delta === 0 ? null : delta;
}
