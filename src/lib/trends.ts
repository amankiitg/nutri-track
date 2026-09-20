/**
 * The Trends screen's data and the pure logic behind its date navigation.
 *
 * Same rule as the dashboard: nothing here sums, averages or counts. `get_period_summary`
 * and `get_weight_series` do all of it in Postgres, over `daily_summaries`, and this file
 * only decides which dates to ask about and how to say them in English.
 *
 * Every date crossing this boundary is a `YYYY-MM-DD` string, never a `Date`. A `Date`
 * is an instant, and an instant formatted in one zone and parsed in another is a
 * different day — the bug that made the dashboard's timeline read "Thu" for a Friday.
 * Strings cannot disagree about which day they are.
 */
import {
  addMonths,
  addWeeks,
  addYears,
  endOfMonth,
  endOfWeek,
  endOfYear,
  format,
  parseISO,
  startOfMonth,
  startOfWeek,
  startOfYear,
} from "date-fns";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";

export const GRANULARITIES = ["week", "month", "year"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

export const GRANULARITY_LABELS: Record<Granularity, string> = {
  week: "Week",
  month: "Month",
  year: "Year",
};

export interface Period {
  /** Inclusive, `YYYY-MM-DD`. */
  start: string;
  /** Inclusive, `YYYY-MM-DD`. */
  end: string;
}

const DAY = "yyyy-MM-dd";

/** `parseISO` on a date-only string gives local midnight, so this round-trips. */
function toDate(day: string): Date {
  return parseISO(day);
}

function toDay(date: Date): string {
  return format(date, DAY);
}

/**
 * The calendar period containing `anchor`.
 *
 * Weeks start on Monday. The period is the whole calendar unit, including days still to
 * come — "September 2026" means September, not "September so far" — and `clampEnd` is
 * what stops a query from asking for the future.
 */
export function periodFor(granularity: Granularity, anchor: string): Period {
  const at = toDate(anchor);
  switch (granularity) {
    case "week":
      return {
        start: toDay(startOfWeek(at, { weekStartsOn: 1 })),
        end: toDay(endOfWeek(at, { weekStartsOn: 1 })),
      };
    case "month":
      return { start: toDay(startOfMonth(at)), end: toDay(endOfMonth(at)) };
    case "year":
      return { start: toDay(startOfYear(at)), end: toDay(endOfYear(at)) };
  }
}

/**
 * The period `direction` units away.
 *
 * Shifting starts from the period's **start**, not from the anchor that produced it.
 * Moving a Friday back one week gives the previous Friday — still the same week — so the
 * naive version appears to work and silently refuses to navigate. Stepping from the
 * Monday gives the Monday before it.
 */
export function shiftPeriod(granularity: Granularity, period: Period, direction: -1 | 1): Period {
  const from = toDate(period.start);
  const moved =
    granularity === "week"
      ? addWeeks(from, direction)
      : granularity === "month"
        ? addMonths(from, direction)
        : addYears(from, direction);
  return periodFor(granularity, toDay(moved));
}

const MONTH_DAY_LOCALE = "en-GB";

/**
 * Labels are rendered with `Intl` rather than date-fns' `format`, for one letter.
 *
 * date-fns gives the short month as "Sep" in both its default locale and `enGB`, while
 * `Intl` in `en-GB` gives "Sept" — which is what the weight card on Today already shows.
 * Two abbreviations that differ by a letter is a small thing that looks like a bug on a
 * screen the user sees side by side with the other one.
 *
 * The date is rebuilt in UTC from its parts before formatting. Formatting local midnight
 * in UTC would move the date back a day in every negative-offset zone, which is how
 * "today" becomes yesterday.
 */
function utcFromDay(day: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function labelFor(part: Intl.DateTimeFormatOptions) {
  const formatter = new Intl.DateTimeFormat(MONTH_DAY_LOCALE, { timeZone: "UTC", ...part });
  return (day: string): string => {
    const at = utcFromDay(day);
    return at === null ? day : formatter.format(at);
  };
}

const dayMonth = labelFor({ day: "numeric", month: "short" });
const dayOnly = labelFor({ day: "numeric" });
const monthYear = labelFor({ month: "long", year: "numeric" });
const yearOnly = labelFor({ year: "numeric" });
const yearMonth = labelFor({ year: "numeric", month: "2-digit" });

/**
 * The period in words: "7–13 Sept 2026", "31 Aug – 6 Sept 2026", "September 2026", "2026".
 *
 * A week that straddles a month or a year names both ends, because "7–13 Sept" is
 * unambiguous only while both ends are in September.
 */
export function periodLabel(granularity: Granularity, period: Period): string {
  if (granularity === "year") return yearOnly(period.start);
  if (granularity === "month") return monthYear(period.start);

  if (yearMonth(period.start) === yearMonth(period.end)) {
    return `${dayOnly(period.start)}–${dayMonth(period.end)} ${yearOnly(period.end)}`;
  }
  if (yearOnly(period.start) === yearOnly(period.end)) {
    return `${dayMonth(period.start)} – ${dayMonth(period.end)} ${yearOnly(period.end)}`;
  }
  return `${dayMonth(period.start)} ${yearOnly(period.start)} – ${dayMonth(period.end)} ${yearOnly(period.end)}`;
}

/**
 * The part of the period that has actually happened.
 *
 * Asking for the rest of September would return a row per future day, all zero, and
 * every average taken over them would be dragged towards zero by days that have not
 * occurred. The chart draws only as far as today and the totals only count real days.
 */
export function clampEnd(period: Period, today: string): Period {
  return { start: period.start, end: period.end > today ? today : period.end };
}

/** Whether the period contains today, which is what disables the "next" button. */
export function containsToday(period: Period, today: string): boolean {
  return period.start <= today && today <= period.end;
}

const numeric = z.union([z.number(), z.string()]).transform((value) => Number(value));

const numericOrNull = z
  .union([z.number(), z.string(), z.null()])
  .transform((value) => (value === null ? null : Number(value)));

/**
 * An entry in the chart series. A day for the week and month views, a week for the year.
 *
 * A year of daily bars is 254 of them, and its axis reads "12, 01, 21, 13, 02, 23" — a
 * chart that conveys the presence of data and nothing else. Weekly buckets make the year
 * legible while the shorter views, where every day is already readable, stay daily.
 *
 * `calories` is the bucket's total (what the bar shows) and `avg_calories` is the
 * per-logged-day average (what the status is computed from). Those differ on purpose: a
 * week with three logged days and four empty ones is not "under", it is partly
 * unrecorded, and comparing its sum against a seven-day allowance would say the opposite.
 */
const periodBucket = z.object({
  bucket_start: z.string(),
  bucket_end: z.string(),
  /** Days the bucket covers: 7 for a full week, 1 for a day, fewer at a range's edge. */
  bucket_days: numeric,
  days_logged: numeric,
  meal_count: numeric,
  calories: numeric,
  protein_kcal: numeric,
  carbs_kcal: numeric,
  fat_kcal: numeric,
  /** The bucket's allowance: the per-day target in force, times `bucket_days`. */
  target_calories: numericOrNull,
  avg_calories: numericOrNull,
  avg_target_calories: numericOrNull,
  avg_protein_g: numericOrNull,
  avg_carbs_g: numericOrNull,
  avg_fat_g: numericOrNull,
  status: z.string().nullable(),
});

export type PeriodBucket = z.infer<typeof periodBucket>;

const periodTotals = z.object({
  days_logged: numeric,
  days_judged: numeric,
  days_on_track: numeric,
  adherence_pct: numericOrNull,
  avg_calories: numericOrNull,
  avg_target_calories: numericOrNull,
  avg_protein_g: numericOrNull,
  avg_target_protein_g: numericOrNull,
  avg_carbs_g: numericOrNull,
  avg_fat_g: numericOrNull,
  protein_kcal: numericOrNull,
  carbs_kcal: numericOrNull,
  fat_kcal: numericOrNull,
  total_meals: numeric,
});

export type PeriodTotals = z.infer<typeof periodTotals>;

const periodSummary = z.object({
  start: z.string(),
  end: z.string(),
  bucket: z.string(),
  window_days: numeric,
  buckets: z.array(periodBucket),
  totals: periodTotals,
});

export type PeriodSummary = z.infer<typeof periodSummary>;

const weightPoint = z.object({
  logged_on: z.string(),
  weight_kg: numeric,
  waist_cm: numericOrNull,
  weight_avg_7d: numericOrNull,
});

export type WeightPoint = z.infer<typeof weightPoint>;

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

/** How the chart series is grouped. Week and month are legible daily; a year is not. */
export type Bucket = "day" | "week";

export function bucketFor(granularity: Granularity): Bucket {
  return granularity === "year" ? "week" : "day";
}

/** One row per bucket in the range, plus the period's totals. One round trip. */
export async function fetchPeriodSummary(
  period: Period,
  bucket: Bucket = "day",
): Promise<PeriodSummary> {
  const { data, error } = await supabase.rpc("get_period_summary", {
    p_start: period.start,
    p_end: period.end,
    p_bucket: bucket,
  });
  if (error) throw error;

  return parseOrThrow(periodSummary, data, "get_period_summary");
}

/** The weigh-ins in the range, each with its trailing 7-day average. */
export async function fetchWeightSeries(period: Period): Promise<WeightPoint[]> {
  const { data, error } = await supabase.rpc("get_weight_series", {
    p_start: period.start,
    p_end: period.end,
  });
  if (error) throw error;

  return parseOrThrow(z.array(weightPoint), data, "get_weight_series");
}

/** True when there is nothing worth drawing for this period. */
export function isEmptyPeriod(summary: PeriodSummary): boolean {
  return (
    summary.totals.days_logged === 0 && summary.buckets.every((bucket) => bucket.meal_count === 0)
  );
}

const bucketDay = labelFor({ day: "numeric" });
const bucketDayMonth = labelFor({ day: "numeric", month: "short" });

/**
 * The x-axis tick for one bucket.
 *
 * A daily bucket is a day number, which is unambiguous within a week or a month. A
 * weekly one is not: 37 ticks reading "07", "14", "21" repeat and say nothing about
 * which month they belong to, so a week carries its month.
 */
export function bucketTick(bucketStart: string, bucket: Bucket): string {
  return bucket === "week" ? bucketDayMonth(bucketStart) : bucketDay(bucketStart);
}

/**
 * The macro split as shares of energy, for the donut.
 *
 * Returns null rather than three zeroes when there is nothing to show, because a donut
 * of three zero slices is an empty ring that reads as a rendering failure.
 */
export function macroShares(
  totals: PeriodTotals,
): { key: "protein" | "carbs" | "fat"; kcal: number; share: number }[] | null {
  const protein = totals.protein_kcal ?? 0;
  const carbs = totals.carbs_kcal ?? 0;
  const fat = totals.fat_kcal ?? 0;
  const total = protein + carbs + fat;
  if (total <= 0) return null;

  return [
    { key: "protein", kcal: protein, share: protein / total },
    { key: "carbs", kcal: carbs, share: carbs / total },
    { key: "fat", kcal: fat, share: fat / total },
  ];
}

/**
 * How wide a y-axis has to be for its own labels, in px.
 *
 * Recharts takes a fixed width and then clips to the SVG instead of making room, and because
 * the ticks are right-aligned against the plot, the label that does not fit loses its
 * *leading* digits: at a 390px viewport "3200" was drawn from x=-7.8 and read "200".
 *
 * A constant cannot be correct here, because the label is as wide as the number is long, and
 * the same axis reads differently depending on the bucket: a daily bar is one day, a weekly
 * bar is seven, so the calories axis reads "3200" one way and "12600" the other. This follows
 * the widest label the axis can produce — the largest value as it will be written, plus one
 * character, since the top tick rounds up to a nice number above the data (9,500 becomes
 * 10,000, and 3,200 can become 4,000).
 *
 * `AXIS_CHAR_WIDTH` is measured off a rendered chart rather than guessed: at `fontSize: 11`,
 * "3200" occupies 25.8px, which is 6.45px per character, and this leaves margin over that.
 * `String`, not `toLocaleString`, because that is what the axis draws — the measured tick
 * reads "3200", with no thousands separator.
 */
const AXIS_CHAR_WIDTH = 7.2;
const AXIS_LABEL_PADDING = 6;

export function axisWidth(values: readonly number[], fontSize = 11): number {
  let widest = 0;
  for (const value of values) {
    if (Number.isFinite(value)) widest = Math.max(widest, Math.abs(value));
  }

  const characters = String(widest).length + 1;
  const perCharacter = (fontSize / 11) * AXIS_CHAR_WIDTH;
  return Math.ceil(characters * perCharacter + AXIS_LABEL_PADDING);
}
