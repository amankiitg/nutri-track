import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import {
  ACTIVITY_LABELS,
  ACTIVITY_MULTIPLIERS,
  PACE_OPTIONS,
  ageFromDob,
  projectedTargetDate,
  type ActivityLevel,
  type Goal,
} from "@/lib/targets";
import { DIETARY_TAG_OPTIONS, type ProfileInsert } from "@/lib/profile";
import { formatHeight, formatPace, formatWeight } from "@/lib/units";
import {
  DEFAULT_ONBOARDING_FORM,
  GOAL_OPTIONS,
  MAX_AGE,
  MIN_AGE,
  ONBOARDING_STEPS,
  SEX_OPTIONS,
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
import { ChoiceCard, ChipGroup, HeightField, TextField, WeightField } from "./fields";
import { TimeZoneSelect } from "./TimeZoneSelect";

const ACTIVITY_LEVELS = Object.keys(ACTIVITY_MULTIPLIERS) as ActivityLevel[];

const GOAL_COPY: Record<Goal, { title: string; description: string }> = {
  lose: { title: "Lose weight", description: "Eat below maintenance to lose at your chosen pace." },
  maintain: {
    title: "Maintain",
    description: "Eat around maintenance to hold your current weight.",
  },
  gain: { title: "Gain weight", description: "Eat above maintenance to gain at your chosen pace." },
};

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

  const projectedOn =
    form.goal !== "maintain" && form.target_weight_kg != null && form.weight_kg != null
      ? projectedTargetDate(form.weight_kg, form.target_weight_kg, form.pace_kg_per_week)
      : null;

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
        {step === "about" && (
          <>
            <TextField
              id="display_name"
              label="Display name"
              value={form.display_name}
              onChange={(value) => setField("display_name", value)}
              error={errors.display_name}
              autoComplete="name"
              placeholder="Ada"
            />
            <TextField
              id="dob"
              label="Date of birth"
              type="date"
              value={form.dob}
              onChange={(value) => setField("dob", value)}
              error={errors.dob}
              max={new Date().toISOString().slice(0, 10)}
              hint={`Used for your age. You must be ${MIN_AGE} to ${MAX_AGE}.`}
            />
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Biological sex</legend>
              <p className="text-xs text-muted-foreground">
                This selects which BMR formula we use.
              </p>
              {SEX_OPTIONS.map((option) => (
                <ChoiceCard
                  key={option}
                  name="sex"
                  value={option}
                  checked={form.sex === option}
                  onSelect={() => setField("sex", option)}
                  title={option === "female" ? "Female" : "Male"}
                />
              ))}
            </fieldset>
          </>
        )}

        {step === "body" && (
          <>
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Units</legend>
              {(["metric", "imperial"] as const).map((option) => (
                <ChoiceCard
                  key={option}
                  name="units"
                  value={option}
                  checked={form.units === option}
                  onSelect={() => setField("units", option)}
                  title={option === "metric" ? "Metric" : "Imperial"}
                  description={option === "metric" ? "cm and kg" : "ft/in and lb"}
                />
              ))}
            </fieldset>
            <HeightField
              valueCm={form.height_cm}
              units={form.units}
              onChange={(value) => setField("height_cm", value)}
              error={errors.height_cm}
            />
            <WeightField
              valueKg={form.weight_kg}
              units={form.units}
              onChange={(value) => setField("weight_kg", value)}
              error={errors.weight_kg}
            />
          </>
        )}

        {step === "activity" && (
          <fieldset className="space-y-3">
            <legend className="sr-only">Activity level</legend>
            {ACTIVITY_LEVELS.map((level) => (
              <ChoiceCard
                key={level}
                name="activity_level"
                value={level}
                checked={form.activity_level === level}
                onSelect={() => setField("activity_level", level)}
                title={ACTIVITY_LABELS[level].label}
                description={ACTIVITY_LABELS[level].hint}
                meta={`×${ACTIVITY_MULTIPLIERS[level]}`}
              />
            ))}
          </fieldset>
        )}

        {step === "goal" && (
          <>
            <fieldset className="space-y-3">
              <legend className="sr-only">Goal</legend>
              {GOAL_OPTIONS.map((option) => (
                <ChoiceCard
                  key={option}
                  name="goal"
                  value={option}
                  checked={form.goal === option}
                  onSelect={() => setField("goal", option)}
                  title={GOAL_COPY[option].title}
                  description={GOAL_COPY[option].description}
                />
              ))}
            </fieldset>

            {form.goal !== "maintain" && (
              <>
                <WeightField
                  label="Target weight"
                  valueKg={form.target_weight_kg}
                  units={form.units}
                  onChange={(value) => setField("target_weight_kg", value)}
                  error={errors.target_weight_kg}
                />

                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Pace</legend>
                  <div className="grid grid-cols-2 gap-3">
                    {PACE_OPTIONS.map((pace) => (
                      <ChoiceCard
                        key={pace}
                        name="pace_kg_per_week"
                        value={String(pace)}
                        checked={form.pace_kg_per_week === pace}
                        onSelect={() => setField("pace_kg_per_week", pace)}
                        title={formatPace(pace, form.units)}
                      />
                    ))}
                  </div>
                </fieldset>

                {projectedOn && (
                  <p className="text-sm text-muted-foreground">
                    At {formatPace(form.pace_kg_per_week, form.units)} you'd reach{" "}
                    {formatWeight(form.target_weight_kg ?? 0, form.units)} around{" "}
                    <strong>{toLocaleDate(projectedOn)}</strong>.
                  </p>
                )}
              </>
            )}
          </>
        )}

        {step === "preferences" && (
          <>
            <fieldset className="space-y-3">
              <div className="flex items-baseline justify-between gap-3">
                <legend className="text-sm font-medium">Protein target</legend>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {form.protein_g_per_kg.toFixed(1)} g/kg
                </span>
              </div>
              <Slider
                value={[form.protein_g_per_kg]}
                min={1.2}
                max={2.2}
                step={0.1}
                aria-label="Protein grams per kilogram of body weight"
                onValueChange={(values) => {
                  const value = values[0];
                  if (typeof value === "number") setField("protein_g_per_kg", value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                1.6 g/kg suits most people. More protein helps keep muscle while losing.
              </p>
            </fieldset>

            <ChipGroup
              legend="Dietary tags"
              options={DIETARY_TAG_OPTIONS}
              selected={form.dietary_tags}
              onToggle={(tag) =>
                setField(
                  "dietary_tags",
                  form.dietary_tags.includes(tag)
                    ? form.dietary_tags.filter((value) => value !== tag)
                    : [...form.dietary_tags, tag],
                )
              }
            />

            <TimeZoneSelect
              value={form.timezone}
              onChange={(value) => setField("timezone", value)}
              error={errors.timezone}
            />

            <TextField
              id="reminder_time"
              label="Daily reminder"
              type="time"
              value={form.reminder_time}
              onChange={(value) => setField("reminder_time", value)}
              error={errors.reminder_time}
              hint="Optional. Leave blank for no reminder."
            />
          </>
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

function toLocaleDate(date: Date): string {
  return date.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
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
