/**
 * The notice a goal shows once its target is behind you.
 *
 * One component for the two screens that need it: the goal group in settings and onboarding, where
 * the button only changes the form so the next Save writes it, and Today, where the tap is the
 * save. The sentence is the same in both, and so is the reason it exists: a deficit that has
 * already done its job is now just an appetite, and the app should say so rather than keeping
 * quiet and letting somebody keep losing weight they did not mean to.
 */
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function TargetReachedNotice({
  onSwitch,
  pending = false,
}: {
  /** Puts the goal on Maintain. Whether that saves immediately is the caller's business. */
  onSwitch: () => void;
  /** True while a screen that saves on the tap is doing so. */
  pending?: boolean;
}) {
  return (
    <div
      role="status"
      className="rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm text-foreground"
    >
      <p>You&apos;re at your target weight. Switch to Maintain to stop the deficit.</p>
      <Button
        // Inside a form, so this must never be the thing that submits it.
        type="button"
        size="sm"
        className="mt-2 rounded-full"
        disabled={pending}
        onClick={onSwitch}
      >
        {pending && <Loader2 className="animate-spin" />}
        Switch to Maintain
      </Button>
    </div>
  );
}
