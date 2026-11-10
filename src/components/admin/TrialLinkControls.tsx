/**
 * A personal trial link on an admin row: copy it, see that it went out, revoke it.
 *
 * Copying asks the service to sign the link (the browser holds no key) and records it as sent,
 * because copying it is the admin sending it by hand. Revoking bumps the mailbox's token version,
 * so every link already out stops working and the next one copied works.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { issueTrialLink, revokeTrialLink, type TrialLinkSent } from "@/lib/admin";
import { TRIAL_LINKS_KEY } from "./use-trial-links";
import { CopyRefused, copyWhenReady } from "@/lib/clipboard";

export function TrialLinkControls({
  email,
  firstName,
  sent,
}: {
  email: string;
  firstName: string | null;
  sent: TrialLinkSent | undefined;
}) {
  const queryClient = useQueryClient();
  const [copying, setCopying] = useState(false);

  const revoke = useMutation({
    mutationFn: () => revokeTrialLink(email),
    onSuccess: () => {
      toast.success(`Trial link revoked for ${email}`);
      void queryClient.invalidateQueries({ queryKey: [TRIAL_LINKS_KEY] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not revoke the trial link.");
    },
  });

  /** Not a mutation: the clipboard write has to start inside this click for Safari to allow it. */
  function copy() {
    setCopying(true);
    const url = issueTrialLink(email, firstName ?? sent?.firstName ?? null).then(
      (link) => link.url,
    );
    copyWhenReady(url)
      .then(
        () => toast.success("Trial link copied"),
        (error: unknown) => {
          if (error instanceof CopyRefused) {
            // The link exists and is recorded; only the copy was refused, so show it to copy by hand.
            toast("Trial link ready", { description: error.text });
          } else {
            toast.error(
              error instanceof Error ? error.message : "Could not create the trial link.",
            );
          }
        },
      )
      .finally(() => {
        setCopying(false);
        void queryClient.invalidateQueries({ queryKey: [TRIAL_LINKS_KEY] });
      });
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {sent !== undefined && (
        <span className="text-muted-foreground">
          Trial link sent · {sent.scansUsed}/{sent.scansLimit} used
        </span>
      )}
      <button
        type="button"
        aria-label={`Copy trial link for ${email}`}
        className="font-medium underline underline-offset-2 disabled:opacity-50"
        disabled={copying}
        onClick={copy}
      >
        Copy trial link
      </button>
      {sent !== undefined && (
        <button
          type="button"
          aria-label={`Revoke trial link for ${email}`}
          className="font-medium text-destructive underline underline-offset-2 disabled:opacity-50"
          disabled={revoke.isPending}
          onClick={() => revoke.mutate()}
        >
          Revoke
        </button>
      )}
    </div>
  );
}
