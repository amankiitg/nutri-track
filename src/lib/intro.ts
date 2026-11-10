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

export const DEMO_MP4 = "/demo/meal-demo.mp4";
export const DEMO_SHORT_MP4 = "/demo/meal-demo-short.mp4";
export const DEMO_GIF = "/demo/meal-demo.gif";

/** Set by vite.config.ts when public/demo/meal-demo-short.mp4 exists at build time. */
export const DEMO_SHORT_AVAILABLE = import.meta.env["DEMO_SHORT_MP4"] === "1";

/** The part of the Network Information API this reads; not in TypeScript's DOM types. */
interface ConnectionHint {
  saveData?: boolean;
  effectiveType?: string;
}

function navigatorConnection(): ConnectionHint | undefined {
  try {
    return (navigator as Navigator & { connection?: ConnectionHint }).connection;
  } catch {
    return undefined;
  }
}

/**
 * Data saver on, or a connection the browser rates as 3g or slower. Chromium-family browsers
 * report this; Safari and Firefox do not, so there it is always false and the full demo plays.
 * slow-2g is included with 2g: it is the slower of the two.
 */
export function isSlowConnection(connection: ConnectionHint | undefined = navigatorConnection()) {
  if (connection === undefined) return false;
  return (
    connection.saveData === true || ["slow-2g", "2g", "3g"].includes(connection.effectiveType ?? "")
  );
}

/**
 * The videos to try, in order. The GIF is not in this list: it is the last fallback, taken when
 * every video here fails or the browser refuses to autoplay one.
 */
export function demoVideoSources(
  shortAvailable: boolean = DEMO_SHORT_AVAILABLE,
  slow: boolean = isSlowConnection(),
): string[] {
  return shortAvailable && slow ? [DEMO_SHORT_MP4, DEMO_MP4] : [DEMO_MP4];
}

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
