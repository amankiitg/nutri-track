/**
 * Onboarding form state, validation and (de)serialisation.
 *
 * No target math lives here: every calculation is delegated to
 * `computeTargets` / `targetsFromProfile` in the existing, unit-tested
 * `targets.ts` and `profile.ts`.
 */
import { z } from "zod";
import {
  ACTIVITY_MULTIPLIERS,
  DEFAULT_PROTEIN_G_PER_KG,
  PACE_OPTIONS,
  ageFromDob,
  minSafeWeightKg,
  type ActivityLevel,
  type Goal,
  type Pace,
  type Sex,
  type TargetResult,
} from "./targets";
import { targetsFromProfile, type Profile, type ProfileInsert } from "./profile";
import type { UnitSystem } from "./units";

export const MIN_AGE = 13;
export const MAX_AGE = 100;

export const BMI_MESSAGE =
  "That target is below a BMI of 18.5. Please pick a higher target or talk to a doctor first.";

export const ONBOARDING_STEPS = [
  "about",
  "body",
  "activity",
  "goal",
  "preferences",
  "review",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const STEP_TITLES: Record<OnboardingStep, string> = {
  about: "About you",
  body: "Your body",
  activity: "Activity level",
  goal: "Your goal",
  preferences: "Preferences",
  review: "Review",
};

export const SEX_OPTIONS = ["female", "male"] as const satisfies readonly Sex[];
export const GOAL_OPTIONS = ["lose", "maintain", "gain"] as const satisfies readonly Goal[];

/** Every activity level, derived from the multiplier table so the two cannot drift. */
export const ACTIVITY_LEVELS = Object.keys(ACTIVITY_MULTIPLIERS) as ActivityLevel[];

export const GOAL_COPY: Record<Goal, { title: string; description: string }> = {
  lose: {
    title: "Lose weight",
    description: "Eat below maintenance to lose at your chosen pace.",
  },
  maintain: {
    title: "Maintain",
    description: "Eat around maintenance to hold your current weight.",
  },
  gain: {
    title: "Gain weight",
    description: "Eat above maintenance to gain at your chosen pace.",
  },
};

/** Formats a date for display. */
export function toLocaleDate(date: Date): string {
  return date.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

export interface OnboardingForm {
  display_name: string;
  /** ISO `YYYY-MM-DD`. */
  dob: string;
  sex: Sex;
  /** Always centimetres, whatever the display units are. */
  height_cm: number | null;
  /** Always kilograms, whatever the display units are. */
  weight_kg: number | null;
  units: UnitSystem;
  activity_level: ActivityLevel;
  goal: Goal;
  target_weight_kg: number | null;
  pace_kg_per_week: Pace;
  protein_g_per_kg: number;
  dietary_tags: string[];
  timezone: string;
  /** `HH:MM`, or an empty string for "no reminder". */
  reminder_time: string;
}

export type FieldErrors = Partial<Record<keyof OnboardingForm, string>>;

export function detectTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Full IANA list when the runtime can provide it, otherwise just the device zone. */
export function timeZoneOptions(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  try {
    const zones = intl.supportedValuesOf?.("timeZone");
    if (zones && zones.length > 0) {
      const detected = detectTimeZone();
      return zones.includes(detected) ? zones : [detected, ...zones];
    }
  } catch {
    // Fall through to the minimal list.
  }
  return [detectTimeZone(), "UTC"];
}

export const DEFAULT_ONBOARDING_FORM: OnboardingForm = {
  display_name: "",
  dob: "",
  sex: "female",
  height_cm: null,
  weight_kg: null,
  units: "metric",
  activity_level: "moderately_active",
  goal: "lose",
  target_weight_kg: null,
  pace_kg_per_week: 0.5,
  protein_g_per_kg: DEFAULT_PROTEIN_G_PER_KG,
  dietary_tags: [],
  timezone: detectTimeZone(),
  reminder_time: "",
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A time of day, with seconds optional.
 *
 * Seconds are optional because `profiles.reminder_time` is `time without time zone` and
 * PostgREST serialises that as `20:00:00`. Demanding `HH:MM` meant the app refused a
 * value it had written itself: a reminder saved once came back in a form the validator
 * rejected, so Settings loaded already invalid and Save was refused with the blame on a
 * field nobody had touched.
 *
 * `normalizeTimeOfDay` is what actually makes the two agree; accepting seconds here is
 * the belt to that pair of braces, for a value that reaches validation without coming
 * through `formFromProfile`.
 */
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/**
 * A time in the one form the rest of this module uses: `HH:MM`.
 *
 * Anything unrecognised is returned trimmed rather than coerced, so the validator still
 * gets to complain about it instead of a bad value being quietly turned into "no
 * reminder" — a reminder silently deleted is worse than one refused.
 */
export function normalizeTimeOfDay(value: string): string {
  const trimmed = value.trim();
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(trimmed);
  if (match === null) return trimmed;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return trimmed;

  return `${String(hours).padStart(2, "0")}:${match[2]}`;
}

const activityLevelSchema = z.custom<ActivityLevel>(
  (value) =>
    typeof value === "string" && Object.prototype.hasOwnProperty.call(ACTIVITY_MULTIPLIERS, value),
  { message: "Please choose an activity level." },
);

const paceSchema = z.custom<Pace>(
  (value) => typeof value === "number" && (PACE_OPTIONS as readonly number[]).includes(value),
  { message: "Choose a pace of 0.25, 0.5, 0.75 or 1 kg per week." },
);

const formShape = {
  display_name: z.string().trim().min(1, "Please add a name.").max(60, "That name is a bit long."),
  dob: z.string().regex(ISO_DATE, "Please add your date of birth."),
  sex: z.enum(SEX_OPTIONS),
  height_cm: z
    .number({ invalid_type_error: "Please add your height." })
    .min(100, "That height looks too short.")
    .max(250, "That height looks too tall."),
  weight_kg: z
    .number({ invalid_type_error: "Please add your weight." })
    .min(30, "That weight looks too low.")
    .max(400, "That weight looks too high."),
  units: z.enum(["metric", "imperial"]),
  activity_level: activityLevelSchema,
  goal: z.enum(GOAL_OPTIONS),
  target_weight_kg: z.number({ invalid_type_error: "Please add your target weight." }).nullable(),
  pace_kg_per_week: paceSchema,
  protein_g_per_kg: z
    .number({ invalid_type_error: "Please add a protein target." })
    .min(1.2, "Protein must be at least 1.2 g per kg.")
    .max(2.2, "Protein must be at most 2.2 g per kg."),
  dietary_tags: z.array(z.string()),
  timezone: z.string().min(1, "Please pick your time zone."),
  reminder_time: z.union([z.literal(""), z.string().regex(TIME_OF_DAY, "Use a time like 19:30.")]),
};

export const onboardingBaseSchema = z.object(formShape);

type BaseForm = z.infer<typeof onboardingBaseSchema>;

function addAgeIssue(dob: string, ctx: z.RefinementCtx): void {
  const age = ageFromDob(dob);
  if (Number.isNaN(age) || age < MIN_AGE || age > MAX_AGE) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dob"],
      message: `You must be between ${MIN_AGE} and ${MAX_AGE} years old.`,
    });
  }
}

