/** Registers the app-shell service worker in production builds only. */
export function registerServiceWorker() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  if (import.meta.env.DEV) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Service worker registration failed", err);
    });
  });
}

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
}

export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return true;
  // iPadOS 13 and later report a Macintosh user agent, so the user agent alone says Mac. A
  // touchscreen is what still separates an iPad from a Mac, and no Mac has one.
  return /macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
}

export type IosBrowser = "other" | "Chrome" | "Firefox" | "Edge" | "Opera";

/**
 * The iOS browsers that put a token of their own in the user agent.
 *
 * Kept to the ones that have used these tokens for years and are worth naming on sight. The list
 * cannot be complete, which is exactly why `iosBrowser` has an `"other"`.
 */
const IOS_BROWSER_TOKENS: ReadonlyArray<
  readonly [token: string, name: Exclude<IosBrowser, "other">]
> = [
  ["CriOS", "Chrome"],
  ["FxiOS", "Firefox"],
  ["EdgiOS", "Edge"],
  ["OPiOS", "Opera"],
];

/**
 * Which iOS browser this is, as far as a user agent can say.
 *
 * Every browser on iOS runs WebKit, so the engine tells them apart not at all and the user agent
 * token is the only signal. That makes this asymmetric, and the asymmetry is the point:
 *
 *  - A token for one of these is good evidence. It is the browser's own name for itself.
 *  - **No** token is not evidence of Safari. Choosing "Request Desktop Website" replaces the user
 *    agent with a desktop one and drops the token, and anything not on the list is unknown.
 *
 * So `"other"` means "not one I can name", never "Safari". Add to Home Screen happens not to
 * exist in any of them, but the copy still has to work when this cannot tell, which is why it
 * names Safari rather than describing the browser the reader is already in.
 */
export function iosBrowser(userAgent: string): IosBrowser {
  for (const [token, name] of IOS_BROWSER_TOKENS) {
    if (userAgent.includes(token)) return name;
  }
  return "other";
}

/**
 * One line for an iOS reader, naming Safari.
 *
 * Add to Home Screen exists only in Safari on iOS, so a reader in Chrome is being pointed at a
 * Share button that cannot do it. They are told to get to Safari instead of being given steps
 * for a browser they are not in.
 *
 * The first sentence for an unnamed browser carries its own escape clause on purpose: an in-app
 * browser, which is where a link in an email opens, reports a Safari-like user agent and has no
 * Share button, and that is not something detection can resolve. A reader who finds no Share
 * button is therefore told what to do about it rather than left looking.
 */
export function iosInstallHint(browser: IosBrowser): string {
  if (browser === "other") {
    return (
      "Tap Share, then scroll to Add to Home Screen. Safari only, so open tracknutri.app in " +
      "Safari if there is no Share button."
    );
  }
  return (
    `${browser} cannot add apps to the home screen. Open tracknutri.app in Safari, then tap ` +
    "Share and scroll to Add to Home Screen."
  );
}

/**
 * How long the install banner waits after the landing page becomes visible before it appears,
 * so it does not pop up the instant the intro's fade ends. 1.5 s, chosen not measured: long
 * enough for the page's own entrance to be read, short enough that the banner still arrives
 * before the reader leaves.
 */
export const INSTALL_BANNER_DELAY_MS = 1_500;

/**
 * Whether the landing intro still owns the screen, as the install banner reads the gate on
 * <html data-intro>. "pending" is the 3 s window before the demo has claimed the screen, when
 * the page is still hidden, so the banner waits through it too.
 */
export function introOwnsScreen(gate: string | undefined): boolean {
  return gate === "pending" || gate === "playing";
}

/**
 * How long the banner waits before it may show, given the gate. "skip" is the landing page
 * itself, so the banner gives the page's entrance a beat; undefined is another route, which has
 * no intro and no wait.
 */
export function installBannerDelayMs(gate: string | undefined): number {
  return gate === "skip" ? INSTALL_BANNER_DELAY_MS : 0;
}
