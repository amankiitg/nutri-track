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

export async function fetchCurrentTarget(userId: string): Promise<Target | null> {
  const { data, error } = await supabase
    .from("targets")
    .select("*")
    .eq("user_id", userId)
    .lte("effective_from", localDateString())
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

/**
 * Writes the profile and a fresh targets row (effective today in the user's zone).
 * A second save on the same day updates that day's row instead of duplicating it.
 */
export async function saveProfileWithTargets(profile: ProfileInsert) {
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

  const { data: existing } = await supabase
    .from("targets")
    .select("id")
    .eq("user_id", saved.user_id)
    .eq("effective_from", effectiveFrom)
    .maybeSingle();

  const query = existing
    ? supabase.from("targets").update(row).eq("id", existing.id).select().single()
    : supabase.from("targets").insert(row).select().single();
  const { data: target, error: targetError } = await query;
  if (targetError) throw targetError;

  // Seed the weight log with the starting weight (does not overwrite an existing entry).
  await supabase.from("weight_log").upsert(
    {
      user_id: saved.user_id,
      logged_on: effectiveFrom,
      weight_kg: saved.weight_kg,
      source: "manual",
    },
    { onConflict: "user_id,logged_on", ignoreDuplicates: true },
  );

  return { profile: saved, target, computed: t };
}
