/**
 * The screens someone sees when the invite gate does not let them through.
 *
 * There are two, and keeping them apart is the point. A check that could not be completed is not a
 * refusal, and saying "you are not on the list" because a network dropped sends someone looking for
 * an invitation they already have.
 *
 * The refusal screen files a request automatically, because that is the one useful thing it can do
 * for somebody who cannot act on the screen otherwise. It goes through `request_invite` with
 * `auto: true`, and that flag is the whole reason this is not a plain opt-in: this call happens
 * without anybody pressing anything, so it must not undo a decision an admin made. A revoked
 * invitation stays revoked and a declined request stays declined; only the request page's own button
 * can put a revoked invitation back in the queue.
 *
 * The outcome is never hidden. "We have your request" when no row was written is a reassurance that
 * costs a week of waiting, so a call that recorded nothing says so and offers the button.
 */
import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/app/BrandMark";
import { InviteAddress } from "@/components/invite/InviteAddress";
import { supabase } from "@/integrations/supabase/client";
import { requestInvite } from "@/lib/invite-request";

/** Why the invite gate did not let someone through. Mirrors the layout's `beforeLoad`. */
export type GateFailure = "denied" | "unavailable";

/** Said when nothing was recorded, whatever the reason. */
const COULD_NOT_RECORD =
  "We couldn't record the request just now. Please try again in a little while.";

export function NotOnTheList({ email, reason }: { email: string; reason: GateFailure }) {
  const router = useRouter();
  /** What happened to the automatic request. */
  const [request, setRequest] = useState<"idle" | "sending" | "sent" | "waiting" | "failed">(
    "idle",
  );
  const [requestError, setRequestError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    // Only a genuine refusal is worth asking about. Firing this from a check that never completed
    // would record a request on behalf of somebody who is on the list.
    if (reason !== "denied") return;

    // Asked once per mount. Remounting the shell is a sign-in, and the database settles a repeat
    // anyway, so a navigation within the session does not need to re-ask.
    let cancelled = false;

    void (async () => {
      setRequest("sending");
      const result = await requestInvite(email, { auto: true });
      if (cancelled) return;
      if (result === "requested") {
        setRequest("sent");
        return;
      }
      if (result === "already_pending") {
        setRequest("waiting");
        return;
      }
      // `already_invited` cannot happen here - the gate is what refused - and anything else means
      // the call did not answer, which is reported rather than papered over.
      setRequest("failed");
      setRequestError(
        result === "already_invited"
          ? "You're on the list already. Sign out and back in."
          : COULD_NOT_RECORD,
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [reason, email]);

  /** The button's path, after the automatic attempt could not record the request. */
  async function requestAgain(): Promise<void> {
    setRequest("sending");
    setRequestError(null);
    const result = await requestInvite(email, { auto: true });
    if (result === "requested") {
      setRequest("sent");
      return;
    }
    if (result === "already_pending") {
      setRequest("waiting");
      return;
    }
    setRequest("failed");
    setRequestError(COULD_NOT_RECORD);
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
              <strong>{email}</strong> isn&apos;t on the list yet.
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
                Your request is in. We&apos;ll email you at <strong>{email}</strong> as soon as
                you&apos;re approved.
              </p>
            )}

            {request === "waiting" && (
              <p
                role="status"
                className="mt-4 rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
              >
                You&apos;ve already requested an invite. We&apos;ll email you at{" "}
                <strong>{email}</strong> as soon as you&apos;re approved.
              </p>
            )}

            {request === "failed" && (
              <>
                <p role="alert" className="mt-4 text-sm text-destructive">
                  {requestError ?? COULD_NOT_RECORD}
                </p>
                <Button className="mt-4 w-fit rounded-full" onClick={() => void requestAgain()}>
                  Request access
                </Button>
              </>
            )}

            {/* Always here, not only when the automatic request failed: this is the way in for
                somebody who would rather say it themselves, and it is what the failure sentence
                points at. */}
            <div className="mt-4">
              <InviteAddress />
            </div>
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
