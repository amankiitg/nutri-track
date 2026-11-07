import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { BrandMark } from "@/components/app/BrandMark";
import {
  ACTIVITY_LABELS,
  ACTIVITY_MULTIPLIERS,
  ageFromDob,
  calorieExplanation,
} from "@/lib/targets";
import type { ProfileInsert } from "@/lib/profile";
import { formatHeight, formatPace, formatWeight } from "@/lib/units";
import {
  DEFAULT_ONBOARDING_FORM,
  GOAL_COPY,
  ONBOARDING_STEPS,
  STEP_TITLES,
  clearOnboardingDraft,
  computeTargetsFromForm,
  defaultUnits,
  detectLanguage,
  detectTimeZone,
  firstInvalidStep,
  loadOnboardingDraft,
  onboardingSchema,
  saveOnboardingDraft,
  toProfileInsert,
  validateStep,
  type FieldErrors,
  type OnboardingForm,
  type OnboardingStep,
} from "@/lib/onboarding";
import type { Sex } from "@/lib/targets";
import { AboutStep, ActivityStep, BodyStep, GoalStep, PreferencesStep } from "./steps";

/**
 * What every validator in this wizard is told, in one place so no call site can forget it.
 *
 * Onboarding refuses a target within a kilogram of the current weight; Settings accepts it and
 * says the person has arrived. That is the whole difference between the two callers of the same
 * fields, so it travels as an option rather than as a second rule.
 */
const ONBOARDING_ONLY = { requireDistance: true };

export interface OnboardingWizardProps {
  userId: string;
  /** The only place a write may happen. Called exclusively from Confirm. */
  onConfirm: (profile: ProfileInsert) => Promise<unknown>;
  onSaved: () => void;
}

