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
  MIN_SAFE_BMI,
  PACE_OPTIONS,
  ageFromDob,
  bmi,
  minSafeWeightKg,
  targetProximity,
  type ActivityLevel,
  type Goal,
  type Pace,
  type Sex,
  type TargetResult,
} from "./targets";
import { targetsFromProfile, type Profile, type ProfileInsert } from "./profile";
import { displayValue, wrongUnit, wrongUnitSentence, type UnitSystem } from "./units";

export const MIN_AGE = 13;
export const MAX_AGE = 100;

/**
 * Typo guards rather than physiological judgements: nobody is 40 cm tall or weighs 500 kg, so a
 * value outside these is a slip rather than a person.
 */
export const HEIGHT_MIN_CM = 100;
export const HEIGHT_MAX_CM = 250;
export const WEIGHT_MIN_KG = 30;
export const WEIGHT_MAX_KG = 400;

/** The floor's own message, for the case where the digits cannot be a unit mix-up. */
export const BMI_MESSAGE =
  `That target is below a BMI of ${MIN_SAFE_BMI}. ` +
  "Please pick a higher target or talk to a doctor first.";

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
  /**
   * Null until the person chooses. There is no default: the BMR formula needs a body, and picking
   * one for somebody is a decision about them that they did not make.
   */
  sex: Sex | null;
  /** Always centimetres, whatever the display units are. */
  height_cm: number | null;
  /** Always kilograms, whatever the display units are. */
  weight_kg: number | null;
  units: UnitSystem;
  activity_level: ActivityLevel;
  /** Null until the person chooses, for the same reason as `sex`. */
  goal: Goal | null;
  target_weight_kg: number | null;
  pace_kg_per_week: Pace;
  protein_g_per_kg: number;
  dietary_tags: string[];
  timezone: string;
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

/**
 * Which unit system a new profile starts on, from the device alone.
 *
 * A US time zone or an en-US page means imperial, everything else metric. The zones are an allow
 * list rather than "America/ except…": America/ also holds Toronto, São Paulo, Mexico City and
 * Bogotá, and guessing imperial for those is wrong in a way the person then has to notice and undo.
 */
const US_ZONE_PREFIXES = [
  "US/",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Detroit",
  "America/Boise",
  "America/Juneau",
  "America/Sitka",
  "America/Nome",
  "America/Adak",
  "America/Menominee",
  "America/Indiana/",
  "America/Kentucky/",
  "America/North_Dakota/",
  "America/Puerto_Rico",
  "America/Virgin",
  "Pacific/Honolulu",
  "Pacific/Guam",
  "Pacific/Saipan",
  "Pacific/Pago_Pago",
  "Pacific/Midway",
];

export function defaultUnits(timeZone: string, language: string): UnitSystem {
  if (language.toLowerCase().startsWith("en-us")) return "imperial";
  const imperial = US_ZONE_PREFIXES.some((prefix) => timeZone.startsWith(prefix));
  return imperial ? "imperial" : "metric";
}

/** The device's own language, or nothing where there is no device (a server render). */
export function detectLanguage(): string {
  return typeof navigator === "undefined" ? "" : navigator.language;
}

