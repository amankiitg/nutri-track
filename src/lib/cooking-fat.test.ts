/**
 * The cooking-fat correction: the local recompute, the "None" removal, and the
 * promise that the model's original answer is still stored after an edit.
 */
import { describe, expect, it } from "vitest";
import type { CookingFat, MealItemDraft } from "@shared/meal-parse";
import {
  formatFatAmount,
  formatFatEstimate,
  reviewItemFromDraft,
  setCookingFat,
  toSaveMealArgs,
  type ReviewItem,
} from "./review";

function draftWithFat(fat: CookingFat | null): MealItemDraft {
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
  };
}

function itemWithFat(fat: CookingFat | null): ReviewItem {
  return reviewItemFromDraft(draftWithFat(fat));
}

const oil1: CookingFat = { type: "oil", amount_tsp: 1, kcal_per_tsp: null, fat_per_tsp: null };

describe("setCookingFat", () => {
  it("recomputes calories and fat for oil, ghee and butter", () => {
    // 200 kcal / 10 g fat already includes 1 tsp of the fat.
    const oil = itemWithFat(oil1);
    const oilTwoTsp = setCookingFat(itemWithFat(oil1), {
      type: "oil",
      amount_tsp: 2,
      kcal_per_tsp: null,
      fat_per_tsp: null,
    });
    // oil: 40 kcal, 4.5 g fat per tsp.
    expect(oilTwoTsp.calories).toBe(240);
    expect(oilTwoTsp.fat_g).toBe(14.5);
    expect(oilTwoTsp.userEdited).toBe(true);
    expect(oilTwoTsp.cooking_fat?.amount_tsp).toBe(2);
    // The untouched item still names its own numbers.
    expect(oil.cooking_fat?.amount_tsp).toBe(1);

    const ghee = itemWithFat({
      type: "ghee",
      amount_tsp: 1,
      kcal_per_tsp: null,
      fat_per_tsp: null,
    });
    const gheeTbsp = setCookingFat(ghee, {
      type: "ghee",
      amount_tsp: 3,
      kcal_per_tsp: null,
      fat_per_tsp: null,
    });
    // ghee: 45 kcal, 5 g fat per tsp; 1 -> 3 tsp adds two.
    expect(gheeTbsp.calories).toBe(290);
    expect(gheeTbsp.fat_g).toBe(20);

    const butter = itemWithFat({
      type: "butter",
      amount_tsp: 1,
      kcal_per_tsp: null,
      fat_per_tsp: null,
    });
    const butterTwo = setCookingFat(butter, {
      type: "butter",
      amount_tsp: 2,
      kcal_per_tsp: null,
      fat_per_tsp: null,
    });
    // butter: 34 kcal, 3.8 g fat per tsp.
    expect(butterTwo.calories).toBe(234);
    expect(butterTwo.fat_g).toBe(13.8);
  });

  it("uses the model's per-tsp values for dressing", () => {
    const dressing = itemWithFat({
      type: "dressing",
      amount_tsp: 1,
      kcal_per_tsp: 30,
      fat_per_tsp: 3,
    });
    const two = setCookingFat(dressing, {
      type: "dressing",
      amount_tsp: 2,
      kcal_per_tsp: 30,
      fat_per_tsp: 3,
    });
    expect(two.calories).toBe(230);
    expect(two.fat_g).toBe(13);
  });

  it("removes the fat entirely on None", () => {
    const base = itemWithFat({ type: "oil", amount_tsp: 2, kcal_per_tsp: null, fat_per_tsp: null });
    const none = setCookingFat(base, null);
    // 200 - 2 * 40 = 120 kcal, 10 - 2 * 4.5 = 1 g fat.
    expect(none.calories).toBe(120);
    expect(none.fat_g).toBe(1);
    expect(none.cooking_fat).toBe(null);
    expect(none.userEdited).toBe(true);
  });

  it("recomputes a two-tablespoon correction", () => {
    const base = itemWithFat(oil1);
    const sixTsp = setCookingFat(base, {
      type: "oil",
      amount_tsp: 6,
      kcal_per_tsp: null,
      fat_per_tsp: null,
    });
    // 200 - 1 * 40 + 6 * 40 = 400 kcal, 10 - 1 * 4.5 + 6 * 4.5 = 32.5 g fat.
    expect(sixTsp.calories).toBe(400);
    expect(sixTsp.fat_g).toBe(32.5);
    expect(sixTsp.cooking_fat?.amount_tsp).toBe(6);
  });

  it("keeps the model's original cooking_fat in llm_raw after an edit", () => {
    const item = itemWithFat({ type: "oil", amount_tsp: 2, kcal_per_tsp: null, fat_per_tsp: null });
    const edited = setCookingFat(item, null);

    const args = toSaveMealArgs({
      items: [edited],
      mealType: "lunch",
      source: "photo",
      eatenAt: new Date("2026-09-23T17:23:00Z"),
      notes: null,
      photoPaths: [],
      photoHashes: [],
      inputFingerprint: "fp",
      idempotencyKey: "key",
    });

    const raw = (args._items[0]?.["llm_raw"] ?? null) as { cooking_fat?: unknown } | null;
    expect(raw?.cooking_fat).toEqual({
      type: "oil",
      amount_tsp: 2,
      kcal_per_tsp: null,
      fat_per_tsp: null,
    });
    // The item on screen no longer has a fat, but the stored original is untouched.
    expect(edited.cooking_fat).toBe(null);
  });
});

describe("formatFatAmount", () => {
  it("renders the one-tap amounts in words", () => {
    expect(formatFatAmount(1)).toBe("1 tsp");
    expect(formatFatAmount(2)).toBe("2 tsp");
    expect(formatFatAmount(3)).toBe("1 tbsp");
    expect(formatFatAmount(1.5)).toBe("1.5 tsp");
  });
});

describe("formatFatEstimate", () => {
  it("speaks tablespoons, with simple fractions when not whole", () => {
    expect(
      formatFatEstimate({ type: "oil", amount_tsp: 3, kcal_per_tsp: null, fat_per_tsp: null }),
    ).toBe("~1 tbsp oil");
    expect(
      formatFatEstimate({ type: "ghee", amount_tsp: 6, kcal_per_tsp: null, fat_per_tsp: null }),
    ).toBe("~2 tbsp ghee");
    expect(
      formatFatEstimate({ type: "butter", amount_tsp: 1, kcal_per_tsp: null, fat_per_tsp: null }),
    ).toBe("~1/3 tbsp butter");
    expect(
      formatFatEstimate({ type: "oil", amount_tsp: 2, kcal_per_tsp: null, fat_per_tsp: null }),
    ).toBe("~2/3 tbsp oil");
    expect(
      formatFatEstimate({
        type: "dressing",
        amount_tsp: 1.5,
        kcal_per_tsp: 30,
        fat_per_tsp: 3,
      }),
    ).toBe("~1/2 tbsp dressing");
  });
});
