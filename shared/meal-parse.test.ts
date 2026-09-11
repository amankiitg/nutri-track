// @vitest-environment node
// Node, not jsdom: `crypto.subtle` is needed for the hashing tests.
import { describe, expect, it } from "vitest";
import {
  confidenceBand,
  guessMealType,
  macroCalories,
  MAX_ITEM_GRAMS,
  MAX_ITEM_KCAL,
  MAX_PHOTOS,
  mealFingerprint,
  mealPhotoPath,
  parseModelResponse,
  REVIEW_REASONS,
  roundToTenMinutes,
  sha256Hex,
  type MealItemDraft,
  type ParseModelResult,
} from "./meal-parse";

function onlyItem(result: ParseModelResult): MealItemDraft {
  if (!result.ok) throw new Error(`expected a successful parse, got: ${result.error}`);
  const [first] = result.items;
  if (!first) throw new Error("expected exactly one item");
  expect(result.items).toHaveLength(1);
  return first;
}

const FULL_ITEM = {
  name: "Chicken burrito bowl",
  quantity: 1,
  unit: "bowl",
  grams: 520,
  calories: 690,
  protein_g: 45,
  carbs_g: 62,
  fat_g: 25,
  fiber_g: 9,
  sugar_g: 5,
  sodium_mg: 1100,
  confidence: 0.86,
};

