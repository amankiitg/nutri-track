/**
 * The Cloudflare Turnstile widget, loaded and rendered by hand.
 *
 * The site key is a VITE_ value (public, shipped in the bundle); the secret lives only
 * on the server. With no site key the trial page shows "Trial unavailable right now"
 * rather than running a funnel whose proof of humanity is missing.
 */

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let scriptPromise: Promise<void> | null = null;

export function turnstileSiteKey(): string | null {
  const key = import.meta.env["VITE_TURNSTILE_SITE_KEY"];
  return typeof key === "string" && key.trim() !== "" ? key.trim() : null;
}

/** Loads the Turnstile script once. Resolves even if the script is already present. */
export function loadTurnstile(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (scriptPromise !== null) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(
      'script[src^="https://challenges.cloudflare.com/turnstile/v0/api.js"]',
    );
    if (existing !== null) {
      resolve();
      return;
    }

    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error("Turnstile did not load"));
    };
    document.head.appendChild(script);
  });

  return scriptPromise;
}

export interface TurnstileApi {
  render(element: HTMLElement, options: Record<string, unknown>): string;
  remove(widgetId: string): void;
}

export function turnstileApi(): TurnstileApi | undefined {
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile;
}
