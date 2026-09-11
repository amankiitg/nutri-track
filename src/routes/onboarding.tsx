import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { fetchProfile, saveProfileWithTargets } from "@/lib/profile";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";
import { BrandMark } from "@/components/app/BrandMark";

export const Route = createFileRoute("/onboarding")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });

    // Onboarding runs once; a user who already has a profile belongs on Today.
    const profile = await fetchProfile(data.user.id);
    if (profile) throw redirect({ to: "/today" });

    return { user: data.user };
  },
  component: OnboardingPage,
});

function OnboardingPage() {
  const { user } = Route.useRouteContext();
  const navigate = useNavigate();

  return (
    <main className="paper-grain min-h-dvh">
      <div className="app-shell py-8">
        <BrandMark size={32} className="mb-6" />
        <OnboardingWizard
          userId={user.id}
          onConfirm={saveProfileWithTargets}
          onSaved={() => {
            navigate({ to: "/today", replace: true });
          }}
        />
      </div>
    </main>
  );
}
