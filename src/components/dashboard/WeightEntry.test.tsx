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
