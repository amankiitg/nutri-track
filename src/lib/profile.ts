import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";
import { ageFromDob, computeTargets, type TargetResult } from "./targets";

export type Profile = Tables<"profiles">;
export type ProfileInsert = TablesInsert<"profiles">;
export type Target = Tables<"targets">;

export const DIETARY_TAG_OPTIONS = [
  "vegetarian",
  "vegan",
  "pescatarian",
  "gluten-free",
  "dairy-free",
  "halal",
  "kosher",
  "low-carb",
  "nut allergy",
] as const;

export async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * The target in force for `timeZone` on the current day.
 *
 * The zone must be the profile's, not the device's: `daily_summaries` resolves
 * each day in the profile's zone and `saveProfileWithTargets` writes
 * `effective_from` in it, so reading with a different zone can pick the wrong
 * row just after local midnight.
 */
export async function fetchCurrentTarget(userId: string, timeZone: string): Promise<Target | null> {
  const { data, error } = await supabase
    .from("targets")
    .select("*")
    .eq("user_id", userId)
    .lte("effective_from", localDateString(timeZone))
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function isEmailAllowed(): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_email_allowed");
  if (error) throw error;
  return Boolean(data);
}

/** Today's date as YYYY-MM-DD in the given IANA zone (defaults to the device zone). */
export function localDateString(timeZone?: string, date: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(date);
}

type TargetSource = Pick<
  ProfileInsert,
  | "sex"
  | "dob"
  | "height_cm"
  | "weight_kg"
  | "activity_level"
  | "goal"
  | "pace_kg_per_week"
  | "protein_g_per_kg"
>;

export function targetsFromProfile(p: TargetSource): TargetResult {
  return computeTargets({
    sex: p.sex,
    age: ageFromDob(p.dob),
    heightCm: Number(p.height_cm),
    weightKg: Number(p.weight_kg),
    activityLevel: p.activity_level,
    goal: p.goal,
    paceKgPerWeek: p.pace_kg_per_week == null ? null : Number(p.pace_kg_per_week),
    proteinGPerKg: p.protein_g_per_kg == null ? null : Number(p.protein_g_per_kg),
  });
}

async function fetchStoredWeightKg(userId: string): Promise<number | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("weight_kg")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data ? Number(data.weight_kg) : null;
}

export interface SaveProfileOptions {
  /**
   * Onboarding seeds the starting weight even when the stored value happens to
   * match. Every other save only touches the weight log when the weight changed.
   */
  seedWeight?: boolean;
}

/**
 * How far the trailing 7-day average weight must sit from the weight a target was
 * computed from before a new target is written.
 *
 * The slope is exactly `10 x activityMultiplier` kcal per kg, so 1.5 kg is worth 21-29
 * kcal at every activity level where the calorie floor is not binding — 1.3-1.8% of a
 * typical target, and an order of magnitude inside the +/-10% band `calorie_status`
 * already uses to decide whether a day was on track. It is also comfortably above the
 * day-to-day swing from water and glycogen, so it is not crossed by noise.
 */
export const TARGET_REFRESH_THRESHOLD_KG = 1.5;

/**
 * Writes one targets row, recording the weight it was derived from.
 *
 * The basis is recorded on every write, including from Settings, so a target can always
 * answer what it was computed from. Rows written before that column existed have no
 * basis, which `refreshTargetIfStale` treats as "rewrite once, then populated".
 */
