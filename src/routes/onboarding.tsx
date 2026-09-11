import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/onboarding")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  component: OnboardingPage,
});

/**
 * Placeholder so the `_authenticated` guard has a real redirect target.
 * The wizard replaces this component next.
 */
function OnboardingPage() {
  return (
    <main className="paper-grain min-h-dvh">
      <div className="app-shell flex min-h-dvh flex-col justify-center py-10 text-center">
        <h1 className="text-3xl font-semibold">Let's set up your targets</h1>
        <p className="mt-2 text-muted-foreground">Onboarding arrives in the next step.</p>
      </div>
    </main>
  );
}
