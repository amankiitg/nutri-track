/**
 * Daily calorie and macro target calculation.
 * Pure functions, unit-tested in targets.test.ts.
 */
import { formatPace, type UnitSystem } from "./units";

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
  const adjustment = input.goal === "lose" ? -dailyDelta : input.goal === "gain" ? dailyDelta : 0;

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

export interface TargetExplanation {
  /** Mifflin-St Jeor, kcal/day, from the four inputs below. */
  bmr: number;
  activity: { level: ActivityLevel; label: string; multiplier: number };
  /** bmr x multiplier. */
  tdee: number;
  goal: Goal;
  /** The pace asked for, before the floor had a say. */
  requestedPace: number;
  /** Negative when losing. The daily kcal step taken off TDEE. */
  adjustment: number;
  /** tdee + adjustment, before the floor was applied. */
  beforeFloor: number;
  floor: number;
  /** True when the floor, not the pace, decided the number. */
  floorApplied: boolean;
  /** What the app actually shows. */
  calories: number;
}

/**
 * The chain that produced a target, in the order it was applied.
 *
 * A dashboard shows a number and nothing else, which makes it unauditable: a reader who expected
 * 1,900 and sees 1,500 cannot tell a stale weight from a pace they had forgotten from a floor
 * that is quietly doing the work. Every step is returned so the screen can show them, and this
 * recomputes rather than storing anything, so it cannot disagree with `computeTargets`.
 */
export function explainTarget(input: TargetInput): TargetExplanation {
  const result = computeTargets(input);
  return {
    bmr: result.bmr,
    activity: {
      level: input.activityLevel,
      label: ACTIVITY_LABELS[input.activityLevel].label,
      multiplier: ACTIVITY_MULTIPLIERS[input.activityLevel],
    },
    tdee: result.tdee,
    goal: input.goal,
    requestedPace: result.requestedPace,
    adjustment: result.adjustment,
    beforeFloor: result.tdee + result.adjustment,
    floor: result.floor,
    floorApplied: result.floorApplied,
    calories: result.calories,
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

/**
 * How near the target the current weight is, which decides which sentence can be true.
 *
 * Two messages used to fire on the same numbers: "your target is above your current weight" and
 * "you're at your target weight". They cannot both be right, and distance is what separates them.
 * One kilogram either side of the target counts as being there, or as having just passed it. The
 * kilogram is the brief's number rather than a measurement ("about 2 lb"): scales read in 0.1 lb
 * steps and a target typed in pounds comes back in kilograms, so an exact match is not something
 * that happens, and refusing a target a hundred grams above the current weight would be refusing a
 * rounding error.
 *
 * `wrong_side` therefore covers both a target typed past the weight and a target the weight has gone
 * past: with goal "lose", 77 kg aiming at 85 and 68.9 kg aiming at 70 are the same numbers seen
 * from two directions, and a form holds no history to tell them apart. Beyond a kilogram the error
 * is the honest answer for both; inside it, the two screens that know the weight has moved say the
 * person has arrived.
 *
 * `null` when the question does not apply: maintain has no destination, and a missing weight or
 * target is not a distance.
 */
export const AT_TARGET_KG = 1;

export type TargetProximity = "at_target" | "wrong_side" | "away";

/**
 * `null` when the question does not apply: maintain has no destination, and a missing weight or
 * target is not a distance.
 */
export function targetProximity(
  goal: Goal | null,
  currentKg: number | null,
  targetKg: number | null,
): TargetProximity | null {
  if (goal === null || goal === "maintain") return null;
  if (currentKg === null || targetKg === null) return null;

  // Positive means the target is on the side the goal is heading away from. A target on the right
  // side is ahead however far; one just behind is somebody who has arrived.
  const overshoot = goal === "lose" ? targetKg - currentKg : currentKg - targetKg;
  if (overshoot > AT_TARGET_KG) return "wrong_side";
  if (Math.abs(targetKg - currentKg) <= AT_TARGET_KG) return "at_target";
  return "away";
}

/**
 * The date to show for a goal, or null when there is nothing honest to show.
 *
 * This is the one place that decides, so no screen can print a date for a target that is already
 * behind the person, or for one they have arrived at within the tolerance. `projectedTargetDate`
 * on its own cannot know: it is handed a distance, and a distance has no direction.
 */
export function projectionFor(input: {
  goal: Goal;
  currentKg: number | null;
  targetKg: number | null;
  paceKgPerWeek: number | null;
  from?: Date;
}): Date | null {
  const proximity = targetProximity(input.goal, input.currentKg, input.targetKg);
  // Only a target that is ahead and worth walking to gets a date.
  if (proximity !== "away") return null;
  if (input.currentKg === null || input.targetKg === null || input.paceKgPerWeek === null) {
    return null;
  }
  return projectedTargetDate(
    input.currentKg,
    input.targetKg,
    input.paceKgPerWeek,
    input.from ?? new Date(),
  );
}

/**
 * One line under the calorie number, saying where the number came from.
 *
 * The whole sum, in the units the person chose: "Maintenance ≈ 2,398 kcal − 550 kcal for 0.5
 * kg/week". A target that appears from nowhere is the thing people ask about, and the answer is
 * three numbers they have already seen on other screens.
 */
export function calorieExplanation(
  result: Pick<TargetResult, "tdee" | "adjustment" | "requestedPace">,
  goal: Goal,
  units: UnitSystem,
): string {
  const maintenance = Math.round(result.tdee).toLocaleString("en-US");
  if (goal === "maintain" || result.adjustment === 0) {
    return `Maintenance ≈ ${maintenance} kcal, with no adjustment.`;
  }
  const step = Math.round(Math.abs(result.adjustment)).toLocaleString("en-US");
  const sign = result.adjustment < 0 ? "\u2212" : "+";
  return `Maintenance ≈ ${maintenance} kcal ${sign} ${step} kcal for ${formatPace(result.requestedPace, units)}`;
}

/** Minimum weight (kg) that keeps BMI at or above the safe threshold. */
export function minSafeWeightKg(heightCm: number): number {
  const m = heightCm / 100;
  return MIN_SAFE_BMI * m * m;
}
