/**
 * The screens someone sees when the invite gate does not let them through.
 *
 * There are two, and keeping them apart is the point. A check that could not be completed is
 * not a refusal, and saying "you are not on the list" because a network dropped sends someone
 * looking for an invitation they already have. The refusal screen is the only place in the app
 * an uninvited person can cause a write, so the write is deliberately fire-and-forget: it
 * happens once per session, it cannot fail the screen, and the screen works identically whether
 * it succeeded or not. What it must never do is stop the person reading the one thing they need
 * to know, which is who to ask.
 */
import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/app/BrandMark";
import { supabase } from "@/integrations/supabase/client";
import { fetchOwnRequest, recordInviteRequest } from "@/lib/admin";

/** Why the invite gate did not let someone through. Mirrors the layout's `beforeLoad`. */
export type GateFailure = "denied" | "unavailable";

export function NotOnTheList({ email, reason }: { email: string; reason: GateFailure }) {
  const router = useRouter();
  const [requested, setRequested] = useState<boolean | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    // Only a genuine refusal is worth asking about. `invite_requests` is the one write an
    // uninvited person can cause, and firing it from a check that never completed would record
    // a request on behalf of somebody who is already on the list.
    if (reason !== "denied") return;

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
  }, [reason]);

  return (
    <main className="paper-grain min-h-dvh">
      <div className="app-shell flex min-h-dvh flex-col justify-center py-10">
        <BrandMark size={48} />

        {reason === "unavailable" ? (
          <>
            <h1 className="mt-6 text-3xl font-semibold">We couldn&apos;t check your invite</h1>
            <p className="mt-2 text-muted-foreground">
              Something got in the way of checking whether <strong>{email}</strong> is on the invite
              list. That is usually a dropped connection, and it says nothing about your account.
              Try again in a moment.
            </p>
            <Button
              className="mt-6 w-fit rounded-full"
              disabled={retrying}
              onClick={() => {
                setRetrying(true);
                // Re-runs the layout's `beforeLoad`, which is where the check lives.
                void router.invalidate().finally(() => setRetrying(false));
              }}
            >
              {retrying ? "Checking…" : "Try again"}
            </Button>
          </>
        ) : (
          <>
            <h1 className="mt-6 text-3xl font-semibold">Not on the list yet</h1>
            <p className="mt-2 text-muted-foreground">
              <strong>{email}</strong> isn&apos;t on the invite list. Ask the account owner to add
              it, then sign in again.
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
          </>
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
