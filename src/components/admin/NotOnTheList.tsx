/**
 * The screens someone sees when the invite gate does not let them through.
 *
 * There are two, and keeping them apart is the point. A check that could not be completed is
 * not a refusal, and saying "you are not on the list" because a network dropped sends someone
 * looking for an invitation they already have.
 *
 * The refusal screen files a request automatically, because that is the one useful thing it can
 * do for somebody who cannot act on the screen otherwise. It no longer hides the outcome: a
 * request that was not recorded says so and offers the button, because "we have your request"
 * when no row was written is the kind of reassurance that costs a week of waiting. The write is
 * `recordInviteRequest`, the only one an uninvited person can cause, and it carries no address:
 * the row's comes from this person's own token, so there is nothing for a tampered body to aim
 * at, and the table's unique index and burst limit still bound it.
 */
import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/app/BrandMark";
import { supabase } from "@/integrations/supabase/client";
import { fetchOwnRequest, recordInviteRequest } from "@/lib/admin";

/** Why the invite gate did not let someone through. Mirrors the layout's `beforeLoad`. */
export type GateFailure = "denied" | "unavailable";

/** Said when the row was not written, whether the guard refused it or the call failed quietly. */
const COULD_NOT_RECORD =
  "We couldn't record the request just now. Please try again in a little while.";

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : COULD_NOT_RECORD;
}

export function NotOnTheList({ email, reason }: { email: string; reason: GateFailure }) {
  const router = useRouter();
  /** What happened to the automatic request. */
  const [request, setRequest] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [requestError, setRequestError] = useState<string | null>(null);
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
        setRequest("sent");
        return;
      }

      setRequest("sending");
      try {
        const recorded = await recordInviteRequest();
        if (cancelled) return;
        setRequest(recorded ? "sent" : "failed");
        if (!recorded) setRequestError(COULD_NOT_RECORD);
      } catch (caught) {
        if (cancelled) return;
        setRequest("failed");
        setRequestError(messageOf(caught));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reason, email]);

  /** The button's path, after the automatic attempt could not record the request. */
  async function requestAgain(): Promise<void> {
    setRequest("sending");
    setRequestError(null);
    try {
      const recorded = await recordInviteRequest();
      setRequest(recorded ? "sent" : "failed");
      if (!recorded) setRequestError(COULD_NOT_RECORD);
    } catch (caught) {
      setRequest("failed");
      setRequestError(messageOf(caught));
    }
  }

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
            <h1 className="mt-6 text-3xl font-semibold">NutriTrack is invite-only right now</h1>
            <p className="mt-2 text-muted-foreground">
              <strong>{email}</strong> isn&apos;t on the list yet. Request access and you&apos;ll
              get an email as soon as you&apos;re in.
            </p>

            {request === "sending" && (
              <p role="status" className="mt-4 text-sm text-muted-foreground">
                Sending your request…
              </p>
            )}

            {request === "sent" && (
              <p
                role="status"
                className="mt-4 rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
              >
                Request sent. We&apos;ll email <strong>{email}</strong> when you&apos;re approved.
              </p>
            )}

            {request === "failed" && (
              <>
                {requestError !== null && (
                  <p role="alert" className="mt-4 text-sm text-destructive">
                    {requestError}
                  </p>
                )}
                <Button className="mt-4 w-fit rounded-full" onClick={() => void requestAgain()}>
                  Request access
                </Button>
              </>
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
