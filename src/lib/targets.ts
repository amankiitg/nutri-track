/**
 * Daily calorie and macro target calculation.
 * Pure functions, unit-tested in targets.test.ts.
 */

export const ACTIVITY_MULTIPLIERS = {
  sedentary: 1.2,
  lightly_active: 1.375,
  moderately_active: 1.55,
  very_active: 1.725,
  extra_active: 1.9,
} as const;

export type ActivityLevel = keyof typeof ACTIVITY_MULTIPLIERS;
export type Sex = "male" | "female";
export type Goal = "lose" | "maintain" | "gain";

export const ACTIVITY_LABELS: Record<ActivityLevel, { label: string; hint: string }> = {
  sedentary: { label: "Sedentary", hint: "Desk job, little or no exercise" },
  lightly_active: { label: "Lightly active", hint: "Light exercise 1–3 days a week" },
  moderately_active: { label: "Moderately active", hint: "Moderate exercise 3–5 days a week" },
  very_active: { label: "Very active", hint: "Hard exercise 6–7 days a week" },
  extra_active: { label: "Extra active", hint: "Physical job or training twice a day" },
};

export const PACE_OPTIONS = [0.25, 0.5, 0.75, 1.0] as const;
export type Pace = (typeof PACE_OPTIONS)[number];

export const KCAL_PER_KG = 7700;
export const CALORIE_FLOOR: Record<Sex, number> = { male: 1500, female: 1200 };
export const DEFAULT_PROTEIN_G_PER_KG = 1.6;
export const FAT_CALORIE_SHARE = 0.25;
export const MIN_SAFE_BMI = 18.5;

export function ageFromDob(dob: string | Date, today: Date = new Date()): number {
  const d = typeof dob === "string" ? new Date(dob + "T00:00:00") : dob;
  let age = today.getFullYear() - d.getFullYear();
  const m = today.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age -= 1;
  return age;
}

/** Mifflin-St Jeor basal metabolic rate (kcal/day). */
export function bmr(input: { sex: Sex; weightKg: number; heightCm: number; age: number }): number {
  const base = 10 * input.weightKg + 6.25 * input.heightCm - 5 * input.age;
  return input.sex === "male" ? base + 5 : base - 161;
}

export function tdee(basal: number, activity: ActivityLevel): number {
  return basal * ACTIVITY_MULTIPLIERS[activity];
}

export function bmi(weightKg: number, heightCm: number): number {
  const m = heightCm / 100;
  return weightKg / (m * m);
}

export interface TargetInput {
  sex: Sex;
  age: number;
  heightCm: number;
  weightKg: number;
  activityLevel: ActivityLevel;
  goal: Goal;
  /** kg per week; ignored when goal is maintain */
  paceKgPerWeek?: number | null;
  proteinGPerKg?: number | null;
}

export interface TargetResult {
  bmr: number;
  tdee: number;
  /** Signed daily kcal adjustment applied before the floor (negative for lose). */
  adjustment: number;
  requestedPace: number;
  /** Pace actually achievable after the floor (kg/week). */
  effectivePace: number;
  floorApplied: boolean;
  floor: number;
  calories: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
}

export function computeTargets(input: TargetInput): TargetResult {
  const basal = bmr(input);
  const maintenance = tdee(basal, input.activityLevel);
  const requestedPace = input.goal === "maintain" ? 0 : (input.paceKgPerWeek ?? 0);
  const dailyDelta = (requestedPace * KCAL_PER_KG) / 7;
  const adjustment =
    input.goal === "lose" ? -dailyDelta : input.goal === "gain" ? dailyDelta : 0;

  const floor = CALORIE_FLOOR[input.sex];
  let rawCalories = maintenance + adjustment;
  let floorApplied = false;
  if (rawCalories < floor) {
    rawCalories = floor;
    floorApplied = true;
  }
  const calories = Math.round(rawCalories);

  let effectivePace = requestedPace;
  if (floorApplied) {
    const achievableDelta = Math.max(0, maintenance - floor);
    effectivePace = Math.round(((achievableDelta * 7) / KCAL_PER_KG) * 100) / 100;
  }

  const proteinPerKg = input.proteinGPerKg ?? DEFAULT_PROTEIN_G_PER_KG;
  const proteinG = Math.round(proteinPerKg * input.weightKg);
  const fatG = Math.round((FAT_CALORIE_SHARE * calories) / 9);
  const carbsG = Math.max(0, Math.round((calories - proteinG * 4 - fatG * 9) / 4));

  return {
    bmr: basal,
    tdee: maintenance,
    adjustment,
    requestedPace,
    effectivePace,
    floorApplied,
    floor,
    calories,
    proteinG,
    fatG,
    carbsG,
  };
}

/** Date the user is projected to reach the target weight at the given pace, or null when not applicable. */
export function projectedTargetDate(
  currentKg: number,
  targetKg: number,
  paceKgPerWeek: number,
  from: Date = new Date(),
): Date | null {
  if (!paceKgPerWeek || paceKgPerWeek <= 0) return null;
  const diff = Math.abs(currentKg - targetKg);
  if (diff === 0) return from;
  const weeks = diff / paceKgPerWeek;
  const d = new Date(from);
  d.setDate(d.getDate() + Math.ceil(weeks * 7));
  return d;
}

/** Minimum weight (kg) that keeps BMI at or above the safe threshold. */
export function minSafeWeightKg(heightCm: number): number {
  const m = heightCm / 100;
  return MIN_SAFE_BMI * m * m;
}
