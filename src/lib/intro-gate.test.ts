/**
 * The inline gate script, run as the browser runs it: as plain script text, before the app.
 * It decides when the landing page becomes visible on a connection where the app has not
 * arrived yet, so it is tested on its own rather than through the React page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTRO_SEEN_KEY, LANDING_GATE_SCRIPT } from "./intro";

const realMatchMedia = window.matchMedia;

function runGate(options: { pageAge?: number; reducedMotion?: boolean } = {}) {
  vi.spyOn(performance, "now").mockReturnValue(options.pageAge ?? 400);
  window.matchMedia = ((query: string) => ({
    matches: query.includes("reduce") ? (options.reducedMotion ?? false) : false,
  })) as unknown as typeof window.matchMedia;
  new Function(LANDING_GATE_SCRIPT)();
}

const gate = () => document.documentElement.dataset["intro"];

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  document.documentElement.removeAttribute("data-intro");
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the landing gate script", () => {
  it("holds the page for what is left of 3 s from page load, then shows it", () => {
    runGate({ pageAge: 400 });
    expect(gate()).toBe("pending");
    vi.advanceTimersByTime(2_599);
    expect(gate()).toBe("pending");
    vi.advanceTimersByTime(1);
    expect(gate()).toBe("skip");
  });

  it("leaves the screen to the intro when it claimed it in time", () => {
    runGate({ pageAge: 400 });
    document.documentElement.dataset["intro"] = "playing";
    vi.advanceTimersByTime(10_000);
    expect(gate()).toBe("playing");
  });

  it("shows the page at once when the intro was already seen this session", () => {
    sessionStorage.setItem(INTRO_SEEN_KEY, "1");
    runGate();
    expect(gate()).toBe("skip");
  });

  it("shows the page at once with reduced motion", () => {
    runGate({ reducedMotion: true });
    expect(gate()).toBe("skip");
  });

  it("shows the page at once when it runs after the 3 s are already up", () => {
    runGate({ pageAge: 3_200 });
    expect(gate()).toBe("skip");
  });

  it("does not undo a decision already made on this document", () => {
    document.documentElement.dataset["intro"] = "playing";
    runGate();
    expect(gate()).toBe("playing");
  });
});