function addTargetWeightIssue(value: BaseForm, ctx: z.RefinementCtx): void {
  if (value.goal === "maintain") return;
  if (value.target_weight_kg == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target_weight_kg"],
      message: "Please add your target weight.",
    });
    return;
  }
  // The shape already reported a missing height; skip the BMI comparison then.
  if (!Number.isFinite(value.height_cm)) return;
  if (value.target_weight_kg < minSafeWeightKg(value.height_cm)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target_weight_kg"],
      message: BMI_MESSAGE,
    });
  }
}

/** Whole-form validation, run immediately before the write to the database. */
export const onboardingSchema = onboardingBaseSchema.superRefine((value, ctx) => {
  addAgeIssue(value.dob, ctx);
  addTargetWeightIssue(value, ctx);
});

const aboutStepSchema = onboardingBaseSchema
  .pick({ display_name: true, dob: true, sex: true })
  .superRefine((value, ctx) => addAgeIssue(value.dob, ctx));

const bodyStepSchema = onboardingBaseSchema.pick({ height_cm: true, weight_kg: true });

const activityStepSchema = onboardingBaseSchema.pick({ activity_level: true });

const goalStepSchema = onboardingBaseSchema
  .pick({ goal: true, target_weight_kg: true, pace_kg_per_week: true })
  .superRefine((value, ctx) => {
    if (value.goal !== "maintain" && value.target_weight_kg == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target_weight_kg"],
        message: "Please add your target weight.",
      });
    }
  });

const preferencesStepSchema = onboardingBaseSchema.pick({
  protein_g_per_kg: true,
  dietary_tags: true,
  timezone: true,
  reminder_time: true,
});

function collect(result: z.SafeParseReturnType<unknown, unknown>): FieldErrors {
  if (result.success) return {};
  return zodFieldErrors(result.error);
}

/** Flattens a Zod error into one message per form field. */
export function zodFieldErrors(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !(key in errors)) {
      errors[key as keyof OnboardingForm] = issue.message;
    }
  }
  return errors;
}

/** Whole-form validation, for callers that are not the step wizard. */
export function validateForm(form: OnboardingForm): FieldErrors {
  const parsed = onboardingSchema.safeParse(form);
  return parsed.success ? {} : zodFieldErrors(parsed.error);
}

/** BMI floor on the goal step, which needs the height captured on the body step. */
function targetWeightError(form: OnboardingForm): FieldErrors {
  if (form.goal === "maintain") return {};
  if (form.target_weight_kg == null || form.height_cm == null) return {};
  if (form.target_weight_kg < minSafeWeightKg(form.height_cm)) {
    return { target_weight_kg: BMI_MESSAGE };
  }
  return {};
}

