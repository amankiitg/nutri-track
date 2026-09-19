import { describe, expect, it } from "vitest";
import type { MealItemDraft } from "@shared/meal-parse";
import {
  blankReviewItem,
  canSave,
  flagsFor,
  mealTotals,
  remainingCalories,
  rescaleForGrams,
  reviewItemFromDraft,
  setGrams,
  setNutrient,
  setQuantity,
  setText,
  toSaveMealArgs,
  type ReviewItem,
} from "./review";

const DRAFT: MealItemDraft = {
  name: "White rice",
  quantity: 1,
  unit: "cup",
  grams: 150,
  calories: 200,
  protein_g: 4,
  carbs_g: 44,
  fat_g: 0.4,
  fiber_g: 0.6,
  sugar_g: 0.1,
  sodium_mg: 2,
  confidence: 0.4,
  needs_review: false,
  review_reasons: [],
};

function item(overrides: Partial<ReviewItem> = {}): ReviewItem {
  // Built through the draft rather than spread over a finished item, because the density a grams
  // change scales from is computed from the draft. Overriding `grams` afterwards would leave the
  // density describing a different portion than the one on screen, which is not a state the app
  // can reach: every real path that changes grams goes through `rescaleForGrams`.
  const merged = { ...DRAFT, ...overrides };
  return { ...reviewItemFromDraft(merged), ...overrides };
}

describe("rescaleForGrams — the rule", () => {
  it("scales every nutrient by the ratio when the portion changes", () => {
    const doubled = rescaleForGrams(item(), 300);
    expect(doubled.grams).toBe(300);
    expect(doubled.calories).toBe(400);
    expect(doubled.protein_g).toBe(8);
    expect(doubled.carbs_g).toBe(88);
    expect(doubled.fat_g).toBe(0.8);
    expect(doubled.fiber_g).toBe(1.2);
  });

  it("keeps a nutrient a user typed, as a rate, when the portion changes again", () => {
    // The scenario the rule exists to answer:
    //   150 g / 200 kcal -> user doubles it to 300 g -> 400 kcal
    //   -> user corrects the calories to 380  (380 kcal *at 300 g*)
    //   -> user changes the portion to 450 g  -> 380 * 1.5 = 570
    const doubled = rescaleForGrams(item(), 300);
    expect(doubled.calories).toBe(400);

    const corrected = setNutrient(doubled, "calories", "380");
    expect(corrected.calories).toBe(380);
    expect(corrected.grams).toBe(300);
    // A direct nutrient edit rescales nothing.
    expect(corrected.protein_g).toBe(doubled.protein_g);
    expect(corrected.carbs_g).toBe(doubled.carbs_g);

    const bigger = rescaleForGrams(corrected, 450);
    expect(bigger.calories).toBe(570);
    expect(bigger.protein_g).toBe(12);
  });

  it("does not freeze an edited nutrient: one card describes one plate of food", () => {
    // The rejected alternative. If 380 were locked while the macros scaled, the card
    // would show a portion's macros beside another portion's calories.
    const corrected = setNutrient(rescaleForGrams(item(), 300), "calories", "380");
    const bigger = rescaleForGrams(corrected, 450);
    expect(bigger.calories * 0.8).toBeCloseTo(456, 0); // still consistent with 350 g
    expect(bigger.grams).toBe(450);
  });

  it("leaves name, unit and quantity alone: those are the user's own description", () => {
    const described = setQuantity(
      setText(setText(item(), "unit", "bowl"), "name", "Rice bowl"),
      "2",
    );
    const bigger = rescaleForGrams(described, 300);
    expect(bigger.name).toBe("Rice bowl");
    expect(bigger.unit).toBe("bowl");
    expect(bigger.quantity).toBe(2);
  });

  it("marks the item as edited, since a person changed it", () => {
    expect(rescaleForGrams(item(), 300).userEdited).toBe(true);
  });

  it("scales nothing when there is no basis to scale from", () => {
    const weightless = item({ grams: null, calories: 200 });
    const given = rescaleForGrams(weightless, 300);
    expect(given.grams).toBe(300);
    expect(given.calories).toBe(200);
  });

  it.each([[0], [null]])("scales nothing from a basis of %s grams", (basis) => {
    const odd = item({ grams: basis, calories: 200, protein_g: 4 });
    const given = rescaleForGrams(odd, 300);
    expect(given.calories).toBe(200);
    expect(given.protein_g).toBe(4);
  });

  it.each([[0], [null]])("scales nothing to %s grams, which has no ratio", (next) => {
    const unchanged = rescaleForGrams(item(), next);
    expect(unchanged.calories).toBe(200);
    expect(unchanged.grams).toBe(next);
  });

  it("is a no-op when the gram value does not actually change", () => {
    expect(rescaleForGrams(item(), 150).calories).toBe(200);
  });

  it("leaves a null nutrient null rather than inventing a zero", () => {
    const unknown = item({ fiber_g: null, sugar_g: null });
    const doubled = rescaleForGrams(unknown, 300);
    expect(doubled.fiber_g).toBeNull();
    expect(doubled.sugar_g).toBeNull();
  });

  it("rounds to the precision the columns store", () => {
    const third = rescaleForGrams(item({ grams: 150, calories: 100, protein_g: 10 }), 100);
    expect(third.calories).toBe(66.7);
    expect(third.protein_g).toBe(6.7);
  });
});