describe("parseModelResponse", () => {
  it("rejects text that is not JSON", () => {
    expect(parseModelResponse("Sure! Here is the JSON you asked for:")).toEqual({
      ok: false,
      error: "response was not valid JSON",
    });
  });

  it("accepts the documented object shape", () => {
    const result = parseModelResponse(JSON.stringify({ items: [FULL_ITEM] }));
    expect(onlyItem(result)).toMatchObject({
      name: "Chicken burrito bowl",
      grams: 520,
      calories: 690,
      needs_review: false,
      review_reasons: [],
    });
  });

  it("accepts a bare array, which the model sometimes sends instead", () => {
    const result = parseModelResponse(JSON.stringify([FULL_ITEM]));
    expect(onlyItem(result).name).toBe("Chicken burrito bowl");
  });

  it("accepts an empty result without inventing items", () => {
    expect(parseModelResponse(JSON.stringify({ items: [] }))).toEqual({ ok: true, items: [] });
  });

  it("reports which field failed, so a retry can be diagnosed", () => {
    const result = parseModelResponse(JSON.stringify({ items: [{ calories: 100 }] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("items.0.name");
  });

  it("coerces numeric strings, which arrive often enough to matter", () => {
    const result = parseModelResponse(
      JSON.stringify({ items: [{ ...FULL_ITEM, calories: "690", protein_g: "45.5" }] }),
    );
    const item = onlyItem(result);
    expect(item.calories).toBe(690);
    expect(item.protein_g).toBe(45.5);
  });

  it("treats blank and null fields as missing rather than as zero-ish", () => {
    const result = parseModelResponse(
      JSON.stringify({ items: [{ name: "Black coffee", calories: 2, fiber_g: "" }] }),
    );
    const item = onlyItem(result);
    expect(item.fiber_g).toBeNull();
    expect(item.sugar_g).toBeNull();
    expect(item.grams).toBeNull();
  });

  it("ignores keys the model invents", () => {
    const result = parseModelResponse(
      JSON.stringify({ items: [{ ...FULL_ITEM, vitamin_c_mg: 12 }] }),
    );
    expect(onlyItem(result).calories).toBe(690);
  });
});

describe("normalizeItem sanity checks", () => {
  it("flags an item whose calories disagree with its macros", () => {
    // 4*10 + 4*10 + 9*10 = 170 kcal, but the item claims 500.
    const result = parseModelResponse(
      JSON.stringify({
        items: [{ name: "Mystery bar", calories: 500, protein_g: 10, carbs_g: 10, fat_g: 10 }],
      }),
    );
    const item = onlyItem(result);
    expect(item.needs_review).toBe(true);
    expect(item.review_reasons).toContain(REVIEW_REASONS.macroMismatch);
    expect(macroCalories(10, 10, 10)).toBe(170);
  });

  it("does not flag macros inside the 15% tolerance", () => {
    // 4*45 + 4*62 + 9*25 = 653 kcal against a claimed 690: 5.4% apart.
    const result = parseModelResponse(JSON.stringify({ items: [FULL_ITEM] }));
    expect(onlyItem(result).needs_review).toBe(false);
  });

  it("flags an item over the calorie ceiling", () => {
    const result = parseModelResponse(
      JSON.stringify({
        items: [
          { name: "Platter", calories: MAX_ITEM_KCAL + 1, protein_g: 100, carbs_g: 150, fat_g: 80 },
        ],
      }),
    );
    expect(onlyItem(result).review_reasons).toContain(REVIEW_REASONS.caloriesTooHigh);
  });

  it("flags a zero-calorie item", () => {
    const result = parseModelResponse(JSON.stringify({ items: [{ name: "Water" }] }));
    const item = onlyItem(result);
    expect(item.calories).toBe(0);
    expect(item.review_reasons).toContain(REVIEW_REASONS.caloriesZero);
    // Zero calories and zero macros agree, so this is not a macro mismatch.
    expect(item.review_reasons).not.toContain(REVIEW_REASONS.macroMismatch);
  });

  it("flags an implausible weight", () => {
    const result = parseModelResponse(
      JSON.stringify({
        items: [
          {
            name: "Milk jug",
            grams: MAX_ITEM_GRAMS + 1,
            calories: 640,
            protein_g: 34,
            carbs_g: 48,
            fat_g: 36,
          },
        ],
      }),
    );
    expect(onlyItem(result).review_reasons).toContain(REVIEW_REASONS.gramsTooHigh);
  });

  it("defaults a missing confidence to the middle of the range and clamps outliers", () => {
    const missing = onlyItem(parseModelResponse(JSON.stringify({ items: [{ name: "Toast" }] })));
    expect(missing.confidence).toBe(0.5);

    const wild = onlyItem(
      parseModelResponse(JSON.stringify({ items: [{ name: "Toast", confidence: 7 }] })),
    );
    expect(wild.confidence).toBe(1);
  });

  it("rounds to the precision the database columns store", () => {
    const result = parseModelResponse(
      JSON.stringify({
        items: [
          {
            name: "Yoghurt",
            grams: 170.04,
            calories: 100.666,
            protein_g: 6.666,
            carbs_g: 7.333,
            fat_g: 3.333,
            confidence: 0.7777,
          },
        ],
      }),
    );
    const item = onlyItem(result);
    expect(item.grams).toBe(170);
    expect(item.calories).toBe(100.7);
    expect(item.protein_g).toBe(6.7);
    expect(item.carbs_g).toBe(7.3);
    expect(item.fat_g).toBe(3.3);
    expect(item.confidence).toBe(0.78);
  });
});

describe("guessMealType", () => {
  const at = (hour: number) => new Date(Date.UTC(2026, 2, 2, hour, 30));

  it.each([
    [5, "breakfast"],
    [10, "breakfast"],
    [11, "lunch"],
    [14, "lunch"],
    [15, "snack"],
    [16, "snack"],
    [17, "dinner"],
    [21, "dinner"],
    [22, "snack"],
    [4, "snack"],
  ] as const)("maps %i:30 in the profile zone to %s", (hour, expected) => {
    expect(guessMealType(at(hour), "UTC")).toBe(expected);
  });

  it("uses the zone it is given, not the device zone", () => {
    // 23:30 UTC is 12:30 the next day in Auckland (NZDT, UTC+13), so the same
    // instant is a late snack here and lunch there.
    const instant = new Date(Date.UTC(2026, 2, 1, 23, 30));
    expect(guessMealType(instant, "UTC")).toBe("snack");
    expect(guessMealType(instant, "Pacific/Auckland")).toBe("lunch");
  });
});

describe("mealFingerprint", () => {
  const base = {
    userId: "3f1c2f9e-0000-4000-8000-000000000001",
    photoHashes: ["hash-b", "hash-a"],
    text: "  Two   slices of  TOAST ",
    eatenAt: new Date(Date.UTC(2026, 2, 2, 12, 3)),
  };

  it("is stable for identical input", async () => {
    expect(await mealFingerprint(base)).toBe(await mealFingerprint({ ...base }));
  });

  it("ignores the order of the photos", async () => {
    const reversed = { ...base, photoHashes: ["hash-a", "hash-b"] };
    expect(await mealFingerprint(reversed)).toBe(await mealFingerprint(base));
  });

  it("normalises case and whitespace in the transcript", async () => {
    const messy = { ...base, text: "two slices of toast" };
    expect(await mealFingerprint(messy)).toBe(await mealFingerprint(base));
  });

  it("treats times inside the same ten minutes as the same meal", async () => {
    const sevenPast = { ...base, eatenAt: new Date(Date.UTC(2026, 2, 2, 12, 7, 45)) };
    expect(await mealFingerprint(sevenPast)).toBe(await mealFingerprint(base));
  });

  it("separates times in different ten-minute buckets", async () => {
    const thirteenPast = { ...base, eatenAt: new Date(Date.UTC(2026, 2, 2, 12, 13)) };
    expect(await mealFingerprint(thirteenPast)).not.toBe(await mealFingerprint(base));
  });

  it("separates different users, texts and photos", async () => {
    const other = await mealFingerprint(base);
    expect(await mealFingerprint({ ...base, userId: "other-user" })).not.toBe(other);
    expect(await mealFingerprint({ ...base, text: "a bagel" })).not.toBe(other);
    expect(await mealFingerprint({ ...base, photoHashes: ["hash-c"] })).not.toBe(other);
    expect(await mealFingerprint({ ...base, photoHashes: [] })).not.toBe(other);
  });

  it("rounds down to the window start", () => {
    expect(roundToTenMinutes(new Date(Date.UTC(2026, 2, 2, 12, 9, 59, 999))).toISOString()).toBe(
      "2026-03-02T12:00:00.000Z",
    );
  });
});

describe("confidenceBand", () => {
  it.each([
    [1, "high"],
    [0.81, "high"],
    [0.8, "medium"],
    [0.65, "medium"],
    [0.5, "medium"],
    [0.49, "low"],
    [0, "low"],
  ] as const)("bands %f as %s", (confidence, expected) => {
    expect(confidenceBand(confidence)).toBe(expected);
  });
});

describe("mealPhotoPath", () => {
  it("puts the user id first, which is what the bucket policies check", () => {
    expect(mealPhotoPath("user-1", "capture-9", 2)).toBe("user-1/capture-9/2.jpg");
  });

  it("allows exactly the number of photos the column accepts", () => {
    const paths = Array.from({ length: MAX_PHOTOS }, (_, index) =>
      mealPhotoPath("user-1", "capture-9", index),
    );
    expect(new Set(paths).size).toBe(MAX_PHOTOS);
  });
});

describe("sha256Hex", () => {
  it('matches the published digest for "abc"', async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
