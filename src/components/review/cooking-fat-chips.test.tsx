/**
 * The hidden-fat line: a quiet "Includes ~... tbsp ..." summary for items the model
 * cooked or dressed with fat, an "Adjust" toggle that reveals the correction chips,
 * and the local recompute behind each chip.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CookingFat } from "@shared/meal-parse";
import { reviewItemFromDraft } from "@/lib/review";
import { MealItemCard } from "./MealItemCard";

function draft(name: string, fat: CookingFat | null) {
  return {
    name,
    quantity: 1,
    unit: "bowl",
    grams: 250,
    calories: 200,
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
  } as const;
}

describe("hidden fat line", () => {
  it("shows the quiet line for a curry and nothing for an apple", () => {
    const { rerender } = render(
      <MealItemCard
        item={reviewItemFromDraft(
          draft("Chicken curry", {
            type: "oil",
            amount_tsp: 3,
            kcal_per_tsp: null,
            fat_per_tsp: null,
          }) as never,
        )}
        index={0}
        onChange={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText(/Includes ~1 tbsp oil \(estimated\)/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Adjust" })).toBeTruthy();

    rerender(
      <MealItemCard
        item={reviewItemFromDraft(draft("Apple", null) as never)}
        index={0}
        onChange={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Includes/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Adjust" })).toBeNull();
  });

  it("is collapsed by default and expands on Adjust", async () => {
    const user = userEvent.setup();
    render(
      <MealItemCard
        item={reviewItemFromDraft(
          draft("Dal tadka", {
            type: "oil",
            amount_tsp: 3,
            kcal_per_tsp: null,
            fat_per_tsp: null,
          }) as never,
        )}
        index={0}
        onChange={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "None" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Oil" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Adjust" }));
    expect(screen.getByRole("button", { name: "None" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1 tsp" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "2 tsp" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1 tbsp" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Oil" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ghee" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Butter" })).toBeTruthy();
  });

  it("picking a tablespoon updates kcal and fat, then collapses", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <MealItemCard
        item={reviewItemFromDraft(
          draft("Dal tadka", {
            type: "oil",
            amount_tsp: 1,
            kcal_per_tsp: null,
            fat_per_tsp: null,
          }) as never,
        )}
        index={0}
        onChange={onChange}
        onDelete={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    await user.click(screen.getByRole("button", { name: "1 tbsp" }));

    const next = onChange.mock.calls[0]![0];
    expect(next.cooking_fat).toEqual({
      type: "oil",
      amount_tsp: 3,
      kcal_per_tsp: null,
      fat_per_tsp: null,
    });
    // 200 - 1*40 + 3*40 = 280 kcal; 10 - 1*4.5 + 3*4.5 = 19 g fat.
    expect(next.calories).toBe(280);
    expect(next.fat_g).toBe(19);
    expect(next.userEdited).toBe(true);
    expect(screen.queryByRole("button", { name: "None" })).toBeNull();
  });

  it("removes the fat entirely on None", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <MealItemCard
        item={reviewItemFromDraft(
          draft("Dal tadka", {
            type: "oil",
            amount_tsp: 2,
            kcal_per_tsp: null,
            fat_per_tsp: null,
          }) as never,
        )}
        index={0}
        onChange={onChange}
        onDelete={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    await user.click(screen.getByRole("button", { name: "None" }));
    const next = onChange.mock.calls[0]![0];
    expect(next.cooking_fat).toBe(null);
    expect(next.calories).toBe(120);
    expect(next.fat_g).toBe(1);
    expect(next.userEdited).toBe(true);
  });
});
