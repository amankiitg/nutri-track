import { useState, type FormEvent, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { saveProfileWithTargets, type Profile } from "@/lib/profile";
import {
  formFromProfile,
  toProfileInsert,
  validateForm,
  type FieldErrors,
  type OnboardingForm,
} from "@/lib/onboarding";
import { AboutStep, ActivityStep, BodyStep, GoalStep, PreferencesStep } from "./steps";

/**
 * Edits an existing profile in one scrolling form, reusing the exact field
 * groups the onboarding wizard shows. Saving calls `saveProfileWithTargets`,
 * which writes a *new* `targets` row for today rather than mutating history.
 */
export function ProfileForm({
  profile,
  onSaved,
}: {
  profile: Profile;
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
      setSaveError(error instanceof Error ? error.message : "Could not save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const stepProps = { form, errors, setField };

  return (
    <form className="space-y-8" onSubmit={save} noValidate>
      <FieldGroup title="About you">
        <AboutStep {...stepProps} />
      </FieldGroup>
      <FieldGroup title="Your body">
        <BodyStep {...stepProps} />
      </FieldGroup>
      <FieldGroup title="Activity level">
        <ActivityStep {...stepProps} />
      </FieldGroup>
      <FieldGroup title="Your goal">
        <GoalStep {...stepProps} />
      </FieldGroup>
      <FieldGroup title="Preferences">
        <PreferencesStep {...stepProps} />
      </FieldGroup>

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
