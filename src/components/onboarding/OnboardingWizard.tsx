import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ACTIVITY_LABELS, ACTIVITY_MULTIPLIERS, ageFromDob } from "@/lib/targets";
import type { ProfileInsert } from "@/lib/profile";
import { formatHeight, formatPace, formatWeight } from "@/lib/units";
import {
  DEFAULT_ONBOARDING_FORM,
  GOAL_COPY,
  ONBOARDING_STEPS,
  STEP_TITLES,
  clearOnboardingDraft,
  computeTargetsFromForm,
  loadOnboardingDraft,
  onboardingSchema,
  saveOnboardingDraft,
  toProfileInsert,
  validateStep,
  type FieldErrors,
  type OnboardingForm,
  type OnboardingStep,
} from "@/lib/onboarding";
import { AboutStep, ActivityStep, BodyStep, GoalStep, PreferencesStep } from "./steps";

export interface OnboardingWizardProps {
  userId: string;
  /** The only place a write may happen. Called exclusively from Confirm. */
  onConfirm: (profile: ProfileInsert) => Promise<unknown>;
  onSaved: () => void;
}

export function OnboardingWizard({ userId, onConfirm, onSaved }: OnboardingWizardProps) {
  const [draft] = useState(() => loadOnboardingDraft());
  const [form, setForm] = useState<OnboardingForm>(() => ({
    ...DEFAULT_ONBOARDING_FORM,
    ...(draft?.form ?? {}),
  }));
  const [stepIndex, setStepIndex] = useState(() =>
    draft ? Math.max(0, ONBOARDING_STEPS.indexOf(draft.step)) : 0,
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const step: OnboardingStep = ONBOARDING_STEPS[stepIndex] ?? "about";

  useEffect(() => {
    saveOnboardingDraft({ step, form });
  }, [step, form]);

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
    const stepErrors = validateStep(step, form);
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
    for (const candidate of ONBOARDING_STEPS) {
      const stepErrors = validateStep(candidate, form);
      if (Object.keys(stepErrors).length > 0) {
        setErrors(stepErrors);
        setStepIndex(ONBOARDING_STEPS.indexOf(candidate));
        return;
      }
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
            <ReviewSection title="About you" onEdit={() => goTo("about")}>
              <ReviewRow label="Name" value={form.display_name} />
              <ReviewRow
                label="Date of birth"
                value={`${form.dob} (age ${ageFromDob(form.dob)})`}
              />
              <ReviewRow label="Sex" value={form.sex === "female" ? "Female" : "Male"} />
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
              <ReviewRow label="Goal" value={GOAL_COPY[form.goal].title} />
              {form.goal !== "maintain" && (
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
              <ReviewRow label="Reminder" value={form.reminder_time || "None"} />
            </ReviewSection>

            {targets && (
              <section className="card-soft space-y-4 p-5">
                <h2 className="text-lg font-semibold">Your daily targets</h2>
                <p className="text-4xl font-semibold tabular-nums">
                  {targets.calories.toLocaleString("en-US")}
                  <span className="ml-2 text-base font-normal text-muted-foreground">kcal</span>
                </p>
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
