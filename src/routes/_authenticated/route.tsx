import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { fetchProfile, isEmailAllowed } from "@/lib/profile";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/app/BrandMark";
import { CaptureDock } from "@/components/capture/CaptureDock";
import { TabBar } from "@/components/app/TabBar";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });

    // Invite-list gate: a user who is not allowed never reaches onboarding.
    const allowed = await isEmailAllowed().catch(() => false);
    if (!allowed) return { user: data.user, profile: null, allowed: false };

    // Single gate that guarantees every authenticated screen has a profile,
    // and therefore a target row to read.
    const profile = await fetchProfile(data.user.id);
    if (!profile) throw redirect({ to: "/onboarding" });

    return { user: data.user, profile, allowed: true };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { allowed, user, profile } = Route.useRouteContext();
  if (!allowed) {
    return (
      <main className="paper-grain min-h-dvh">
        <div className="app-shell flex min-h-dvh flex-col justify-center py-10">
          <BrandMark size={48} />
          <h1 className="mt-6 text-3xl font-semibold">Not on the list yet</h1>
          <p className="mt-2 text-muted-foreground">
            <strong>{user.email}</strong> isn't on the invite list. Ask the account owner to add it,
            then sign in again.
          </p>
          <Button
            className="mt-6 w-fit rounded-full"
            variant="outline"
            onClick={async () => {
              await supabase.auth.signOut();
              window.location.href = "/auth";
            }}
          >
            Sign out
          </Button>
        </div>
      </main>
    );
  }

  return (
    <div className="paper-grain flex min-h-dvh flex-col">
      <main className="flex-1 pb-20">
        <Outlet />
      </main>
      {/* Available on every authenticated screen, not just Today: a meal gets eaten
          wherever you happen to be in the app. */}
      <CaptureDock userId={user.id} timeZone={profile?.timezone ?? "UTC"} />
      <TabBar />
    </div>
  );
}