const STEP_VALIDATORS: Record<
  Exclude<OnboardingStep, "review">,
  (form: OnboardingForm) => FieldErrors
> = {
  about: (form) => collect(aboutStepSchema.safeParse(form)),
  body: (form) => collect(bodyStepSchema.safeParse(form)),
  activity: (form) => collect(activityStepSchema.safeParse(form)),
  goal: (form) => ({ ...collect(goalStepSchema.safeParse(form)), ...targetWeightError(form) }),
  preferences: (form) => collect(preferencesStepSchema.safeParse(form)),
};

export function validateStep(step: OnboardingStep, form: OnboardingForm): FieldErrors {
  if (step === "review") return {};
  return STEP_VALIDATORS[step](form);
}

/** Computed targets for the review screen, or null while the form is incomplete. */
export function computeTargetsFromForm(form: OnboardingForm): TargetResult | null {
  if (form.height_cm == null || form.weight_kg == null || !ISO_DATE.test(form.dob)) return null;
  return targetsFromProfile({
    sex: form.sex,
    dob: form.dob,
    height_cm: form.height_cm,
    weight_kg: form.weight_kg,
    activity_level: form.activity_level,
    goal: form.goal,
    pace_kg_per_week: form.goal === "maintain" ? null : form.pace_kg_per_week,
    protein_g_per_kg: form.protein_g_per_kg,
  });
}

function paceFromDb(value: number | null): Pace {
  const match = PACE_OPTIONS.find((option) => option === value);
  return match ?? 0.5;
}

/** Rebuilds the editable form state from a stored profile row. */
export function formFromProfile(profile: Profile): OnboardingForm {
  return {
    display_name: profile.display_name,
    dob: profile.dob,
    sex: profile.sex,
    height_cm: Number(profile.height_cm),
    weight_kg: Number(profile.weight_kg),
    units: profile.units,
    activity_level: profile.activity_level,
    goal: profile.goal,
    target_weight_kg: profile.target_weight_kg == null ? null : Number(profile.target_weight_kg),
    pace_kg_per_week: paceFromDb(
      profile.pace_kg_per_week == null ? null : Number(profile.pace_kg_per_week),
    ),
    protein_g_per_kg: Number(profile.protein_g_per_kg),
    dietary_tags: profile.dietary_tags,
    timezone: profile.timezone,
    reminder_time: normalizeTimeOfDay(profile.reminder_time ?? ""),
  };
}

/** Maps the validated form onto the row written to `profiles`. */
export function toProfileInsert(form: OnboardingForm, userId: string): ProfileInsert {
  if (form.height_cm == null || form.weight_kg == null) {
    throw new Error("Cannot build a profile from an incomplete form.");
  }
  return {
    user_id: userId,
    display_name: form.display_name.trim(),
    dob: form.dob,
    sex: form.sex,
    height_cm: form.height_cm,
    weight_kg: form.weight_kg,
    activity_level: form.activity_level,
    goal: form.goal,
    target_weight_kg: form.goal === "maintain" ? null : form.target_weight_kg,
    pace_kg_per_week: form.goal === "maintain" ? null : form.pace_kg_per_week,
    protein_g_per_kg: form.protein_g_per_kg,
    units: form.units,
    timezone: form.timezone,
    reminder_time: form.reminder_time === "" ? null : normalizeTimeOfDay(form.reminder_time),
    dietary_tags: form.dietary_tags,
  };
}

/* ------------------------------------------------------------------ */
/* Draft persistence: a refresh mid-wizard must not lose the answers.  */
/* ------------------------------------------------------------------ */

const DRAFT_KEY = "nutritrack:onboarding:draft:v1";

const draftSchema = z.object({
  step: z.enum(ONBOARDING_STEPS),
  form: onboardingBaseSchema.partial(),
});

/** Partial where an explicit `undefined` is allowed (see `exactOptionalPropertyTypes`). */
type Optionalish<T> = { [K in keyof T]?: T[K] | undefined };

/** Overlays defined keys of `raw` onto `defaults`, ignoring explicit `undefined`. */
function withDefaults<T extends object>(defaults: T, raw: Optionalish<T>): T {
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    applyDefined(result, key, raw);
  }
  return result;
}

function applyDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  raw: Optionalish<T>,
): void {
  const value = raw[key];
  if (value !== undefined) target[key] = value;
}

export interface OnboardingDraft {
  step: OnboardingStep;
  form: OnboardingForm;
}

export function loadOnboardingDraft(): OnboardingDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = draftSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return {
      step: parsed.data.step,
      form: withDefaults(DEFAULT_ONBOARDING_FORM, parsed.data.form),
    };
  } catch {
    return null;
  }
}

export function saveOnboardingDraft(draft: OnboardingDraft): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // A full or disabled sessionStorage must never break onboarding.
  }
}

export function clearOnboardingDraft(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Ignore.
  }
}