export function OnboardingWizard({ userId, onConfirm, onSaved }: OnboardingWizardProps) {
  /**
   * Everything the draft holds starts at its default and is replaced once the browser can be asked.
   *
   * `sessionStorage` is not readable while rendering if the page is ever server-rendered: the server
   * would paint the welcome and the client would paint the draft, and React reports the two as a
   * hydration mismatch. Reading it in an effect makes the first paint the same on both sides, which
   * is why the wizard holds a loading state until that effect has run: the draft is a fact about
   * this tab, and there is nothing honest to show until it is known.
   */
  const [resumed, setResumed] = useState(false);
  const [form, setForm] = useState<OnboardingForm>(DEFAULT_ONBOARDING_FORM);
  /**
   * Whether the welcome has been dismissed. A saved draft means they were already inside, so it is
   * not shown again to somebody resuming.
   */
  const [started, setStarted] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const step: OnboardingStep = ONBOARDING_STEPS[stepIndex] ?? "about";

  useEffect(() => {
    const restored = resumeFromDraft();
    setForm(restored.form);
    setStarted(restored.started);
    setStepIndex(restored.stepIndex);
    setErrors(restored.errors);
    setResumed(true);
  }, []);

  useEffect(() => {
    // Nothing is written until the draft has been read and they have started, so saving cannot
    // overwrite the stored answers with the defaults this component renders first.
    if (!resumed || !started) return;
    saveOnboardingDraft({ step, form });
  }, [resumed, started, step, form]);

  function setField<K extends keyof OnboardingForm>(key: K, value: OnboardingForm[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => {
      if (!previous[key]) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }

  function next() {
    const stepErrors = validateStep(step, form, ONBOARDING_ONLY);
    if (Object.keys(stepErrors).length > 0) {
      setErrors(stepErrors);
      return;
    }
    setErrors({});
    setStepIndex((index) => Math.min(index + 1, ONBOARDING_STEPS.length - 1));
  }

  function back() {
    setErrors({});
    setStepIndex((index) => Math.max(index - 1, 0));
  }

  function goTo(target: OnboardingStep) {
    setErrors({});
    setStepIndex(ONBOARDING_STEPS.indexOf(target));
  }

  async function confirm() {
    setSaveError(null);

    // Re-check every step; jump back to the first one that is incomplete.
    const invalid = firstInvalidStep(form, ONBOARDING_ONLY);
    if (invalid !== null) {
      setErrors(invalid.errors);
      setStepIndex(ONBOARDING_STEPS.indexOf(invalid.step));
      return;
    }

    const parsed = onboardingSchema.safeParse(form);
    if (!parsed.success) {
      setSaveError("Please check the highlighted fields and try again.");
      return;
    }

    setSaving(true);
    try {
      await onConfirm(toProfileInsert(form, userId));
      clearOnboardingDraft();
      onSaved();
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "Could not save your profile. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  const targets = computeTargetsFromForm(form);

  /**
   * Only Review asks this, and it must be able to refuse.
   *
   * One problem at a time, in step order: that is the order they get fixed in, and the same
   * problem `confirm` would bounce to.
   */
  const reviewProblem = step === "review" ? firstInvalidStep(form, ONBOARDING_ONLY) : null;

  if (!resumed) return <WizardLoading />;
  if (!started) return <Welcome onStart={() => setStarted(true)} />;

  return (
    <div className="space-y-6 pb-6">
      <header className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Step {stepIndex + 1} of {ONBOARDING_STEPS.length}
        </p>
        <Progress
          value={((stepIndex + 1) / ONBOARDING_STEPS.length) * 100}
          aria-label="Onboarding progress"
        />
        <h1 className="text-3xl font-semibold">{STEP_TITLES[step]}</h1>
      </header>

      <div className="space-y-5">
        {step === "about" && <AboutStep form={form} errors={errors} setField={setField} />}

        {step === "body" && <BodyStep form={form} errors={errors} setField={setField} />}

        {step === "activity" && <ActivityStep form={form} errors={errors} setField={setField} />}

        {step === "goal" && <GoalStep form={form} errors={errors} setField={setField} />}

        {step === "preferences" && (
          <PreferencesStep form={form} errors={errors} setField={setField} />
        )}

        {step === "review" && (
          <>
            {reviewProblem !== null && (
              <ReviewProblems
                step={reviewProblem.step}
                message={Object.values(reviewProblem.errors)[0] ?? "Please check this step."}
                onEdit={() => goTo(reviewProblem.step)}
              />
            )}

            <ReviewSection title="About you" onEdit={() => goTo("about")}>
              <ReviewRow label="Name" value={form.display_name} />
              <ReviewRow
                label="Date of birth"
                value={`${form.dob} (age ${ageFromDob(form.dob)})`}
              />
              <ReviewRow label="Sex" value={sexLabel(form.sex)} />
            </ReviewSection>

            <ReviewSection title="Body" onEdit={() => goTo("body")}>
              <ReviewRow label="Height" value={formatHeight(form.height_cm ?? 0, form.units)} />
              <ReviewRow label="Weight" value={formatWeight(form.weight_kg ?? 0, form.units)} />
            </ReviewSection>

            <ReviewSection title="Activity" onEdit={() => goTo("activity")}>
              <ReviewRow
                label="Activity level"
                value={`${ACTIVITY_LABELS[form.activity_level].label} (×${ACTIVITY_MULTIPLIERS[form.activity_level]})`}
              />
            </ReviewSection>

            <ReviewSection title="Goal" onEdit={() => goTo("goal")}>
              <ReviewRow
                label="Goal"
                value={form.goal === null ? "Not chosen" : GOAL_COPY[form.goal].title}
              />
              {form.goal !== null && form.goal !== "maintain" && (
                <>
                  <ReviewRow
                    label="Target weight"
                    value={formatWeight(form.target_weight_kg ?? 0, form.units)}
                  />
                  <ReviewRow label="Pace" value={formatPace(form.pace_kg_per_week, form.units)} />
                </>
              )}
            </ReviewSection>

            <ReviewSection title="Preferences" onEdit={() => goTo("preferences")}>
              <ReviewRow label="Protein" value={`${form.protein_g_per_kg.toFixed(1)} g/kg`} />
              <ReviewRow
                label="Dietary tags"
                value={form.dietary_tags.length > 0 ? form.dietary_tags.join(", ") : "None"}
              />
              <ReviewRow label="Time zone" value={form.timezone} />
            </ReviewSection>

            {/* A computed target for a form that will not be saved is a number nobody gets. */}
            {reviewProblem === null && targets && (
              <section className="card-soft space-y-4 p-5">
                <h2 className="text-lg font-semibold">Your daily targets</h2>
                <p className="text-4xl font-semibold tabular-nums">
                  {targets.calories.toLocaleString("en-US")}
                  <span className="ml-2 text-base font-normal text-muted-foreground">kcal</span>
                </p>
                {form.goal !== null && (
                  <p className="text-xs text-muted-foreground">
                    {calorieExplanation(targets, form.goal, form.units)}
                  </p>
                )}
                <dl className="grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">Protein</dt>
                    <dd className="text-lg font-medium tabular-nums">{targets.proteinG} g</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Carbs</dt>
                    <dd className="text-lg font-medium tabular-nums">{targets.carbsG} g</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Fat</dt>
                    <dd className="text-lg font-medium tabular-nums">{targets.fatG} g</dd>
                  </div>
                </dl>
                {targets.floorApplied && (
                  <p className="text-sm text-amber-700">
                    Your pace was capped to keep you above the safe minimum. Effective pace:{" "}
                    {formatPace(targets.effectivePace, form.units)}.
                  </p>
                )}
              </section>
            )}
          </>
        )}
      </div>

      {saveError && (
        <p role="alert" className="text-sm text-destructive">
          {saveError}
        </p>
      )}

      <div className="flex items-center gap-3 pt-2">
        {stepIndex > 0 && (
          <Button
            type="button"
            variant="outline"
            className="h-12 rounded-full"
            onClick={back}
            disabled={saving}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back
          </Button>
        )}
        {step === "review" ? (
          <Button
            type="button"
            className="h-12 flex-1 rounded-full text-base"
            onClick={confirm}
            disabled={saving}
          >
            {saving && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            Confirm and save
          </Button>
        ) : (
          <Button type="button" className="h-12 flex-1 rounded-full text-base" onClick={next}>
            Continue
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Where a resumed wizard opens, and what it has to say about it.
 *
 * A draft is a form written by an earlier run, and the rules can have moved since. It is restored
 * exactly as it stands, then every step is validated with today's rules: if one no longer holds,
 * the person opens on that step with its message, not on Review. A draft that never had a value a
 * rule now requires is the same case, and it is the one that made this necessary — a draft saved
 * on Review, whose target weight its own goal can no longer reach.
 *
 * A sound draft opens where it was left, which is the whole point of saving one.
 */
function resumeFromDraft(): {
  form: OnboardingForm;
  started: boolean;
  stepIndex: number;
  errors: FieldErrors;
} {
  const draft = loadOnboardingDraft();
  const form: OnboardingForm = {
    ...DEFAULT_ONBOARDING_FORM,
    // The one device-derived default the form takes. The draft wins over it, because a choice
    // already made is the person's and not the browser's.
    units: defaultUnits(detectTimeZone(), detectLanguage()),
    ...draft?.form,
  };

  if (draft === null) return { form, started: false, stepIndex: 0, errors: {} };

  const invalid = firstInvalidStep(form, ONBOARDING_ONLY);
  if (invalid !== null) {
    return {
      form,
      started: true,
      stepIndex: ONBOARDING_STEPS.indexOf(invalid.step),
      errors: invalid.errors,
    };
  }

  return {
    form,
    started: true,
    stepIndex: Math.max(0, ONBOARDING_STEPS.indexOf(draft.step)),
    errors: {},
  };
}

/** The review row's wording for a choice that may not have been made. */
function sexLabel(sex: Sex | null): string {
  if (sex === "female") return "Female";
  if (sex === "male") return "Male";
  return "Not chosen";
}

/**
 * The first paint, while the draft is being read.
 *
 * Not a skeleton of the questions: which questions to draw is exactly what is not known yet. A
 * spinner in the middle of an empty column is the whole truth, and it is the same markup on the
 * server as on the client, which is what keeps hydration quiet.
 */
function WizardLoading() {
  return (
    <div
      className="flex min-h-[60dvh] items-center justify-center"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
      <span className="sr-only">Loading your answers</span>
    </div>
  );
}

/**
 * The first thing anybody sees: what this is, how long it takes, and one button.
 *
 * Outside the step machine on purpose. It asks nothing, so it has no error state, no Back, and no
 * place in the progress count.
 */
function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="flex min-h-[60dvh] flex-col justify-center gap-6 py-6">
      <BrandMark size={56} />
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold">NutriTrack</h1>
        <p className="text-muted-foreground">
          A few questions to set your daily calorie and protein targets. About a minute.
        </p>
      </div>
      <Button type="button" className="h-12 w-full rounded-full text-base" onClick={onStart}>
        Start
      </Button>
    </div>
  );
}

/**
 * What Review says instead of a summary it cannot stand behind.
 *
 * The message is the step's own, in the words that step uses, and the button goes to the step that
 * can fix it rather than to the first field on this screen.
 */
export function ReviewProblems({
  step,
  message,
  onEdit,
}: {
  step: OnboardingStep;
  message: string;
  onEdit: () => void;
}) {
  return (
    <section
      role="alert"
      className="card-soft space-y-3 border border-destructive/40 p-4 text-sm text-destructive"
    >
      <p>{message}</p>
      <Button type="button" variant="outline" size="sm" className="rounded-full" onClick={onEdit}>
        <Pencil className="size-3.5" aria-hidden="true" />
        Edit {STEP_TITLES[step]}
      </Button>
    </section>
  );
}

function ReviewSection({
  title,
  onEdit,
  children,
}: {
  title: string;
  onEdit: () => void;
  children: ReactNode;
}) {
  return (
    <section className="card-soft space-y-2 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">{title}</h2>
        <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="size-3.5" aria-hidden="true" />
          Edit
        </Button>
      </div>
      <dl className="space-y-1 text-sm">{children}</dl>
    </section>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}
