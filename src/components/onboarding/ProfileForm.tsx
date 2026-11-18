import { useState, type FormEvent, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/admin/Section";
import { saveFailureDetail, saveProfileWithTargets, type Profile } from "@/lib/profile";
import type { MaintainSuggestion } from "@/lib/maintain-suggestion";
import { formatHeight } from "@/lib/units";
import {
  formFromProfile,
  toProfileInsert,
  validateForm,
  type FieldErrors,
  type OnboardingForm,
} from "@/lib/onboarding";
import {
  ActivityStep,
  GoalChoiceFields,
  MacroFields,
  ProfileDetailsFields,
  TargetFields,
} from "./steps";
import { WeightField } from "./fields";

/**
 * Edits an existing profile in one scrolling form, reusing the exact field groups the onboarding
 * wizard shows. Saving calls `saveProfileWithTargets`, which writes a *new* `targets` row for today
 * rather than mutating history.
 *
 * The order is the order somebody reads their own numbers in: the goal, the weight they are now,
 * the weight they are going to, the pace, and the activity that sets the burn. What is left is
 * settings rather than decisions — the macro split and the account details — so each is one
 * collapsible, shut by default, with its current values in the summary line. Nothing is lost by
 * being shut: the panels are hidden rather than unmounted, so every field keeps its value and a
 * save sends the whole form.
 *
 * `Section` is the admin page's collapsible. It is imported rather than copied because a second
 * copy is how one of them loses the `aria-expanded` or the remembered state.
 */
export function ProfileForm({
  profile,
  maintain = null,
  onSaved,
}: {
  profile: Profile;
  /**
   * The reached-target decision, made by the route from the same 7-day window Today reads.
   * Null means Today would not show it either.
   */
  maintain?: MaintainSuggestion | null;
  onSaved?: (() => void) | undefined;
}) {
  const [form, setForm] = useState<OnboardingForm>(() => formFromProfile(profile));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function setField<K extends keyof OnboardingForm>(key: K, value: OnboardingForm[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => {
      if (!previous[key]) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaveError(null);

    const formErrors = validateForm(form);
    if (Object.keys(formErrors).length > 0) {
      setErrors(formErrors);
      setSaveError("Please check the highlighted fields and try again.");
      return;
    }

    setSaving(true);
    try {
      await saveProfileWithTargets(toProfileInsert(form, profile.user_id));
      setErrors({});
      onSaved?.();
    } catch (error) {
      // The raw value goes to the console as well: a PostgREST failure is a plain object here, not
      // an Error, and its hint is the most useful field of the four.
      console.error(error);
      const detail = saveFailureDetail(error);
      setSaveError(
        detail === null ? "Could not save. Please try again." : `Could not save. ${detail}`,
      );
    } finally {
      setSaving(false);
    }
  }

  const stepProps = { form, errors, setField };

  /** What the macro panel says while it is shut, in the units the sliders are read in. */
  const macroSummary = [
    `Protein ${form.protein_g_per_kg.toFixed(1)} g/kg`,
    `Fat ${Math.round(form.fat_share * 100)}%`,
    `Fibre ${Math.round(form.fiber_target_g)} g`,
  ].join(" · ");

  /** The body and the account in one line: the three things that rarely change and are checked often. */
  const detailsSummary = [
    form.sex === null ? "Sex not set" : form.sex === "female" ? "Female" : "Male",
    form.height_cm === null ? "Height not set" : formatHeight(form.height_cm, form.units),
    form.timezone,
  ].join(" · ");

  return (
    <form className="space-y-8" onSubmit={save} noValidate>
      <FieldGroup title="Your goal">
        <GoalChoiceFields {...stepProps} />
        <WeightField
          id="current-weight"
          label="Current weight"
          valueKg={form.weight_kg}
          units={form.units}
          onChange={(value) => setField("weight_kg", value)}
          error={errors.weight_kg}
        />
        <TargetFields {...stepProps} maintain={maintain} />
      </FieldGroup>
      <FieldGroup title="Activity level">
        <ActivityStep {...stepProps} />
      </FieldGroup>

      {
        // Both panels stay mounted while shut. That is what keeps a value typed in one of them
        // from being dropped by a save, which is the failure a collapsed form invites.
      }
      <Section id="settings-macros" title="Macro preferences" summary={macroSummary}>
        <div className="space-y-5 px-6 py-4">
          <MacroFields {...stepProps} showFibreTarget showFatShare />
        </div>
      </Section>

      <Section id="settings-details" title="Profile details" summary={detailsSummary}>
        <div className="space-y-5 px-6 py-4">
          <ProfileDetailsFields {...stepProps} />
        </div>
      </Section>

      {saveError && (
        <p role="alert" className="text-sm text-destructive">
          {saveError}
        </p>
      )}

      <Button type="submit" className="h-12 w-full rounded-full text-base" disabled={saving}>
        {saving && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
        Save changes
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        Saving writes a new target for today. Earlier days keep the target they were logged against.
      </p>
    </form>
  );
}

function FieldGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}
