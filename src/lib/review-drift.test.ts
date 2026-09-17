import { describe, expect, it } from "vitest";
import { rescaleForGrams, reviewItemFromDraft, setNutrient, type ReviewItem } from "./review";

/**
 * Drift, which a round trip cannot detect.
 *
 * 158 g -> 316 g -> 158 g returns the original exactly even on drifting code, because doubling and
 * halving are exact in binary and every intermediate rounds exactly. So the test here is two
 * different routes to the same grams, which is what actually distinguishes a stable basis from a
 * re-rounded one.
 *
 * Items come from `reviewItemFromDraft`, not from a literal, because that is what carries the
 * density: a hand-built item has no basis and deliberately falls back to the old arithmetic.
 */
const DRAFT = {
  name: "Oatmeal with banana",
  quantity: 1,
  unit: "bowl",
  grams: 158,
  calories: 300,
  protein_g: 10.4,
  carbs_g: 54.3,
  fat_g: 6.1,
  fiber_g: 8.2,
  sugar_g: 12.4,
  sodium_mg: 150,
  confidence: 0.8,
};

const FIELDS = [
  "calories",
  "protein_g",
  "carbs_g",
  "fat_g",
  "fiber_g",
  "sugar_g",
  "sodium_mg",
] as const;

function fresh(): ReviewItem {
  return reviewItemFromDraft(DRAFT as never);
}

function nutrients(item: ReviewItem): Record<string, number | null> {
  return Object.fromEntries(FIELDS.map((field) => [field, item[field]]));
}

describe("a grams change depends on the grams, not on the route to them", () => {
  it("ten small increments land where one large increment does", () => {
    const oneJump = rescaleForGrams(fresh(), 218);

    let stepwise = fresh();
    for (const grams of [160, 162, 165, 170, 175, 180, 190, 200, 210, 218]) {
      stepwise = rescaleForGrams(stepwise, grams);
    }

    expect(nutrients(stepwise)).toEqual(nutrients(oneJump));
  });

  it("and going down as well, where the old arithmetic drifted further", () => {
    const oneJump = rescaleForGrams(fresh(), 120);

    let stepwise = fresh();
    for (const grams of [150, 145, 140, 135, 130, 128, 126, 124, 122, 120]) {
      stepwise = rescaleForGrams(stepwise, grams);
    }

    expect(nutrients(stepwise)).toEqual(nutrients(oneJump));
  });

  it("an explicit edit becomes the density a later grams change scales from", () => {
    // The rule the file documents: typing a number corrects the food's density, not the portion.
    // 380 kcal at 158 g is 2.4051 kcal/g, so 316 g is 760.
    const corrected = setNutrient(fresh(), "calories", "380");

    expect(rescaleForGrams(corrected, 316).calories).toBe(760);
  });

  it("still scales an untouched nutrient, so an edit to one field does not freeze the others", () => {
    const corrected = setNutrient(fresh(), "calories", "380");

    expect(rescaleForGrams(corrected, 316).protein_g).toBe(20.8);
  });
});
