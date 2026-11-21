/**
 * The token source, without a browser.
 *
 * The bug it fixes was invisible to a test that only checked "a token is passed": the widget had
 * never produced one at the moment the button was pressed. So these tests are about *when* the
 * token is fetched, and about throwing it away afterwards.
 */
import { describe, expect, it, vi } from "vitest";
import { createTurnstileTokenSource, type TurnstileWidgetApi } from "./turnstile-token";

const CONTAINER = {} as HTMLElement;

/**
 * A widget that produces a token only when `execute` is called, which is what a real
 * `interaction-only` widget does.
 */
function fakeWidget(): {
  api: TurnstileWidgetApi;
  execute: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
} {
  let callback: ((token: string) => void) | null = null;
  const execute = vi.fn(() => {
    callback?.("token-from-execute");
  });
  const reset = vi.fn(() => {
    // A reset widget owes a fresh token on the next execute.
  });
  const render = vi.fn((_element: HTMLElement, options: Record<string, unknown>) => {
    callback = options["callback"] as (token: string) => void;
    return "widget-1";
  });
  return {
    api: { render, execute, reset, remove: vi.fn() } as TurnstileWidgetApi,
    execute,
    reset,
    render,
  };
}

describe("the Turnstile token source", () => {
  it("answers null when no site key is configured, and renders nothing", async () => {
    const widget = fakeWidget();
    const source = createTurnstileTokenSource({
      siteKey: null,
      container: CONTAINER,
      load: async () => {},
      api: () => widget.api,
    });

    expect(await source.ensure()).toBeNull();
    expect(widget.render).not.toHaveBeenCalled();
  });

  it("runs the widget at the moment of use, not at page load", async () => {
    const widget = fakeWidget();
    const load = vi.fn(async () => {});
    const source = createTurnstileTokenSource({
      siteKey: "site-key",
      container: CONTAINER,
      load,
      api: () => widget.api,
    });

    // Nothing has happened yet: no script, no widget.
    expect(load).not.toHaveBeenCalled();

    expect(await source.ensure()).toBe("token-from-execute");
    expect(load).toHaveBeenCalledTimes(1);
    expect(widget.execute).toHaveBeenCalledWith("widget-1");
    expect(source.hasToken()).toBe(true);
  });

  it("gives up after the timeout rather than holding the form", async () => {
    const render = vi.fn(() => "widget-1");
    const api = {
      render,
      execute: vi.fn(),
      reset: vi.fn(),
      remove: vi.fn(),
    } as unknown as TurnstileWidgetApi;
    const source = createTurnstileTokenSource({
      siteKey: "site-key",
      container: CONTAINER,
      load: async () => {},
      api: () => api,
      timeoutMs: 5,
    });

    expect(await source.ensure()).toBeNull();
    expect(source.hasToken()).toBe(false);
  });

  it("drops the spent token and resets the widget, so the next attempt is fresh", async () => {
    const widget = fakeWidget();
    let issued = 0;
    widget.render.mockImplementationOnce(
      (_element: HTMLElement, options: Record<string, unknown>) => {
        const callback = options["callback"] as (token: string) => void;
        widget.execute.mockImplementation(() => {
          issued += 1;
          callback(`token-${issued}`);
        });
        return "widget-1";
      },
    );

    const source = createTurnstileTokenSource({
      siteKey: "site-key",
      container: CONTAINER,
      load: async () => {},
      api: () => widget.api,
    });

    expect(await source.ensure()).toBe("token-1");
    source.reset();
    expect(widget.reset).toHaveBeenCalledWith("widget-1");
    expect(source.hasToken()).toBe(false);
    expect(await source.ensure()).toBe("token-2");
  });
});
