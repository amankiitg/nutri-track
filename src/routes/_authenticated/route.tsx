import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { fetchProfile, isEmailAllowed } from "@/lib/profile";
import { fetchIsAdmin } from "@/lib/admin";
import { BrandMark } from "@/components/app/BrandMark";
import { CaptureDock } from "@/components/capture/CaptureDock";
import { TabBar } from "@/components/app/TabBar";
import { NotOnTheList, type GateFailure } from "@/components/admin/NotOnTheList";

type Gate = "allowed" | GateFailure;

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      // The path they asked for travels through sign-in with them, so a link to /trends lands on
      // /trends rather than on /today. `safeRedirect` on the other side is what makes it safe to
      // trust: this value is attacker-controlled and ends up in a navigation.
      //
      // `reloadDocument` rather than a router navigation. The session lives in localStorage, so the
      // server rendering this page could not know there is none; it sent the empty shell of a
      // client-only route. Swapping that shell for the sign-in page inside the same render is what
      // React reported as "the server rendered HTML didn't match the client", the mismatch recorded
      // in AGENTS.md. Asking the server for /auth means it is rendered and hydrated from scratch,
      // and both sides agree.
      throw redirect({
        to: "/auth",
        search: { redirect: location.href },
        reloadDocument: true,
      });
    }

    // Invite-list gate: a user who is not allowed never reaches onboarding.
    //
    // A check that failed and a genuine refusal have to stay distinguishable. Collapsing both
    // into `false` -- as `.catch(() => false)` did -- told a signed-in person they had been
    // taken off the list because a train tunnel ate one request. Access still fails closed;
    // it is only the *message* that stops claiming a refusal it never received.
    const gate: Gate = await isEmailAllowed()
      .then((allowed): Gate => (allowed ? "allowed" : "denied"))
      .catch((): Gate => "unavailable");

    if (gate !== "allowed") {
      return { user: data.user, profile: null, gate, isAdmin: false };
    }

    // Single gate that guarantees every authenticated screen has a profile,
    // and therefore a target row to read.
    const profile = await fetchProfile(data.user.id);
    if (!profile) throw redirect({ to: "/onboarding" });

    // Read once here rather than on the admin route, because the navigation needs it too:
    // a tab that appears and then disappears is worse than one that appears late.
    const isAdmin = await fetchIsAdmin();

    return { user: data.user, profile, gate, isAdmin };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { gate, user, profile, isAdmin } = Route.useRouteContext();
  if (gate !== "allowed") {
    return <NotOnTheList email={user.email ?? "this account"} reason={gate} />;
  }

  return (
    <div className="paper-grain flex min-h-dvh flex-col">
      {/* Clearance for the tab bar, derived from the bar's own height rather than a fixed
          guess: `pb-20` was 80px and did not include the safe-area inset, so the room left
          under the last card shrank by 1px for every 1px of inset. */}
      <main className="flex-1 pb-[calc(var(--tabbar-height)+env(safe-area-inset-bottom)+1rem)]">
        <Outlet />
      </main>
      {/* Available on every authenticated screen, not just Today: a meal gets eaten
          wherever you happen to be in the app. */}
      <CaptureDock userId={user.id} timeZone={profile?.timezone ?? "UTC"} />
      <TabBar isAdmin={isAdmin} />
    </div>
  );
}