export const DEFAULT_ONBOARDING_FORM: OnboardingForm = {
  display_name: "",
  dob: "",
  // No default sex and no default goal: both are choices, and the step asks for them.
  sex: null,
  height_cm: null,
  weight_kg: null,
  units: "metric",
  activity_level: "moderately_active",
  goal: null,
  target_weight_kg: null,
  pace_kg_per_week: 0.5,
  protein_g_per_kg: DEFAULT_PROTEIN_G_PER_KG,
  dietary_tags: [],
  timezone: detectTimeZone(),
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Said where a choice the step asks for has not been made. */
export const CHOOSE_ONE = "Please choose one.";

/**
 * The target a goal cannot reach, in the words of the goal the person chose.
 *
 * Checked in kilograms, after any unit conversion: the boxes hold feet, pounds or kilos, and this
 * question is about the body rather than about the field.
 *
 * Only a target on the wrong side *by more than a kilogram* is a mistake. Inside that kilogram the
 * person is at their target, which is a different sentence and belongs to the screens that know
 * their weight has moved (Settings and Today) rather than to onboarding. Both messages used to fire
 * on the same numbers; distance is what decides which one is true.
 */
export function targetDirectionMessage(value: {
  goal: Goal | null;
  weight_kg: number | null;
  target_weight_kg: number | null;
}): string | null {
  if (targetProximity(value.goal, value.weight_kg, value.target_weight_kg) !== "wrong_side") {
    return null;
  }
  // Narrowed by the proximity check above, which returns null unless both weights are present.
  const { goal, weight_kg: weight, target_weight_kg: target } = value;
  if (goal === null || weight === null || target === null) return null;

  if (goal === "lose") {
    return "Your target is above your current weight. Choose Gain weight, or lower the target.";
  }
  return "Your target is below your current weight. Choose Lose weight, or raise the target.";
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

/**
 * The shape of a choice, without the rule that it must be made.
 *
 * Used by the form, which must accept a choice not yet made and still refuse to save it, and by the
 * draft, which has to hold exactly that state without complaint.
 */
function choiceShape<T extends string>(options: readonly T[]) {
  return z.custom<T | null>((value) => value === null || options.includes(value as T), {
    message: CHOOSE_ONE,
  });
}

function choiceSchema<T extends string>(options: readonly T[]) {
  return choiceShape(options).refine((value) => value !== null, { message: CHOOSE_ONE });
}

const formShape = {
  display_name: z.string().trim().min(1, "Please add a name.").max(60, "That name is a bit long."),
  dob: z.string().regex(ISO_DATE, "Please add your date of birth."),
  sex: choiceSchema(SEX_OPTIONS),
  // The ranges are checked after parsing rather than here, because the wording depends on the
  // unit system the user picked and a field's own message cannot see its siblings.
  height_cm: z.number({ invalid_type_error: "Please add your height." }),
  weight_kg: z.number({ invalid_type_error: "Please add your weight." }),
  units: z.enum(["metric", "imperial"]),
  activity_level: activityLevelSchema,
  goal: choiceSchema(GOAL_OPTIONS),
  target_weight_kg: z.number({ invalid_type_error: "Please add your target weight." }).nullable(),
  pace_kg_per_week: paceSchema,
  protein_g_per_kg: z
    .number({ invalid_type_error: "Please add a protein target." })
    .min(1.2, "Protein must be at least 1.2 g per kg.")
    .max(2.2, "Protein must be at most 2.2 g per kg."),
  dietary_tags: z.array(z.string()),
  timezone: z.string().min(1, "Please pick your time zone."),
};

export const onboardingBaseSchema = z.object(formShape);

type BaseForm = z.infer<typeof onboardingBaseSchema>;

function addAgeIssue(dob: string, ctx: z.RefinementCtx): void {
  const age = ageFromDob(dob);
  if (Number.isNaN(age) || age < MIN_AGE || age > MAX_AGE) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dob"],
      message: `You must be between ${MIN_AGE} and ${MAX_AGE} to use NutriTrack.`,
    });
  }
}

type HeightFields = Pick<BaseForm, "height_cm" | "units">;
type WeightFields = Pick<BaseForm, "weight_kg" | "units">;

/**
 * Height out of range, with the likelier explanation first when the digits allow one.
 *
 * The range exists to catch slips, and by far the commonest slip is the wrong unit: with the
 * field in centimetres, somebody who thinks in inches types 65. "That height looks too short"
 * on its own sends them hunting for a mistake in the number rather than in the unit select.
 */
export function heightMessage(cm: number, units: UnitSystem): string {
  const symptom =
    cm < HEIGHT_MIN_CM ? "That height looks too short." : "That height looks too tall.";
  const mixUp =
    units === "metric"
      ? wrongUnit(cm, units, "length", (base) => base >= HEIGHT_MIN_CM && base <= HEIGHT_MAX_CM)
      : null;
  return mixUp === null ? symptom : `${symptom} ${wrongUnitSentence(mixUp)}`;
}

/** Weight out of range. Same treatment: with pounds selected, a kilogram number reads ~half. */
export function weightMessage(kg: number, units: UnitSystem): string {
  const symptom = kg < WEIGHT_MIN_KG ? "That weight looks too low." : "That weight looks too high.";
  const mixUp = wrongUnit(
    displayValue(kg, units, "mass"),
    units,
    "mass",
    (base) => base >= WEIGHT_MIN_KG && base <= WEIGHT_MAX_KG,
  );
  return mixUp === null ? symptom : `${symptom} ${wrongUnitSentence(mixUp)}`;
}

/**
 * A target under the BMI floor, which is more often a unit mistake than an unsafe goal.
 *
 * With pounds selected, a number meant in kilograms comes out at roughly half, which lands well
 * under the floor and reads as "your goal is dangerous" to somebody whose only mistake was the
 * unit select. So the unit reading goes first and the safety point second. When the digits
 * cannot be a mix-up -- 40 kg at 165 cm is not 40 of anything else -- the plain message is the
 * honest one, and speculating about units would be noise.
 */
