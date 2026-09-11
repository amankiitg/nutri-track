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
  const row = {
    user_id: saved.user_id,
    effective_from: effectiveFrom,
    calories: t.calories,
    protein_g: t.proteinG,
    carbs_g: t.carbsG,
    fat_g: t.fatG,
  };

  const { data: target, error: targetError } = await supabase
    .from("targets")
    .upsert(row, { onConflict: "user_id,effective_from" })
    .select()
    .single();
  if (targetError) throw targetError;

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
