import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { fetchProfile, isEmailAllowed } from "@/lib/profile";
import { fetchIsAdmin } from "@/lib/admin";
import { BrandMark } from "@/components/app/BrandMark";
import { CaptureDock } from "@/components/capture/CaptureDock";
import { TabBar } from "@/components/app/TabBar";
import { NotOnTheList } from "@/components/admin/NotOnTheList";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });

    // Invite-list gate: a user who is not allowed never reaches onboarding.
    const allowed = await isEmailAllowed().catch(() => false);
    if (!allowed) return { user: data.user, profile: null, allowed: false, isAdmin: false };

    // Single gate that guarantees every authenticated screen has a profile,
    // and therefore a target row to read.
    const profile = await fetchProfile(data.user.id);
    if (!profile) throw redirect({ to: "/onboarding" });

    // Read once here rather than on the admin route, because the navigation needs it too:
    // a tab that appears and then disappears is worse than one that appears late.
    const isAdmin = await fetchIsAdmin();

    return { user: data.user, profile, allowed: true, isAdmin };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { allowed, user, profile, isAdmin } = Route.useRouteContext();
  if (!allowed) {
    return <NotOnTheList email={user.email ?? "this account"} />;
  }

  return (
    <div className="paper-grain flex min-h-dvh flex-col">
      <main className="flex-1 pb-20">
        <Outlet />
      </main>
      {/* Available on every authenticated screen, not just Today: a meal gets eaten
          wherever you happen to be in the app. */}
      <CaptureDock userId={user.id} timeZone={profile?.timezone ?? "UTC"} />
      <TabBar isAdmin={isAdmin} />
    </div>
  );
}
