/**
 * The individual onboarding question groups.
 *
 * Shared by the onboarding wizard (one group per screen) and the settings
 * profile form (all groups stacked), so the two never drift apart.
 */
import { Slider } from "@/components/ui/slider";
import { TargetReachedNotice } from "@/components/goal/TargetReachedNotice";
import {
  ACTIVITY_LABELS,
  ACTIVITY_MULTIPLIERS,
  FAT_CALORIE_SHARE_STEP,
  MAX_FAT_CALORIE_SHARE,
  MAX_FIBER_TARGET_G,
  MIN_FAT_CALORIE_SHARE,
  MIN_FIBER_TARGET_G,
  PACE_OPTIONS,
} from "@/lib/targets";
import type { MaintainSuggestion } from "@/lib/maintain-suggestion";
import { formatPace } from "@/lib/units";
import { reachTarget, reachTargetSentence } from "@/lib/target-date";
import {
  ACTIVITY_LEVELS,
  GOAL_COPY,
  GOAL_OPTIONS,
  MAX_AGE,
  MIN_AGE,
  SEX_OPTIONS,
  type FieldErrors,
  type OnboardingForm,
} from "@/lib/onboarding";
import { ChoiceCard, HeightField, TextField, WeightField } from "./fields";
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
        {/* Nothing is preselected, so the step has to be able to ask. */}
        {errors.sex && (
          <p role="alert" className="text-sm text-destructive">
            {errors.sex}
          </p>
        )}
      </fieldset>
    </>
  );
}

export function UnitsFields({ form, setField }: StepProps) {
  return (
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
  );
}

/**
 * Height, apart from weight so Settings can put it with the other body details.
 */
export function HeightFields({ form, errors, setField }: StepProps) {
  return (
    <HeightField
      valueCm={form.height_cm}
      units={form.units}
      onChange={(value) => setField("height_cm", value)}
      error={errors.height_cm}
    />
  );
}

export function BodyStep({ form, errors, setField }: StepProps) {
  return (
    <>
      <UnitsFields form={form} errors={errors} setField={setField} />
      <HeightFields form={form} errors={errors} setField={setField} />
      <WeightField
        valueKg={form.weight_kg}
        units={form.units}
        onChange={(value) => setField("weight_kg", value)}
        error={errors.weight_kg}
      />
    </>
  );
}

/**
 * Everything that describes the body or the account rather than the goal: the name, the date of
 * birth, sex, units, height and the time zone.
 *
 * Settings folds this into one collapsible at the bottom of the page. It sits with the goal fields
 * on the same screen today, so it is composed here from the same pieces rather than written out a
 * second time — a second copy is how the two screens start disagreeing about validation.
 */
