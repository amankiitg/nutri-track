/**
 * Whether the landing page opens with the demo intro.
 *
 * Once per browser session: the flag lives in sessionStorage, so a new tab or a reopened
 * browser plays it again and a reload does not. Reduced motion skips it entirely. Both
 * reads are browser-only, so the landing page calls these from an effect, never while
 * rendering (the page is server-rendered, and the first paint must match on both sides).
 */

export const INTRO_SEEN_KEY = "nt:intro-seen";

/**
 * The length of the demo, in milliseconds: 13.6 s, read from meal-demo.mp4's mvhd box and
 * from the sum of meal-demo.gif's frame delays (both agree) on 2026-11-09. The video ends
 * on its own `ended` event; this is only for the GIF fallback, which loops and has none.
 * Replacing the demo files means re-reading this.
 */
export const DEMO_DURATION_MS = 13_600;

type Store = Pick<Storage, "getItem" | "setItem">;

function sessionStore(): Store | null {
  try {
    return window.sessionStorage;
  } catch {
    // Blocked storage (private mode, a sandboxed frame) throws on access.
    return null;
  }
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function shouldPlayIntro(
  store: Store | null = sessionStore(),
  reducedMotion: boolean = prefersReducedMotion(),
): boolean {
  if (reducedMotion) return false;
  try {
    return store?.getItem(INTRO_SEEN_KEY) !== "1";
  } catch {
    return true;
  }
}

export function markIntroSeen(store: Store | null = sessionStore()): void {
  try {
    store?.setItem(INTRO_SEEN_KEY, "1");
  } catch {
    // Unwritable storage means the intro may play again on reload; nothing worse.
  }
}
