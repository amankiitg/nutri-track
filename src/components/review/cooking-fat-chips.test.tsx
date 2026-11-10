/**
 * The cooking-fat chips: shown for items with a hidden fat, absent for items without,
 * and wired to the local recompute rather than a new model call.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CookingFat } from "@shared/meal-parse";
import { reviewItemFromDraft } from "@/lib/review";
import { MealItemCard } from "./MealItemCard";

function draft(fat: CookingFat | null) {
  return {
    name: "Dal tadka",
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

describe("cooking fat chips", () => {
  it("shows no chips for an item without cooking_fat", () => {
    render(
      <MealItemCard
        item={reviewItemFromDraft(draft(null) as never)}
        index={0}
        onChange={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Assumes/)).toBeNull();
    expect(screen.queryByRole("button", { name: "None" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Oil" })).toBeNull();
  });

  it("shows the amount line and the chips for an item with cooking_fat", () => {
    render(
      <MealItemCard
        item={reviewItemFromDraft(
          draft({ type: "oil", amount_tsp: 1, kcal_per_tsp: null, fat_per_tsp: null }) as never,
        )}
        index={0}
        onChange={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText(/Assumes 1 tsp oil/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "None" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1 tsp" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "2 tsp" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1 tbsp" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Oil" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ghee" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Butter" })).toBeTruthy();
  });

  it("recomputes locally when None is tapped", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <MealItemCard
        item={reviewItemFromDraft(
          draft({ type: "oil", amount_tsp: 2, kcal_per_tsp: null, fat_per_tsp: null }) as never,
        )}
        index={0}
        onChange={onChange}
        onDelete={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "None" }));
    const next = onChange.mock.calls[0]![0];
    expect(next.cooking_fat).toBe(null);
    // 200 - 2 * 40 kcal, 10 - 2 * 4.5 g fat.
    expect(next.calories).toBe(120);
    expect(next.fat_g).toBe(1);
    expect(next.userEdited).toBe(true);
  });

  it("marks the item edited and keeps the type when the amount changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <MealItemCard
        item={reviewItemFromDraft(
          draft({ type: "ghee", amount_tsp: 1, kcal_per_tsp: null, fat_per_tsp: null }) as never,
        )}
        index={0}
        onChange={onChange}
        onDelete={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "1 tbsp" }));
    const next = onChange.mock.calls[0]![0];
    expect(next.cooking_fat).toEqual({
      type: "ghee",
      amount_tsp: 3,
      kcal_per_tsp: null,
      fat_per_tsp: null,
    });
    expect(next.calories).toBe(290);
  });
});
