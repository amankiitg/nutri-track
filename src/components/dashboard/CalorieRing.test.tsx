/**
 * The ring's move to a new value, and the one thing it must never do.
 *
 * The number and the arc travel together from whatever was on screen to what the meal just
 * added, so the screen answers "how much did that change things?" rather than replacing one
 * static number with another. With `prefers-reduced-motion` there is no travel at all.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalorieRing } from "./CalorieRing";

const realMatchMedia = window.matchMedia;

function setReducedMotion(reduced: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: reduced && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  setReducedMotion(false);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = realMatchMedia;
});

describe("the calorie ring", () => {
  it("draws the value it is given on the first paint", () => {
    render(<CalorieRing consumed={400} target={2000} />);

    expect(screen.getByText("400")).toBeInTheDocument();
  });

  it("counts up to the new value instead of replacing it", () => {
    const { rerender } = render(<CalorieRing consumed={400} target={2000} />);
    rerender(<CalorieRing consumed={900} target={2000} />);

    // Part way through the 600 ms ease, the number is between the two values.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("400")).not.toBeInTheDocument();
    expect(screen.queryByText("900")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByText("900")).toBeInTheDocument();
  });

  it("still says what is left of the day while the number is moving", () => {
    const { rerender } = render(<CalorieRing consumed={400} target={2000} />);
    rerender(<CalorieRing consumed={900} target={2000} />);

    // The spoken summary is the final value, not a fraction of it.
    expect(screen.getByRole("img")).toHaveAccessibleName(/900 of 2000 kcal, 1100 remaining/);
  });

  it("jumps straight to the new value when motion is reduced", () => {
    setReducedMotion(true);
    const { rerender } = render(<CalorieRing consumed={400} target={2000} />);
    rerender(<CalorieRing consumed={900} target={2000} />);

    expect(screen.getByText("900")).toBeInTheDocument();
  });
});
