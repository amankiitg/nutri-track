/**
 * What the weight box shows for a weigh-in that has been round-tripped.
 *
 * The value that comes back is not the value that was typed, and it cannot be: pounds are
 * converted to kilograms, the column holds two decimals of them, and 0.01 kg is 0.022 lb. That
 * pins pounds to about ±0.011 lb, so a second decimal of pounds is finer than the thing being
 * displayed — 174.6 lb is stored as 79.20 kg, which comes back as 174.606, and printing that to
 * two decimals said "174.61".
 *
 * Rendered rather than asserted against a helper, because the arithmetic was never wrong: the
 * conversion is right and the round trip is faithful. What was wrong was showing a digit the
 * stored number does not have, and that only exists on screen.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { lbToKg } from "@/lib/units";
import { WeightEntry } from "./WeightEntry";

/** 79.20 kg is the stored form of 174.6 lb — the reported case. */
const STORED_KG = 79.2;

function renderCard(weightKg: number, unitSystem: "metric" | "imperial") {
  const onSave = vi.fn();
  render(
    <WeightEntry
      entries={[{ logged_on: "2026-09-26", weight_kg: weightKg, waist_cm: null }]}
      unitSystem={unitSystem}
      onSave={onSave}
      saving={false}
    />,
  );
  return { onSave };
}

describe("the weight box for a stored weigh-in", () => {
  it("shows a pound to one decimal, because one is all the stored kilogram supports", () => {
    renderCard(STORED_KG, "imperial");

    expect(screen.getByLabelText(/weight \(lb\)/i)).toHaveValue("174.6");
    expect(screen.queryByDisplayValue("174.61")).toBeNull();
  });

  it("shows the same number on the line above, not a more precise one", () => {
    renderCard(STORED_KG, "imperial");

    expect(screen.getByText(/174\.6 lb/)).toBeInTheDocument();
    expect(screen.queryByText(/174\.61/)).toBeNull();
  });

  it("keeps two decimals for kilograms, where the stored value is the answer", () => {
    renderCard(79.25, "metric");

    expect(screen.getByLabelText(/weight \(kg\)/i)).toHaveValue("79.25");
  });

  it("still stores the same kilograms, so the display change moves nothing", async () => {
    const { onSave } = renderCard(STORED_KG, "imperial");
    const user = userEvent.setup();

    // Typed as the person would: the box is prefilled, so it is cleared first.
    const input = screen.getByLabelText(/weight \(lb\)/i);
    await user.clear(input);
    await user.type(input, "174.6{Enter}");

    // 174.6 lb is 79.197... kg, and the column takes two decimals.
    expect(onSave).toHaveBeenCalledWith({ weightKg: 79.2 });
  });
});

/**
 * The change line, rendered.
 *
 * The arithmetic was never the visible bug: 0.45 kg of stored difference is the right number.
 * What was wrong was rounding it in kilograms and then converting, which put a digit on screen
 * that neither weigh-in supports.
 */
describe("the change since the previous weigh-in", () => {
  /** What the column holds for a pound reading: kilograms to two decimals. */
  const stored = (lb: number) => Number(lbToKg(lb).toFixed(2));

  function renderDelta(
    entries: { logged_on: string; weight_kg: number }[],
    units: "metric" | "imperial",
  ) {
    render(
      <WeightEntry
        entries={entries.map((entry) => ({ ...entry, waist_cm: null }))}
        unitSystem={units}
        onSave={vi.fn()}
        saving={false}
      />,
    );
  }

  it("shows a pound of change as 1.0 lb, not 1.1", () => {
    // The reported case: 167.6 lb, then 166.6 lb the next day.
    renderDelta(
      [
        { logged_on: "2026-09-27", weight_kg: stored(166.6) },
        { logged_on: "2026-09-26", weight_kg: stored(167.6) },
      ],
      "imperial",
    );

    expect(screen.getByText(/−1\.0 lb/)).toBeInTheDocument();
    expect(screen.queryByText(/1\.1 lb/)).toBeNull();
  });

  it("shows half a kilogram as 0.50 kg", () => {
    renderDelta(
      [
        { logged_on: "2026-09-27", weight_kg: 75.5 },
        { logged_on: "2026-09-26", weight_kg: 76 },
      ],
      "metric",
    );

    expect(screen.getByText(/−0\.50 kg/)).toBeInTheDocument();
  });

  it("says nothing when the two weigh-ins are the same", () => {
    renderDelta(
      [
        { logged_on: "2026-09-27", weight_kg: 76 },
        { logged_on: "2026-09-26", weight_kg: 76 },
      ],
      "imperial",
    );

    expect(screen.queryByText(/since the one before/)).toBeNull();
  });
});
