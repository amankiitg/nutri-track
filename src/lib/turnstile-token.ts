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
  /**
   * Where to mount the widget, asked at the moment of use rather than captured once.
   *
   * This is the second half of the bug: the container was read when the page mounted, and React
   * removed it as soon as the sign-in step changed, so later attempts rendered a widget into a
   * node that was no longer in the document and got no token back. A getter means the widget
   * always attaches to the node that exists now, and a remount is handled below.
   */
  container: () => HTMLElement | null;
  load(): Promise<void>;
  api(): TurnstileWidgetApi | undefined;
  /** Injected so the tests do not wait eight real seconds. */
  timeoutMs?: number;
}

/**
 * Thrown when CAPTCHA is on and the widget would not produce a token.
 *
 * The distinction this exists for: with CAPTCHA on, a request sent without a token is a request
 * GoTrue refuses, and the person is told "something went wrong" about a sign-in that never left the
 * screen. With no token there is nothing worth sending, so the caller stops and asks them to tap
 * again rather than sending a request that cannot succeed.
 */
export class CaptchaUnavailableError extends Error {
  constructor() {
    super("CAPTCHA is on and no token was produced");
    this.name = "CaptchaUnavailableError";
  }
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
  /** The element the current widget was rendered into, so a remount is detectable. */
  let mountedIn: HTMLElement | null = null;
  let rendering: Promise<void> | null = null;
  let waiting: ((value: string | null) => void) | null = null;

  function settle(value: string | null): void {
    if (waiting !== null) {
      const resolve = waiting;
      waiting = null;
      resolve(value);
    }
  }

  /** Forgets a widget whose container has left the document, so a fresh one can be made. */
  function dropStaleWidget(): void {
    const container = options.container();
    if (widgetId === null) return;
    if (mountedIn !== null && mountedIn === container && container.isConnected) return;
    const api = options.api();
    if (api !== undefined) {
      try {
        api.remove(widgetId);
      } catch {
        // A widget already gone is a widget already gone.
      }
    }
    widgetId = null;
    mountedIn = null;
    token = null;
    // The render promise is cached too, so a fresh widget needs a fresh promise or the old one
    // answers "already rendered" and nothing mounts.
    rendering = null;
  }

  function renderWidget(): Promise<void> {
    if (rendering !== null) return rendering;
    const container = options.container();
    if (options.siteKey === null || container === null) {
      rendering = Promise.resolve();
      return rendering;
    }

    rendering = options
      .load()
      .then(() => {
        const api = options.api();
        const target = options.container();
        if (api === undefined || target === null) return;
        if (widgetId !== null) return;
        mountedIn = target;
        widgetId = api.render(target, {
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

  /**
   * One bounded wait for the widget: run it, and give up when the timeout passes.
   *
   * Null means the widget said nothing in time, which is the caller's cue to try once more or to
   * stop. The waiter is cleared either way, so a late callback cannot resolve a later attempt with
   * an old token.
   */
  async function waitForToken(): Promise<string | null> {
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
    waiting = null;
    return value;
  }

  async function ensure(): Promise<string | null> {
    dropStaleWidget();
    if (token !== null) return token;
    await renderWidget();
    if (token !== null) return token;

    // No site key is CAPTCHA off: there is no widget and nothing to wait for, so the request goes
    // out without a token, which is what this app did before CAPTCHA existed.
    if (options.siteKey === null) return null;

    const first = await waitForToken();
    if (first !== null) return first;

    // One re-trigger, and only one. A widget that has not answered by now is usually one that had
    // not finished loading when the button was pressed, and pressing it again behind the scenes is
    // what turns a dead press into a working one. The second wait is the same bound as the first.
    dropStaleWidget();
    await renderWidget();
    const second = await waitForToken();
    if (second !== null) return second;

    // CAPTCHA is on and there is still nothing to send. Callers stop here rather than sending a
    // request GoTrue will refuse for the missing token.
    throw new CaptchaUnavailableError();
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
