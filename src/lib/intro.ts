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
 * How long the GIF fallback plays before the intro ends, in milliseconds: one loop of
 * meal-demo.gif, 18.41 s, the sum of its 221 frame delays, read on 2026-11-11. A video ends on
 * its own `ended` event (meal-demo.mp4 and meal-demo-short.mp4 are both 18.4 s, from their mvhd
 * boxes); a GIF loops and reports no end, so this is the GIF's alone. Replacing
 * meal-demo.gif means re-reading this.
 */
export const DEMO_GIF_DURATION_MS = 18_410;

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
 * What the intro may play, in order, and whether the GIF may stand in when no video plays.
 *
 * On data saver or a 3g-or-slower connection: the short cut only, and never the GIF (2.7 MB is
 * not something to start downloading for a visitor whose connection is already the problem).
 * If that cut is missing from the build, the full video is the one tried. On any other
 * connection: the full video, then the GIF.
 */
export function demoMedia(
  shortAvailable: boolean = DEMO_SHORT_AVAILABLE,
  slow: boolean = isSlowConnection(),
): { videos: string[]; allowGif: boolean } {
  if (slow) return { videos: [shortAvailable ? DEMO_SHORT_MP4 : DEMO_MP4], allowGif: false };
  return { videos: [DEMO_MP4], allowGif: true };
}

/**
 * The intro has this long from page load to be playing; after that the landing page shows.
 * 3 s, chosen rather than measured: the point is a bound, so that no connection waits on the
 * demo to see the page. Page load is navigation start, which is what performance.now() counts
 * from, so the bound includes the time spent downloading the app itself.
 */
export const INTRO_START_DEADLINE_MS = 3_000;

/** The clock the deadline reads. An object so a test can set it. */
export const pageClock = { now: (): number => performance.now() };

export function introDeadlinePassed(): boolean {
  return pageClock.now() >= INTRO_START_DEADLINE_MS;
}

/**
 * The landing page's visibility, kept on <html data-intro> rather than in React state, because
 * the decision has to be made before the app's JavaScript has arrived (on a slow connection
 * that takes far longer than 3 s). styles.css hides `.landing-gate` until the value is "skip".
 *
 *   pending  the gate script ran and the 3 s are counting
 *   playing  the demo started in time; the intro owns the screen
 *   skip     the landing page shows
 */
export function landingGate(): string | undefined {
  return document.documentElement.dataset["intro"];
}

/** Dispatched on window whenever one of these functions changes the gate, so readers that
 * were not the ones to change it (the install banner) can follow along. The inline gate script
 * changes the attribute without this event, but it runs before the app, so readers see its
 * value on their first read. */
export const INTRO_GATE_EVENT = "nutritrack:intro-gate";

function setLandingGate(value: "playing" | "skip"): void {
  document.documentElement.dataset["intro"] = value;
  window.dispatchEvent(new Event(INTRO_GATE_EVENT));
}

export function openLandingGate(): void {
  setLandingGate("skip");
}

/**
 * Marks the intro as on screen for a replay, which has no deadline and so never claims the
 * gate from "pending" the way the page-load intro does. The landing page's "Watch the demo"
 * calls this when it mounts the replay, so readers of the gate (the install banner) hide again
 * until the replay ends.
 */
export function openIntroGate(): void {
  setLandingGate("playing");
}

/** Claims the screen for the intro, unless the gate has already opened. Returns whether it did. */
export function claimLandingGate(): boolean {
  if (landingGate() === "skip") return false;
  setLandingGate("playing");
  return true;
}

/**
 * Runs inline in the landing page's <head>, as soon as the HTML arrives and long before the app
 * does. It opens the gate at once for a visitor who will not get the intro (seen this session,
 * or reduced motion), and otherwise opens it at the deadline unless the intro has claimed the
 * screen by then. The app repeats the same decision when it loads; this is what makes the page
 * visible on time when the app is slow. Any failure opens the gate.
 */
export const LANDING_GATE_SCRIPT = `(function(){var d=document.documentElement;try{
if(d.dataset.intro){return}
var seen=false;try{seen=sessionStorage.getItem(${JSON.stringify(INTRO_SEEN_KEY)})==="1"}catch(e){}
var reduce=window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches;
var left=${INTRO_START_DEADLINE_MS}-performance.now();
if(seen||reduce||left<=0){d.dataset.intro="skip";return}
d.dataset.intro="pending";
setTimeout(function(){if(d.dataset.intro!=="playing"){d.dataset.intro="skip"}},left);
}catch(e){d.dataset.intro="skip"}})();`;

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
