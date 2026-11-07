/**
 * Today's date while the screen stays open.
 *
 * The bug was a phone left on the Today screen overnight: the day was computed once during a
 * render, so at 00:01 the screen still said yesterday and every query was still asking about it.
 * The same computation is reached two ways, and both are pinned here — the clock passing midnight,
 * and the app coming back to the foreground where the interval may never have run.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAY_CHECK_MS, useToday } from "./use-today";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  // jsdom's default, restored because one test overrides it.
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("useToday", () => {
  it("turns over at midnight, with no reload", () => {
    // Half a minute before midnight, so the rollover is reached by the ticker and not by luck.
    vi.setSystemTime(new Date("2026-11-06T23:59:30Z"));
    const { result } = renderHook(() => useToday("UTC"));
    expect(result.current).toBe("2026-11-06");

    act(() => {
      vi.advanceTimersByTime(DAY_CHECK_MS * 2);
    });

    expect(result.current).toBe("2026-11-07");
  });

  it("follows the profile's zone rather than the device's day", () => {
    // 02:00 UTC on the 7th is still the evening of the 6th in New York.
    vi.setSystemTime(new Date("2026-11-07T02:00:00Z"));
    const { result } = renderHook(() => useToday("America/New_York"));
    expect(result.current).toBe("2026-11-06");

    act(() => {
      // Past 05:00 UTC, which is midnight in New York in November.
      vi.advanceTimersByTime(3 * 60 * 60 * 1000);
    });

    expect(result.current).toBe("2026-11-07");
  });

  it("re-reads when the app comes back to the foreground", () => {
    vi.setSystemTime(new Date("2026-11-06T22:00:00Z"));
    const { result } = renderHook(() => useToday("UTC"));
    expect(result.current).toBe("2026-11-06");

    // The phone was asleep: the clock moved on and no timer fired, which is the case an
    // interval alone cannot cover.
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    vi.setSystemTime(new Date("2026-11-07T08:00:00Z"));
    expect(result.current).toBe("2026-11-06");

    act(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(result.current).toBe("2026-11-07");
  });

  it("does not churn on a tick that changed nothing", () => {
    // The state is only replaced when the day moves; a screen that re-rendered every thirty
    // seconds to say the same thing would be a cost with no reader.
    const renders: string[] = [];
    vi.setSystemTime(new Date("2026-11-06T10:00:00Z"));

    renderHook(() => {
      const day = useToday("UTC");
      renders.push(day);
      return day;
    });
    const afterFirstRender = renders.length;

    act(() => {
      vi.advanceTimersByTime(DAY_CHECK_MS * 4);
    });

    expect(renders.length).toBe(afterFirstRender);
  });

  it("stops ticking once the screen is gone", () => {
    vi.setSystemTime(new Date("2026-11-06T10:00:00Z"));
    const { result, unmount } = renderHook(() => useToday("UTC"));

    unmount();
    vi.setSystemTime(new Date("2026-11-07T10:00:00Z"));
    act(() => {
      vi.advanceTimersByTime(DAY_CHECK_MS * 2);
    });

    // Nothing was rendered after unmount, so the value never moved.
    expect(result.current).toBe("2026-11-06");
  });
});