export function targetWeightMessage(targetKg: number, heightCm: number, units: UnitSystem): string {
  const floor = minSafeWeightKg(heightCm);
  const mixUp = wrongUnit(
    displayValue(targetKg, units, "mass"),
    units,
    "mass",
    (base) => base >= floor,
  );
  if (mixUp === null) return BMI_MESSAGE;
  return (
    `That target looks very low for your height. ${wrongUnitSentence(mixUp)} ` +
    `Otherwise it is a BMI of ${bmi(targetKg, heightCm).toFixed(1)}, below the ${MIN_SAFE_BMI} ` +
    "floor — please pick a higher target or talk to a doctor first."
  );
}

function addHeightIssue(value: HeightFields, ctx: z.RefinementCtx): void {
  const cm = value.height_cm;
  if (!Number.isFinite(cm)) return; // the type error is already reported
  if (cm >= HEIGHT_MIN_CM && cm <= HEIGHT_MAX_CM) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["height_cm"],
    message: heightMessage(cm, value.units),
  });
}

function addWeightIssue(value: WeightFields, ctx: z.RefinementCtx): void {
  const kg = value.weight_kg;
  if (!Number.isFinite(kg)) return;
  if (kg >= WEIGHT_MIN_KG && kg <= WEIGHT_MAX_KG) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["weight_kg"],
    message: weightMessage(kg, value.units),
  });
}

function addTargetWeightIssue(value: BaseForm, ctx: z.RefinementCtx): void {
  // Neither a target nor a direction is asked for before a goal is chosen: the target box is not on
  // screen then, so a message about it would have nowhere to appear.
  if (value.goal === null || value.goal === "maintain") return;
  if (value.target_weight_kg == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target_weight_kg"],
      message: "Please add your target weight.",
    });
    return;
  }
  const direction = targetDirectionMessage(value);
  if (direction !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["target_weight_kg"], message: direction });
    return;
  }
  // The shape already reported a missing height; skip the BMI comparison then.
  if (!Number.isFinite(value.height_cm)) return;
  if (value.target_weight_kg < minSafeWeightKg(value.height_cm)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target_weight_kg"],
      message: targetWeightMessage(value.target_weight_kg, value.height_cm, value.units),
    });
  }
}

/** Whole-form validation, run immediately before the write to the database. */
export const onboardingSchema = onboardingBaseSchema.superRefine((value, ctx) => {
  addAgeIssue(value.dob, ctx);
  addHeightIssue(value, ctx);
  addWeightIssue(value, ctx);
  addTargetWeightIssue(value, ctx);
});

const aboutStepSchema = onboardingBaseSchema
  .pick({ display_name: true, dob: true, sex: true })
  .superRefine((value, ctx) => addAgeIssue(value.dob, ctx));

const bodyStepSchema = onboardingBaseSchema
  .pick({ height_cm: true, weight_kg: true, units: true })
  .superRefine((value, ctx) => {
    addHeightIssue(value, ctx);
    addWeightIssue(value, ctx);
  });

const activityStepSchema = onboardingBaseSchema.pick({ activity_level: true });

