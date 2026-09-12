/**
 * The screen someone sees when they sign in and are not on the invite list.
 *
 * This is the only place in the app an uninvited person can cause a write, so the write
 * is deliberately fire-and-forget: it happens once per session, it cannot fail the
 * screen, and the screen works identically whether it succeeded or not. What it must
 * never do is stop the person reading the one thing they need to know, which is who to
 * ask.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/app/BrandMark";
import { supabase } from "@/integrations/supabase/client";
import { fetchOwnRequest, recordInviteRequest } from "@/lib/admin";

export function NotOnTheList({ email }: { email: string }) {
  const [requested, setRequested] = useState<boolean | null>(null);

  useEffect(() => {
    // Asked once per mount. Remounting the shell is a sign-in, and the database skips a
    // repeat anyway, so a navigation within the session does not need to re-ask.
    let cancelled = false;

    void (async () => {
      const existing = await fetchOwnRequest();
      if (cancelled) return;
      if (existing !== null) {
        setRequested(true);
        return;
      }
      const ok = await recordInviteRequest();
      if (!cancelled) setRequested(ok);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="paper-grain min-h-dvh">
      <div className="app-shell flex min-h-dvh flex-col justify-center py-10">
        <BrandMark size={48} />
        <h1 className="mt-6 text-3xl font-semibold">Not on the list yet</h1>
        <p className="mt-2 text-muted-foreground">
          <strong>{email}</strong> isn&apos;t on the invite list. Ask the account owner to add it,
          then sign in again.
        </p>

        {requested === true && (
          <p
            role="status"
            className="mt-4 rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
          >
            Your request has been sent, so you may not need to ask separately. Nothing else is
            needed from you.
          </p>
        )}

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
