/**
 * The address an uninvited person can write to, with a way to copy it.
 *
 * One component because there are two refusal screens and they have to say the same thing: the
 * create-account form, where nobody is signed in, and `NotOnTheList`, which a refused Google
 * sign-in reaches. The second copy of this markup is how one screen gets a fix the other does not,
 * and these two screens are reached by the same person from two different doors.
 *
 * `select-all` is not decoration. If the clipboard is refused, selecting the address in one press
 * is the fallback the failure message points at; without it, copying by hand means selecting an
 * address a character at a time on a phone.
 */
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { INVITE_REQUEST_ADDRESS } from "@/lib/invite-request";

/**
 * How long the button reads "Copied" before going back to "Copy".
 *
 * Chosen, not measured: long enough to be read without looking for it, short enough that the
 * button is a fresh action by the time anybody presses it again.
 */
const COPY_CONFIRM_MS = 2000;

export function InviteAddress() {
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");

  // Back to "Copy" once the confirmation has been read. One timeout at a time, cleared when this
  // unmounts, which is the same shape as the resend countdown on the sign-in page: a stale timer
  // is how a label ends up saying something that is no longer true.
  useEffect(() => {
    if (copy !== "done") return;
    const timer = setTimeout(() => setCopy("idle"), COPY_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [copy]);

  async function copyAddress(): Promise<void> {
    try {
      // The clipboard needs a secure origin, which the app has in production and on localhost.
      // A browser can still refuse it, which is what the message below is for.
      await navigator.clipboard.writeText(INVITE_REQUEST_ADDRESS);
      setCopy("done");
    } catch {
      setCopy("failed");
    }
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">
        Or email{" "}
        <span className="font-medium text-foreground select-all">{INVITE_REQUEST_ADDRESS}</span>
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="rounded-full"
        onClick={() => void copyAddress()}
      >
        {copy === "done" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copy === "done" ? "Copied" : "Copy"}
      </Button>
      {copy === "failed" && (
        <p role="status" className="text-xs text-muted-foreground">
          This browser would not copy it. Select the address above and copy it by hand.
        </p>
      )}
    </div>
  );
}
