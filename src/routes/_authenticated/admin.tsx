/**
 * The admin page.
 *
 * Access is decided three times over, and only the middle one actually matters:
 *
 *   1. The tab is absent from the navigation for anyone who is not an admin.
 *   2. This route redirects unless `is_admin()` said true, so typing the URL does nothing.
 *   3. Every read and write behind it is refused by RLS.
 *
 * Number three is the control. One and two are there so that a normal user does not see a
 * door they cannot open, and so that a mistake in this file cannot become a leak — the
 * worst it could do is render a page of errors.
 */
import { createFileRoute, getRouteApi, redirect } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { InviteList, InviteRequestsPanel, SpendPanel } from "@/components/admin/panels";

const parentApi = getRouteApi("/_authenticated");

export const Route = createFileRoute("/_authenticated/admin")({
  beforeLoad: ({ context }) => {
    if (context.isAdmin !== true) throw redirect({ to: "/today" });
  },
  component: AdminPage,
});

function AdminPage() {
  const { user } = parentApi.useRouteContext();

  return (
    <div className="app-shell space-y-6 py-8">
      <header>
        <h1 className="flex items-center gap-2 text-3xl font-semibold">
          <ShieldCheck className="size-7" aria-hidden="true" />
          Admin
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Who can get in, who has asked, and what the meal reader has been costing.
        </p>
      </header>

      <InviteRequestsPanel />
      <InviteList adminId={user.id} />
      <SpendPanel />

      <Card>
        <CardContent className="py-4 text-xs text-muted-foreground">
          <p>
            A second admin cannot be created from this page. The <code>admins</code> table has no
            insert policy, so nobody — including you — can promote an account through the app or the
            API with their own token.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