describe("setGrams", () => {
  it("scales when a number is typed", () => {
    expect(setGrams(item(), "300").calories).toBe(400);
  });

  it("clears the weight without scaling when the field is emptied", () => {
    const cleared = setGrams(item(), "");
    expect(cleared.grams).toBeNull();
    expect(cleared.calories).toBe(200);
  });

  it("ignores nonsense rather than turning it into NaN", () => {
    expect(setGrams(item(), "abc").grams).toBe(150);
  });

  it("refuses a negative weight", () => {
    expect(setGrams(item(), "-50").grams).toBe(0);
  });
});

describe("setNutrient", () => {
  it("sets the field, marks the item edited, and touches nothing else", () => {
    const edited = setNutrient(item(), "protein_g", "12.5");
    expect(edited.protein_g).toBe(12.5);
    expect(edited.calories).toBe(200);
    expect(edited.carbs_g).toBe(44);
    expect(edited.userEdited).toBe(true);
  });

  it.each([["fiber_g"], ["sugar_g"], ["sodium_mg"]])("lets %s be emptied to unknown", (field) => {
    const edited = setNutrient(item(), field as "fiber_g", "  ");
    expect(edited[field as "fiber_g"]).toBeNull();
  });

  it.each([["calories"], ["protein_g"], ["carbs_g"], ["fat_g"]])(
    "refuses to empty %s, which is NOT NULL in the database",
    (field) => {
      // A zero is a lie, but an empty string reaching a NOT NULL numeric column would
      // be an error the user cannot act on.
      expect(setNutrient(item(), field as "calories", "")[field as "calories"]).toBe(0);
    },
  );

  it("ignores a partial entry rather than committing NaN", () => {
    expect(setNutrient(item(), "calories", "-").calories).toBe(200);
  });
});

describe("the derived flags", () => {
  it("clears the warning once the user corrects the numbers", () => {
    // 4 g protein is 16 kcal against a claimed 200: a mismatch the model flagged.
    const mismatched = item({ calories: 200, protein_g: 4, carbs_g: 0, fat_g: 0 });
    expect(flagsFor(mismatched).needsReview).toBe(true);
    expect(flagsFor(mismatched).reasons[0]).toContain("Calories do not match");

    const corrected = setNutrient(mismatched, "carbs_g", "46");
    expect(flagsFor(corrected).needsReview).toBe(false);
    expect(flagsFor(corrected).reasons).toEqual([]);
  });

  it("raises a warning when a bigger portion crosses the calorie ceiling", () => {
    const modest = item({ grams: 100, calories: 1500, protein_g: 100, carbs_g: 100, fat_g: 60 });
    expect(flagsFor(modest).needsReview).toBe(false);
    // 1500 kcal at 100 g, scaled to 400 g, is 6000 kcal in one item.
    const huge = rescaleForGrams(modest, 400);
    expect(huge.calories).toBe(6000);
    expect(flagsFor(huge).reasons.join(" ")).toContain("kcal for one item");
  });
});

