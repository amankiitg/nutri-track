import { useEffect, useState } from "react";
import { Download, Share, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { INTRO_GATE_EVENT } from "@/lib/intro";
import {
  installBannerDelayMs,
  introOwnsScreen,
  iosBrowser,
  iosInstallHint,
  isIos,
  isStandalone,
  type BeforeInstallPromptEvent,
  type IosBrowser,
} from "@/lib/pwa";

export const DISMISS_KEY = "nutritrack.install.dismissed";

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [ios, setIos] = useState<IosBrowser | null>(null);
  const [dismissed, setDismissed] = useState(true);
  // The landing page's intro gate on <html data-intro>: "pending" and "playing" hold the
  // screen, "skip" is the page. undefined means this is not the landing page, so the intro
  // gate does not apply.
  const [gate, setGate] = useState<string | undefined>(undefined);
  // Whether the delay after the landing page became visible has elapsed.
  const [delayElapsed, setDelayElapsed] = useState(false);

  useEffect(() => {
    if (isStandalone()) return;
    setDismissed(window.localStorage.getItem(DISMISS_KEY) === "1");
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    if (isIos()) setIos(iosBrowser(window.navigator.userAgent));
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  // Hold the banner back until the landing page has been visible for a moment, and hide it
  // again whenever an intro (including a replay) takes the screen. The gate is written to
  // <html data-intro> by the landing page rather than React state, so it is observed here
  // rather than received as a prop.
  useEffect(() => {
    const root = document.documentElement;
    let timer: number | undefined;

    const apply = (value: string | undefined) => {
      window.clearTimeout(timer);
      timer = undefined;
      setGate(value);
      if (introOwnsScreen(value)) {
        setDelayElapsed(false);
        return;
      }
      const wait = installBannerDelayMs(value);
      if (wait === 0) {
        setDelayElapsed(true);
        return;
      }
      timer = window.setTimeout(() => {
        setDelayElapsed(true);
        timer = undefined;
      }, wait);
    };

    const read = () => apply(root.dataset["intro"]);
    read();
    window.addEventListener(INTRO_GATE_EVENT, read);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(INTRO_GATE_EVENT, read);
    };
  }, []);

  if (dismissed || (!deferred && ios === null)) return null;
  if (introOwnsScreen(gate) || !delayElapsed) return null;

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
            ios !== null && (
              <p className="text-sm text-muted-foreground">
                {/* The glyph is the button the copy names, so it goes in front of the sentence
                    that tells them to tap it, and not in front of one that says their browser
                    cannot do this at all. */}
                {ios === "other" && (
                  <>
                    <Share className="inline size-4 align-text-bottom" aria-label="Share" />{" "}
                  </>
                )}
                {iosInstallHint(ios)}
              </p>
            )
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
