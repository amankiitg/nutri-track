import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { fetchProfile, isEmailAllowed } from "@/lib/profile";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/app/BrandMark";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    const [profile, allowed] = await Promise.all([
      fetchProfile(data.user.id),
      isEmailAllowed().catch(() => false),
    ]);
    return { user: data.user, profile, allowed };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { allowed, user } = Route.useRouteContext();

  if (!allowed) {
    return (
      <main className="paper-grain min-h-dvh">
        <div className="app-shell flex min-h-dvh flex-col justify-center py-10">
          <BrandMark size={48} />
          <h1 className="mt-6 text-3xl font-semibold">Not on the list yet</h1>
          <p className="mt-2 text-muted-foreground">
            <strong>{user.email}</strong> isn't on the invite list. Ask the account owner to add
            it, then sign in again.
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

  return <Outlet />;
}
