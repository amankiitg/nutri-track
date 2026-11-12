/**
 * The macro bars' colours on Today.
 *
 * The rule this file pins: a bar that has gone over its target keeps the macro's own colour —
 * protein blue, carbs amber, fat violet — exactly as it has under target, and the number beside it
 * stays the same. Only the "+N g over" line under the bar changes colour.
 *
 * There was no test here before, which is why the old behaviour could be the opposite of this and
 * nothing said so. The bar had been repainted `bg-destructive` when over, and the grams value went
 * red with it, so one glance said "protein is a problem" instead of "protein".
 *
 * Tested by class rather than by pixel: jsdom has no layout engine, so the colour is the assertion
 * that can actually be made. The classes come from the macro table, so a change to the palette
 * fails here on purpose — the palette is the thing being promised.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MacroBars, VerdictLine } from "./MacroBars";
import type { DailyTotals, WeekVerdict } from "@/lib/dashboard";

function totals(over: Partial<DailyTotals> = {}): DailyTotals {
  return {
    local_date: "2026-11-07",
    meal_count: 2,
    calories: 1200,
    protein_g: 60,
    carbs_g: 120,
    fat_g: 40,
    fiber_g: 12,
    target_calories: 1771,
    target_protein_g: 112,
    target_carbs_g: 180,
    target_fat_g: 60,
    remaining_calories: 571,
    status: null,
    ...over,
  };
}

/** The filled part of one macro's bar, found through the progressbar it sits in. */
function barFill(label: string): HTMLElement {
  const track = document.querySelector<HTMLElement>(
    `[role="progressbar"][aria-label^="${label}:"]`,
  );
  if (track === null) throw new Error(`no progressbar for ${label}`);
  const fill = track.firstElementChild;
  if (!(fill instanceof HTMLElement)) throw new Error(`no fill inside ${label}'s bar`);
  return fill;
}

/** The value beside the label, e.g. the "210 g" in "210 g / 112 g". */
function gramsValue(container: HTMLElement, label: string): HTMLElement {
  const term = [...container.querySelectorAll("dt")].find((node) => node.textContent === label);
  if (term === undefined) throw new Error(`no row for ${label}`);
  const value = term.nextElementSibling?.querySelector("span");
  if (!(value instanceof HTMLElement)) throw new Error(`no value for ${label}`);
  return value;
}

describe("MacroBars colours", () => {
  it("keeps each bar its own colour under target", () => {
    const { container } = render(<MacroBars totals={totals()} fiberTarget={30} />);

    expect(barFill("Protein").className).toContain("bg-sky-500");
    expect(barFill("Carbs").className).toContain("bg-amber-500");
    expect(barFill("Fat").className).toContain("bg-violet-500");
    expect(container.innerHTML).not.toContain("bg-destructive");
  });

  it("keeps the same colour when the macro is well over target", () => {
    // 167% of protein, the fat day that started this: the bar is still protein-blue.
    const { container } = render(
      <MacroBars totals={totals({ protein_g: 187 })} fiberTarget={30} />,
    );

    expect(barFill("Protein").className).toContain("bg-sky-500");
    expect(barFill("Protein").className).not.toContain("bg-destructive");
    expect(container.innerHTML).not.toContain("bg-destructive");
  });

  it("does not recolour the grams value when the macro is over", () => {
    const { container } = render(
      <MacroBars totals={totals({ protein_g: 187 })} fiberTarget={30} />,
    );

    expect(gramsValue(container, "Protein").className).toBe("text-foreground");
  });

  it("puts the red on the over line, and only there", () => {
    const { container } = render(
      <MacroBars totals={totals({ protein_g: 187 })} fiberTarget={30} />,
    );

    const over = [...container.querySelectorAll("p")].filter(
      (node) => node.textContent?.includes("g over") === true,
    );
    expect(over).toHaveLength(1);
    expect(over[0]?.className).toContain("text-destructive");
    // 187 of 112 is 167%, past the 110% line, so this is the red level.
    expect(over[0]?.textContent).toBe("+75 g over");
  });

  it("uses amber for the first ten per cent past target and red beyond it", () => {
    // 116 of 112 is 103.6%: over, but inside the 10% band, so the line warns rather than shouts.
    const justOver = render(<MacroBars totals={totals({ protein_g: 116 })} fiberTarget={30} />);
    const near = [...justOver.container.querySelectorAll("p")].find(
      (node) => node.textContent?.includes("g over") === true,
    );
    expect(near?.className).toContain("text-amber-600");
    expect(near?.className).not.toContain("text-destructive");
    // And the bar is still blue at that point, unchanged by the warning.
    expect(barFill("Protein").className).toContain("bg-sky-500");
    justOver.unmount();
  });

  it("shows no over line when every macro is under", () => {
    const { container } = render(<MacroBars totals={totals()} fiberTarget={30} />);

    expect(container.textContent ?? "").not.toContain("g over");
  });

  it("draws no bar for a macro with no target, rather than an empty one", () => {
    const { container } = render(
      <MacroBars totals={totals({ target_fat_g: null })} fiberTarget={30} />,
    );

    expect(
      container.querySelector('[role="progressbar"][aria-label^="Fat:"]')?.children,
    ).toHaveLength(0);
  });
});

describe("the fibre bar", () => {
  it("has its own green and sits under Fat", () => {
    const { container } = render(<MacroBars totals={totals()} fiberTarget={30} />);

    expect(barFill("Fibre").className).toContain("bg-[#3DAA5C]");
    const labels = [...container.querySelectorAll("dt")].map((node) => node.textContent);
    expect(labels.indexOf("Fibre")).toBeGreaterThan(labels.indexOf("Fat"));
  });

  it("never warns when fibre is over target", () => {
    const { container } = render(<MacroBars totals={totals({ fiber_g: 42 })} fiberTarget={30} />);

    expect(container.textContent ?? "").not.toContain("g over");
    expect(barFill("Fibre").className).toContain("bg-[#3DAA5C]");
  });
});

const verdict = (over: Partial<WeekVerdict> = {}): WeekVerdict => ({
  window_days: 7,
  window_start: "2026-11-05",
  window_end: "2026-11-11",
  days_logged: 7,
  days_judged: 7,
  days_on_track: 5,
  avg_calories: 1800,
  avg_target_calories: 1800,
  avg_protein_g: 110,
  avg_target_protein_g: 112,
  avg_fiber_g: 12,
  avg_target_fiber_g: 30,
  verdict: "on_track",
  ...over,
});

describe("the seven-day fibre line", () => {
  it("averages fibre against the target under the protein line", () => {
    render(<VerdictLine verdict={verdict()} />);

    expect(screen.getByText(/Fibre averaging 12 g against 30 g\./)).toBeInTheDocument();
  });
});
