/**
 * A personal trial link: https://tracknutri.app/t/<token>.
 *
 * The admin made it for one person, by hand or in their invite email. Opening it skips the
 * email, the code and Turnstile: the signed token is the proof. The service checks it (the
 * signature, the 30 days, the version a revoke bumps, and whether the address already has an
 * account), and only then is it stored as this browser's trial token, exactly where the code
 * flow stores one, so the scans that follow are ordinary trial scans against that mailbox.
 *
 * Nothing is read or written while rendering: localStorage does not exist on the server, so the
 * first paint on both sides is the spinner and the effect decides.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { BrandMark } from "@/components/app/BrandMark";
import { TrialAlreadyAccess, TrialLinkExpired } from "@/components/trial/LinkStates";
import { storeTrial, verifyTrialLink } from "@/lib/trial";
import { TrialPage } from "./try";

export const Route = createFileRoute("/t/$token")({
  head: () => ({
    meta: [{ title: "Your NutriTrack trial" }, { name: "robots", content: "noindex" }],
  }),
  component: TrialLinkRoute,
});

function TrialLinkRoute() {
  const { token } = Route.useParams();
  return <TrialLink token={token} />;
}

type LinkState =
  | { kind: "checking" }
  | { kind: "ready"; firstName: string | null }
  | { kind: "already_access"; email: string }
  | { kind: "expired" }
  | { kind: "unreachable"; message: string };

export function TrialLink({ token }: { token: string }) {
  const [state, setState] = useState<LinkState>({ kind: "checking" });

  useEffect(() => {
    let active = true;
    verifyTrialLink(token).then(
      (result) => {
        if (!active) return;
        if (result.status === "ok") {
          storeTrial({ token, email: result.email });
          setState({ kind: "ready", firstName: result.firstName });
        } else if (result.status === "already_access") {
          setState({ kind: "already_access", email: result.email });
        } else {
          setState({ kind: "expired" });
        }
      },
      (error: unknown) => {
        if (!active) return;
        setState({
          kind: "unreachable",
          message: error instanceof Error ? error.message : "Could not open the trial. Try again.",
        });
      },
    );
    return () => {
      active = false;
    };
  }, [token]);

  if (state.kind === "ready") return <TrialPage link={{ firstName: state.firstName }} />;
  if (state.kind === "already_access") return <TrialAlreadyAccess email={state.email} />;
  if (state.kind === "expired") return <TrialLinkExpired />;

  return (
    <main className="paper-grain flex min-h-dvh flex-col">
      <div className="app-shell my-auto flex flex-col items-center py-10 text-center">
        <BrandMark size={40} />
        {state.kind === "checking" ? (
          <Loader2 className="mt-8 size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : (
          <p role="alert" className="mt-6 max-w-sm text-sm text-muted-foreground">
            {state.message}
          </p>
        )}
      </div>
    </main>
  );
}