export function ProfileDetailsFields({ form, errors, setField }: StepProps) {
  return (
    <>
      <AboutStep form={form} errors={errors} setField={setField} />
      <UnitsFields form={form} errors={errors} setField={setField} />
      <HeightFields form={form} errors={errors} setField={setField} />
      <TimeZoneSelect
        value={form.timezone}
        onChange={(value) => setField("timezone", value)}
        error={errors.timezone}
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

/**
 * The goal choice on its own.
 *
 * Split out so Settings can put the current weight between this and the rest of the goal fields —
 * the order somebody reads their own numbers in — without a second copy of the choice cards.
 */
export function GoalChoiceFields({ form, errors, setField }: StepProps) {
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

      {errors.goal && (
        <p role="alert" className="text-sm text-destructive">
          {errors.goal}
        </p>
      )}
    </>
  );
}

/**
 * Target weight, pace, and what follows from them: the date to arrive, or the notice that the
 * target has been reached. Nothing to show for a goal with no destination, so it renders nothing.
 */
export function TargetFields({
  form,
  errors,
  setField,
  maintain = null,
  basisKg = null,
  today = "",
  hideAtTarget = false,
  showNotice = true,
}: StepProps & {
  /**
   * The reached-target decision Settings made from the 7-day window, or null.
   *
   * Onboarding passes nothing: a new user has no weigh-ins, so "you're at your target" would
   * be a claim about history they do not have. Settings passes whatever Today's rule decided,
   * so the form's own weight and target can never produce a notice of their own.
   */
  maintain?: MaintainSuggestion | null;
  /**
   * The weight the arrival date is projected from, and the profile's day.
   *
   * Settings passes the trailing 7-day average it read from the same query Today uses, because
   * one reading is noise. Onboarding passes the weight typed on the Body step: a new user has
   * no week to average, and the number they gave is the only position there is.
   */
  basisKg?: number | null;
  today?: string;
  /**
   * Onboarding says nothing once the target is already met: that step is asking where the
   * person wants to go, and a sentence about having arrived is the maintain choice's job.
   * Settings keeps the line, because there it answers "what happens if I save this".
   */
  hideAtTarget?: boolean;
  /**
   * False when the caller draws the notice itself, outside a collapsible. Settings does: a
   * notice that says the target has been reached is a question for the person, and one inside
   * a shut panel is a question nobody is asked.
   */
  showNotice?: boolean;
}) {
  // Recomputed on every render, so the line follows a change of pace, target or basis weight
  // before anything is saved. `basisKg` is the caller's decision: Settings hands it the 7-day
  // average (one reading is noise), onboarding the weight typed two steps earlier.
  const reach = reachTarget({
    goal: form.goal,
    basisKg,
    targetKg: form.target_weight_kg,
    paceKgPerWeek: form.pace_kg_per_week,
    today,
  });
  const reachLine =
    reach === null || (reach.atTarget && hideAtTarget)
      ? null
      : reachTargetSentence({
          goal: form.goal,
          basisKg,
          targetKg: form.target_weight_kg,
          paceKgPerWeek: form.pace_kg_per_week,
          today,
          units: form.units,
        });

  if (form.goal === null || form.goal === "maintain") return null;

  return (
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

      {/*
        Directly under the pace it depends on, and not beside the notice below: a date to
        arrive at a target contradicts "you're at it", so the notice wins when it is shown.
      */}
      {reachLine !== null && maintain === null && (
        <p className="text-sm text-muted-foreground">{reachLine}</p>
      )}

      {showNotice && maintain !== null && (
        <TargetReachedNotice
          averageKg={maintain.averageKg}
          crossed={maintain.crossed}
          units={form.units}
          onSwitch={() => setField("goal", "maintain")}
        />
      )}
    </>
  );
}

/**
 * The goal step, as onboarding shows it: the choice, then whatever follows from it.
 *
 * The arrival date is projected from the weight typed on the Body step, because that is the
 * only position a new user has: there is no week of weigh-ins to average yet. Settings uses
 * the average instead, and the shared sentence means the two screens still read the same.
 */
export function GoalStep({
  maintain = null,
  today = "",
  ...stepProps
}: StepProps & {
  maintain?: MaintainSuggestion | null;
  /** The profile's own day, for the date on the arrival line. */
  today?: string;
}) {
  return (
    <>
      <GoalChoiceFields {...stepProps} />
      <TargetFields
        {...stepProps}
        maintain={maintain}
        basisKg={stepProps.form.weight_kg}
        today={today}
        hideAtTarget
      />
    </>
  );
}

/**
 * Protein, fat and fibre — the three numbers that decide the macro split.
 *
 * Settings puts them behind one collapsible; onboarding shows the protein target on its own, which
 * is what the two flags are for.
 */
export function MacroFields({
  form,
  errors,
  setField,
  showFibreTarget = false,
  showFatShare = false,
}: StepProps & {
  /**
   * Settings only. Onboarding leaves the database default in place; this is the screen somebody
   * visits to change a number they have been living with, not one they are choosing for the first
   * time. The form still carries the value either way, so both paths write the same column.
   */
  showFibreTarget?: boolean;
  /**
   * Settings only too, and for a stronger reason: the split is arithmetic on the target, so
   * changing it is a change to a number already being eaten against. Onboarding starts everybody on
   * the 30% default, which is also what the migration writes for existing rows.
   */
  showFatShare?: boolean;
}) {
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

      {showFatShare && (
        <fieldset className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <legend className="text-sm font-medium">Fat share</legend>
            <span className="text-sm tabular-nums text-muted-foreground">
              {Math.round(form.fat_share * 100)}% of calories
            </span>
          </div>
          <Slider
            value={[form.fat_share]}
            min={MIN_FAT_CALORIE_SHARE}
            max={MAX_FAT_CALORIE_SHARE}
            step={FAT_CALORIE_SHARE_STEP}
            aria-label="Share of calories from fat"
            onValueChange={(values) => {
              const value = values[0];
              if (typeof value === "number") setField("fat_share", value);
            }}
          />
          <p className="text-xs text-muted-foreground">
            Carbs fill whatever is left after protein and fat.
          </p>
          {errors.fat_share && (
            <p role="alert" className="text-sm text-destructive">
              {errors.fat_share}
            </p>
          )}
        </fieldset>
      )}

      {showFibreTarget && (
        <fieldset className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <legend className="text-sm font-medium">Fibre target</legend>
            <span className="text-sm tabular-nums text-muted-foreground">
              {Math.round(form.fiber_target_g)} g/day
            </span>
          </div>
          <Slider
            value={[form.fiber_target_g]}
            min={MIN_FIBER_TARGET_G}
            max={MAX_FIBER_TARGET_G}
            step={1}
            aria-label="Daily fibre target in grams"
            onValueChange={(values) => {
              const value = values[0];
              if (typeof value === "number") setField("fiber_target_g", value);
            }}
          />
          <p className="text-xs text-muted-foreground">
            30 g a day suits most adults. Going over is not a problem, so there is no upper warning.
          </p>
          {errors.fiber_target_g && (
            <p role="alert" className="text-sm text-destructive">
              {errors.fiber_target_g}
            </p>
          )}
        </fieldset>
      )}
    </>
  );
}

/**
 * The Preferences screen: the macros, the dietary tags and the time zone.
 *
 * Onboarding's last step. Settings no longer uses this: it draws `MacroFields` in one collapsible
 * and `ProfileDetailsFields` in another, and shows no dietary tags at all — nothing reads them, and
 * a control that stores a value nothing uses costs a belief that it is doing something.
 */
export function PreferencesStep({
  form,
  errors,
  setField,
  showFibreTarget = false,
  showFatShare = false,
}: StepProps & {
  showFibreTarget?: boolean;
  showFatShare?: boolean;
}) {
  return (
    <>
      <MacroFields
        form={form}
        errors={errors}
        setField={setField}
        showFibreTarget={showFibreTarget}
        showFatShare={showFatShare}
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
