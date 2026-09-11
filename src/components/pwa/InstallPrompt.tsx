import { useEffect, useState } from "react";
import { Download, Share, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isIos, isStandalone, type BeforeInstallPromptEvent } from "@/lib/pwa";

const DISMISS_KEY = "nutritrack.install.dismissed";

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (isStandalone()) return;
    setDismissed(window.localStorage.getItem(DISMISS_KEY) === "1");
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    if (isIos()) setShowIosHint(true);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  if (dismissed || (!deferred && !showIosHint)) return null;

  const dismiss = () => {
    window.localStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === "accepted") setDismissed(true);
    setDeferred(null);
  };

  return (
    <div
      role="dialog"
      aria-label="Install NutriTrack"
      className="fixed inset-x-0 bottom-0 z-50 mx-auto max-w-[30rem] p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] animate-rise"
    >
      <div className="card-soft flex items-start gap-3 p-4">
        <img src="/icons/icon-192.png" alt="" width={44} height={44} className="rounded-xl" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Add NutriTrack to your home screen</p>
          {deferred ? (
            <p className="text-sm text-muted-foreground">Opens full-screen, works like an app.</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Tap <Share className="inline size-4 align-text-bottom" aria-label="Share" /> then{" "}
              <span className="font-medium text-foreground">Add to Home Screen</span>.
            </p>
          )}
          {deferred && (
            <Button size="sm" className="mt-3" onClick={install}>
              <Download /> Install
            </Button>
          )}
        </div>
        <Button variant="ghost" size="icon" aria-label="Dismiss" onClick={dismiss}>
          <X />
        </Button>
      </div>
    </div>
  );
}