async function writeTargetRow(input: {
  userId: string;
  effectiveFrom: string;
  weightKg: number;
  computed: TargetResult;
}): Promise<Target> {
  const { data, error } = await supabase
    .from("targets")
    .upsert(
      {
        user_id: input.userId,
        effective_from: input.effectiveFrom,
        calories: input.computed.calories,
        protein_g: input.computed.proteinG,
        carbs_g: input.computed.carbsG,
        fat_g: input.computed.fatG,
        weight_kg: input.weightKg,
      },
      // Relies on the `(user_id, effective_from)` unique constraint added in
      // `20260911120000_targets_unique_effective_from.sql`.
      { onConflict: "user_id,effective_from" },
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Writes the profile and a fresh targets row (effective today in the user's zone).
 * A second save on the same day updates that day's row instead of duplicating it:
 * the upsert relies on the `(user_id, effective_from)` unique constraint added in
 * `20260911120000_targets_unique_effective_from.sql`.
 */
export async function saveProfileWithTargets(
  profile: ProfileInsert,
  options: SaveProfileOptions = {},
) {
  // Read the stored weight before writing, so we can tell whether it changed.
  const previousWeightKg = await fetchStoredWeightKg(profile.user_id);

  const { data: saved, error: profileError } = await supabase
    .from("profiles")
    .upsert(profile, { onConflict: "user_id" })
    .select()
    .single();
  if (profileError) throw profileError;

  const t = targetsFromProfile(saved);
  const effectiveFrom = localDateString(saved.timezone);
  const target = await writeTargetRow({
    userId: saved.user_id,
    effectiveFrom,
    weightKg: Number(saved.weight_kg),
    computed: t,
  });

  // Only touch weight_log when the weight actually changed, or on the first
  // onboarding save. A settings visit that leaves weight alone must not append a
  // phantom entry to the weight history. Existing entries for the day are never
  // overwritten.
  const weightChanged =
    previousWeightKg === null || Number(previousWeightKg) !== Number(saved.weight_kg);
  if (options.seedWeight === true || weightChanged) {
    const { error: weightError } = await supabase.from("weight_log").upsert(
      {
        user_id: saved.user_id,
        logged_on: effectiveFrom,
        weight_kg: saved.weight_kg,
        source: "manual",
      },
      { onConflict: "user_id,logged_on", ignoreDuplicates: true },
    );
    if (weightError) throw weightError;
  }

  return { profile: saved, target, computed: t };
}

/** `numeric` can arrive as a number or as a string, and may be null. */
const numericOrNull = z
  .union([z.number(), z.string(), z.null()])
  .transform((value) => (value === null ? null : Number(value)));

const refreshDecision = z.object({
  basis_kg: numericOrNull,
  basis_effective_from: z.string().nullable(),
  average_kg: numericOrNull,
  readings: z.coerce.number(),
  difference_kg: numericOrNull,
  needed: z.boolean(),
  next_effective_from: z.string(),
});

export interface TargetRefreshResult {
  /** True when a row was written. */
  refreshed: boolean;
  /** The trailing 7-day average the new target was computed from, when one was. */
  weightKg: number | null;
  effectiveFrom: string | null;
}

/**
 * Recomputes tomorrow's target when the weight behind the current one has drifted.
 *
 * Nothing recomputed targets before this. `saveProfileWithTargets` runs from onboarding
 * and Settings only, so as weight falls the TDEE it was derived from falls too and the
 * target does not follow — 15.6 kcal per kg at moderate activity, which is 78 kcal a day
 * after five kilos, silently and permanently.
 *
 * The decision is made in Postgres (`target_refresh_needed`) and the arithmetic here,
 * because `computeTargets` is the only definition of that maths and a second copy in SQL
 * is exactly what AGENTS.md forbids. The function answers "is it stale, by how much, and
 * from what date"; this does the rest.
 *
 * Three properties worth stating:
 *
 *  - **Tomorrow, never today.** `next_effective_from` comes back from the database so the
 *    rule lives in one place. A row written for today would move the remaining calories
 *    while the user is looking at them.
 *  - **The 7-day average, not the latest reading.** A single weigh-in is a noisy estimate
 *    of body mass, so the figure that triggers the recompute is the figure the recompute
 *    uses. It also means this only fires while someone is actively weighing in.
 *  - **Idempotent.** Today's effective target keeps its old basis until tomorrow's row
 *    becomes effective, so a second call today recomputes the same values and upserts the
 *    same row. The once-per-session guard in the caller avoids the round trip; this does
 *    not depend on it.
 *
 * Returns without writing when the profile has no weight to work from, or when the
 * decision says nothing has moved.
 */
export async function refreshTargetIfStale(profile: Profile): Promise<TargetRefreshResult> {
  const nothing: TargetRefreshResult = { refreshed: false, weightKg: null, effectiveFrom: null };

  const weightKg = profile.weight_kg === null ? null : Number(profile.weight_kg);
  if (weightKg === null) return nothing;

  const today = localDateString(profile.timezone);
  const { data, error } = await supabase.rpc("target_refresh_needed", {
    p_today: today,
    p_threshold_kg: TARGET_REFRESH_THRESHOLD_KG,
  });
  if (error) throw error;

  const parsed = refreshDecision.safeParse(Array.isArray(data) ? data[0] : data);
  if (!parsed.success) {
    throw new Error(`Unexpected shape from target_refresh_needed: ${parsed.error.message}`);
  }
  const decision = parsed.data;

  if (!decision.needed || decision.average_kg === null) return nothing;

  // Computed from the average rather than the latest reading, and the same figure is
  // stored as the basis, so the next comparison is against what this was built from.
  const computed = targetsFromProfile({ ...profile, weight_kg: decision.average_kg });
  await writeTargetRow({
    userId: profile.user_id,
    effectiveFrom: decision.next_effective_from,
    weightKg: decision.average_kg,
    computed,
  });

  return {
    refreshed: true,
    weightKg: decision.average_kg,
    effectiveFrom: decision.next_effective_from,
  };
}