const goalStepSchema = onboardingBaseSchema
  .pick({ goal: true, target_weight_kg: true, pace_kg_per_week: true })
  .superRefine((value, ctx) => {
    if (value.goal !== null && value.goal !== "maintain" && value.target_weight_kg == null) {
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
  if (form.goal === null || form.goal === "maintain") return {};
  if (form.target_weight_kg == null || form.height_cm == null) return {};
  // The direction first: a target on the wrong side of the current weight is the likelier slip,
  // and telling somebody about a BMI floor when they meant to lose weight is answering a question
  // they did not ask.
  const direction = targetDirectionMessage(form);
  if (direction !== null) return { target_weight_kg: direction };
  if (form.target_weight_kg < minSafeWeightKg(form.height_cm)) {
    return {
      target_weight_kg: targetWeightMessage(form.target_weight_kg, form.height_cm, form.units),
    };
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

/**
 * Said on the goal step when the target is a rounding error away from the current weight.
 *
 * Onboarding asks for a target the app can walk to. A target half a kilogram away is either a
 * typo or a wish to stay put, and the second one has its own answer — Maintain — so the step asks
 * for a real one. Settings does not ask: somebody who has arrived at their target keeps the goal
 * they set, and the at-target notice is what that screen says instead.
 */
export const TARGET_TOO_CLOSE =
  "That's within a kilogram of your current weight. Choose Maintain, or set a target further away.";

/** The message for a target inside the tolerance, or null when it is far enough away. */
export function targetTooCloseMessage(value: {
  goal: Goal | null;
  weight_kg: number | null;
  target_weight_kg: number | null;
}): string | null {
  return targetProximity(value.goal, value.weight_kg, value.target_weight_kg) === "at_target"
    ? TARGET_TOO_CLOSE
    : null;
}

export interface ValidateStepOptions {
  /**
   * Whether this caller asks for a target worth walking to.
   *
   * The onboarding wizard says yes, which is the difference between the two screens that share
   * these fields: Settings accepts a target it can only describe as already reached.
   */
  requireDistance?: boolean;
}

export function validateStep(
  step: OnboardingStep,
  form: OnboardingForm,
  options: ValidateStepOptions = {},
): FieldErrors {
  if (step === "review") return {};
  const errors = STEP_VALIDATORS[step](form);
  // The direction error speaks first when it applies: it is about the target being on the wrong
  // side, which is a different mistake from one that is simply too near.
  if (step === "goal" && options.requireDistance && errors.target_weight_kg === undefined) {
    const close = targetTooCloseMessage(form);
    if (close !== null) errors.target_weight_kg = close;
  }
  return errors;
}

/**
 * The first step a validator still refuses, with the messages that step should show.
 *
 * The step validators are the whole-form schema split by step, so walking them in order is the
 * full-form check with one extra fact: *where* to send somebody. A draft written by an older run
 * can hold answers a rule has since learned to refuse, and the step it was saved on is not
 * necessarily the step that needs fixing.
 *
 * `null` means every answer holds and the form is ready to save.
 */
export function firstInvalidStep(
  form: OnboardingForm,
  options: ValidateStepOptions = {},
): { step: OnboardingStep; errors: FieldErrors } | null {
  for (const step of ONBOARDING_STEPS) {
    if (step === "review") continue;
    const errors = validateStep(step, form, options);
    if (Object.keys(errors).length > 0) return { step, errors };
  }
  return null;
}

/** Computed targets for the review screen, or null while the form is incomplete. */
export function computeTargetsFromForm(form: OnboardingForm): TargetResult | null {
  if (form.height_cm == null || form.weight_kg == null || !ISO_DATE.test(form.dob)) return null;
  if (form.sex === null || form.goal === null) return null;
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
  };
}

/** Maps the validated form onto the row written to `profiles`. */
export function toProfileInsert(form: OnboardingForm, userId: string): ProfileInsert {
  if (form.height_cm == null || form.weight_kg == null) {
    throw new Error("Cannot build a profile from an incomplete form.");
  }
  if (form.sex === null || form.goal === null) {
    throw new Error("Cannot build a profile without a sex and a goal.");
  }
  const goal = form.goal;
  return {
    user_id: userId,
    display_name: form.display_name.trim(),
    dob: form.dob,
    sex: form.sex,
    height_cm: form.height_cm,
    weight_kg: form.weight_kg,
    activity_level: form.activity_level,
    goal,
    target_weight_kg: goal === "maintain" ? null : form.target_weight_kg,
    pace_kg_per_week: goal === "maintain" ? null : form.pace_kg_per_week,
    protein_g_per_kg: form.protein_g_per_kg,
    units: form.units,
    timezone: form.timezone,
    dietary_tags: form.dietary_tags,
  };
}

/* ------------------------------------------------------------------ */
/* Draft persistence: a refresh mid-wizard must not lose the answers.  */
/* ------------------------------------------------------------------ */

const DRAFT_KEY = "nutritrack:onboarding:draft:v1";

/**
 * What a draft may hold: a form part-way through being filled.
 *
 * Every key is optional, and the five fields that can be legitimately incomplete while somebody is
 * typing are accepted as they stand — an empty name, a blank date of birth, a height or weight box
 * not yet filled, a choice not yet made. The field rules run when the draft is *restored*
 * (`firstInvalidStep`), which is where a refusal belongs; applying them here meant a draft written
 * on the very first screen failed to parse and was silently thrown away, and the person restarted
 * from nothing. Every other field comes from a picker or a slider and cannot hold an interim value.
 */
const draftFormSchema = z
  .object({
    ...formShape,
    display_name: z.string(),
    dob: z.string(),
    sex: choiceShape(SEX_OPTIONS),
    height_cm: z.number().nullable(),
    weight_kg: z.number().nullable(),
    goal: choiceShape(GOAL_OPTIONS),
  })
  .partial();

const draftSchema = z.object({
  step: z.enum(ONBOARDING_STEPS),
  form: draftFormSchema,
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
