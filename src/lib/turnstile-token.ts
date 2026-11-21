/**
 * A fresh Cloudflare Turnstile token for each attempt that needs one.
 *
 * The bug this exists for: the widget was rendered once with `appearance: interaction-only`, which
 * shows nothing and produces nothing until Cloudflare decides a person has to act. Pressing the
 * button before that happened sent no `captchaToken` at all, so with Supabase CAPTCHA on, GoTrue
 * refused the sign-in and the screen said "Something went wrong". The token is also single use and
 * expires after about five minutes, so a token kept in state is spent after the first attempt and
 * stale after the fifth minute.
 *
 * So: ask at the moment of use, run the widget if it has not answered yet, wait a bounded time, and
 * throw the token away afterwards whether the attempt worked or not. Framework free on purpose, so
 * the waiting and the resetting can be tested without a browser.
 */

/** How long to wait for a token before going ahead without one. */
export const TURNSTILE_TIMEOUT_MS = 8000;

export interface TurnstileWidgetApi {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  execute(widgetId: string): void;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

export interface TurnstileTokenSourceOptions {
  /** Null when no site key is configured, which means no widget and no token. */
  siteKey: string | null;
  container: HTMLElement | null;
  load(): Promise<void>;
  api(): TurnstileWidgetApi | undefined;
  /** Injected so the tests do not wait eight real seconds. */
  timeoutMs?: number;
}

export interface TurnstileTokenSource {
  /**
   * A token for one attempt.
   *
   * Null means "send the request without one", which is right while Supabase CAPTCHA is off and
   * wrong while it is on; either way the request is the person's, and failing here would block a
   * sign-in the server might have accepted.
   */
  ensure(): Promise<string | null>;
  /** Forgets the token and resets the widget, so the next attempt gets a fresh one. */
  reset(): void;
  /** True when a token is already in hand, which is what the tests assert on. */
  hasToken(): boolean;
}

export function createTurnstileTokenSource(
  options: TurnstileTokenSourceOptions,
): TurnstileTokenSource {
  const timeoutMs = options.timeoutMs ?? TURNSTILE_TIMEOUT_MS;
  let token: string | null = null;
  let widgetId: string | null = null;
  let rendering: Promise<void> | null = null;
  let waiting: ((value: string | null) => void) | null = null;

  function settle(value: string | null): void {
    if (waiting !== null) {
      const resolve = waiting;
      waiting = null;
      resolve(value);
    }
  }

  function renderWidget(): Promise<void> {
    if (rendering !== null) return rendering;
    if (options.siteKey === null || options.container === null) {
      rendering = Promise.resolve();
      return rendering;
    }

    rendering = options
      .load()
      .then(() => {
        const api = options.api();
        if (api === undefined || options.container === null) return;
        if (widgetId !== null) return;
        widgetId = api.render(options.container, {
          sitekey: options.siteKey,
          appearance: "interaction-only",
          callback: (value: string) => {
            token = value;
            settle(value);
          },
          "error-callback": () => settle(null),
          "expired-callback": () => {
            token = null;
            settle(null);
          },
        });
      })
      .catch(() => {
        // No widget, no token: the caller sends the request without one.
      });

    return rendering;
  }

  async function ensure(): Promise<string | null> {
    if (token !== null) return token;
    await renderWidget();
    if (token !== null) return token;

    const api = options.api();
    if (api === undefined || widgetId === null) return null;

    const answer = new Promise<string | null>((resolve) => {
      waiting = resolve;
    });

    try {
      api.execute(widgetId);
    } catch {
      settle(null);
    }

    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeoutMs);
    });

    const value = await Promise.race([answer, timeout]);
    // The waiter is cleared either way, so a late callback cannot resolve a later attempt with an
    // old token.
    waiting = null;
    return value;
  }

  function reset(): void {
    token = null;
    const api = options.api();
    if (api === undefined || widgetId === null) return;
    try {
      api.reset(widgetId);
    } catch {
      // A widget that cannot reset is a widget whose token we have already dropped.
    }
  }

  return {
    ensure,
    reset,
    hasToken: () => token !== null,
  };
}