describe("mealTotals", () => {
  it("sums the items", () => {
    const totals = mealTotals([item(), item({ calories: 100, protein_g: 6, fiber_g: null })]);
    expect(totals.calories).toBe(300);
    expect(totals.protein_g).toBe(10);
    // The second item's fibre is unknown, so it adds nothing to the first item's 0.6.
    expect(totals.fiber_g).toBe(0.6);
  });

  it("treats an unknown nutrient as contributing nothing", () => {
    expect(mealTotals([item({ sodium_mg: null })]).sodium_mg).toBe(0);
  });

  it("is all zeroes for an empty meal", () => {
    expect(mealTotals([]).calories).toBe(0);
  });
});

describe("remainingCalories", () => {
  // The first argument is what is left of the day *before* this meal, not the day's target.
  // These tests could not see the defect because they only ever fed it a target: on a day
  // with nothing logged the two are the same number, and the arithmetic is identical.
  it("subtracts the meal from what is left of today", () => {
    // The phone's own numbers: 408 left, a 130 kcal meal, 278 left.
    expect(remainingCalories(408, mealTotals([item({ calories: 130 })]))).toBe(278);
  });

  it("goes negative when the meal is bigger than what is left", () => {
    expect(remainingCalories(100, mealTotals([item({ calories: 250 })]))).toBe(-150);
  });
});

describe("canSave", () => {
  it("needs at least one item", () => {
    expect(canSave([])).toBe(false);
    expect(canSave([item()])).toBe(true);
  });

  it("refuses an item without a name", () => {
    expect(canSave([item({ name: "   " })])).toBe(false);
  });
});

describe("toSaveMealArgs", () => {
  const base = {
    items: [item()],
    mealType: "lunch" as const,
    source: "photo" as const,
    eatenAt: new Date("2026-03-02T12:05:00.000Z"),
    notes: "half portion",
    photoPaths: ["user-1/a.jpg"],
    photoHashes: ["hash-a"],
    inputFingerprint: "fp-1",
    idempotencyKey: "6f1c2f9e-0000-4000-8000-000000000001",
  };

  it("builds the _meal argument the RPC reads", () => {
    expect(toSaveMealArgs(base)._meal).toEqual({
      eaten_at: "2026-03-02T12:05:00.000Z",
      meal_type: "lunch",
      source: "photo",
      notes: "half portion",
      photo_paths: ["user-1/a.jpg"],
      photo_hashes: ["hash-a"],
      input_fingerprint: "fp-1",
      idempotency_key: "6f1c2f9e-0000-4000-8000-000000000001",
    });
  });

  it("includes the raw model item so what the model claimed is on the record", () => {
    expect(toSaveMealArgs(base)._items[0]?.["llm_raw"]).toMatchObject({ name: "White rice" });
  });

  it("omits llm_raw for an item added by hand, so the column is a SQL null", () => {
    // The RPC reads it with `->`, and a JSON null would store a jsonb null instead.
    expect(toSaveMealArgs({ ...base, items: [blankReviewItem()] })._items[0]).not.toHaveProperty(
      "llm_raw",
    );
  });

  it("sends nulls, not empty strings, for the optional columns", () => {
    const row = toSaveMealArgs({
      ...base,
      items: [item({ quantity: null, unit: null, grams: null })],
    })._items[0];
    expect(row?.["quantity"]).toBeNull();
    expect(row?.["unit"]).toBeNull();
    expect(row?.["grams"]).toBeNull();
  });

  it("carries the user_edited flag the column holds", () => {
    expect(toSaveMealArgs(base)._items[0]?.["user_edited"]).toBe(false);
    expect(
      toSaveMealArgs({ ...base, items: [setNutrient(item(), "calories", "210")] })._items[0]?.[
        "user_edited"
      ],
    ).toBe(true);
  });

  it("never sends an empty name, which the column forbids", () => {
    expect(toSaveMealArgs({ ...base, items: [item({ name: "  " })] })._items[0]?.["name"]).toBe(
      "Unnamed item",
    );
  });

  it("caps the photos at three, as the column does", () => {
    const many = ["a", "b", "c", "d"].map((name) => `user-1/${name}.jpg`);
    expect(toSaveMealArgs({ ...base, photoPaths: many })._meal["photo_paths"]).toHaveLength(3);
  });
});
