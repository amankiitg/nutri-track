/**
 * The calories box shows whole kcal, and the item keeps the tenth it was computed to.
 *
 * Driven through the real input, keystroke by keystroke: rounding a controlled input is
 * exactly the kind of change that looks right with a clean value and rewrites a half-typed
 * one ("12." becoming "12"), so the chain of values on screen is asserted, not the end.
 */
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CookingFat } from "@shared/meal-parse";
import { reviewItemFromDraft, type ReviewItem } from "@/lib/review";
import { MealItemCard } from "./MealItemCard";

function draft(calories: number, fat: CookingFat | null = null) {
  return {
    name: "Dal tadka",
    quantity: 1,
    unit: "bowl",
    grams: 100,
    calories,
    protein_g: 10,
    carbs_g: 20,
    fat_g: 10,
    fiber_g: 5,
    sugar_g: 2,
    sodium_mg: 400,
    confidence: 0.7,
    cooking_fat: fat,
    needs_review: false,
    review_reasons: [],
  };
}

function Harness({ start, seen }: { start: ReviewItem; seen: ReviewItem[] }) {
  const [item, setItem] = useState(start);
  return (
    <MealItemCard
      item={item}
      index={0}
      onChange={(next) => {
        seen.push(next);
        setItem(next);
      }}
      onDelete={() => undefined}
    />
  );
}

const caloriesBox = () => screen.getByLabelText(/calories .* for item 1/i) as HTMLInputElement;

describe("the calories box", () => {
  it("shows a grams rescale in whole kcal and keeps the tenth on the item", async () => {
    const seen: ReviewItem[] = [];
    render(<Harness start={reviewItemFromDraft(draft(123) as never)} seen={seen} />);
    const user = userEvent.setup();

    const grams = screen.getByLabelText(/grams of item 1/i);
    await user.clear(grams);
    await user.type(grams, "45");
    await user.tab();

    const stored = seen.at(-1)?.calories ?? NaN;
    expect(Number.isInteger(stored)).toBe(false);
    expect(stored).toBeCloseTo(55.4, 1);
    expect(caloriesBox().value).toBe("55");
  });

  it("shows a fat-chip recompute in whole kcal and keeps the tenth on the item", async () => {
    const dressing: CookingFat = {
      type: "dressing",
      amount_tsp: 1,
      kcal_per_tsp: 12.5,
      fat_per_tsp: 1.4,
    };
    const seen: ReviewItem[] = [];
    render(<Harness start={reviewItemFromDraft(draft(200, dressing) as never)} seen={seen} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    await user.click(screen.getByRole("button", { name: "2 tsp" }));

    expect(seen.at(-1)?.calories).toBe(212.5);
    expect(caloriesBox().value).toBe("213");
  });

  it("shows what is typed while typing, stores it, and rounds it once the box is left", async () => {
    const seen: ReviewItem[] = [];
    render(<Harness start={reviewItemFromDraft(draft(200) as never)} seen={seen} />);
    const user = userEvent.setup();
    const box = caloriesBox();

    await user.click(box);
    expect(seen).toHaveLength(0);

    await user.clear(box);
    const shown: string[] = [];
    for (const key of ["1", "2", ".", "6"]) {
      await user.type(box, key);
      shown.push(box.value);
    }
    expect(shown).toEqual(["1", "12", "12.", "12.6"]);
    expect(seen.map((item) => item.calories)).toEqual([0, 1, 12, 12, 12.6]);

    await user.tab();
    expect(box.value).toBe("13");
    expect(seen.at(-1)?.calories).toBe(12.6);
  });
});
