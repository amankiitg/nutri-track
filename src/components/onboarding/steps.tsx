/**
 * The individual onboarding question groups.
 *
 * Shared by the onboarding wizard (one group per screen) and the settings
 * profile form (all groups stacked), so the two never drift apart.
 */
import { Slider } from "@/components/ui/slider";
import {
  ACTIVITY_LABELS,
  ACTIVITY_MULTIPLIERS,
  PACE_OPTIONS,
  projectedTargetDate,
} from "@/lib/targets";
import { DIETARY_TAG_OPTIONS } from "@/lib/profile";
import { formatPace, formatWeight } from "@/lib/units";
import {
  ACTIVITY_LEVELS,
  GOAL_COPY,
  GOAL_OPTIONS,
  MAX_AGE,
  MIN_AGE,
  SEX_OPTIONS,
  toLocaleDate,
  type FieldErrors,
  type OnboardingForm,
} from "@/lib/onboarding";
import { ChoiceCard, ChipGroup, HeightField, TextField, WeightField } from "./fields";
import { TimeZoneSelect } from "./TimeZoneSelect";

export interface StepProps {
  form: OnboardingForm;
  errors: FieldErrors;
  setField: <K extends keyof OnboardingForm>(key: K, value: OnboardingForm[K]) => void;
}

export function AboutStep({ form, errors, setField }: StepProps) {
  return (
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
        <p className="text-xs text-muted-foreground">This selects which BMR formula we use.</p>
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
  );
}

export function BodyStep({ form, errors, setField }: StepProps) {
  return (
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
  );
}

export function ActivityStep({ form, setField }: StepProps) {
  return (
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
  );
}

export function GoalStep({ form, errors, setField }: StepProps) {
  const projectedOn =
    form.goal !== "maintain" && form.target_weight_kg != null && form.weight_kg != null
      ? projectedTargetDate(form.weight_kg, form.target_weight_kg, form.pace_kg_per_week)
      : null;

  return (
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
            id="target-weight"
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
  );
}

export function PreferencesStep({ form, errors, setField }: StepProps) {
  return (
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

      {/*
        A "Daily reminder" time field used to sit here. It is gone because nothing ever
        read it: no notification code, no push subscription, nothing. A control that
        stores a value and does nothing is worse than no control, because it costs a
        belief someone is relying on.

        `profiles.reminder_time` is deliberately still there and its contents are
        untouched — nothing writes it now, so a profile save leaves it alone, and
        `upsert` only touches the columns it is given.

        If reminders are ever built, re-adding the field means knowing this: the column is
        `time without time zone`, which PostgREST serialises as `20:00:00`, so a form that
        validates `HH:MM` will refuse the value it wrote itself. That is the bug this
        field was removed with.
      */}
    </>
  );
}
