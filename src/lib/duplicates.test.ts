import { describe, expect, it } from "vitest";
import {
  countMatchingNames,
  findDuplicate,
  formatMealTime,
  levenshteinDistance,
  namesMatch,
  normalizeItemName,
  SIMILARITY_THRESHOLD,
  similarityRatio,
  type CandidateMeal,
} from "./duplicates";

function meal(overrides: Partial<CandidateMeal> = {}): CandidateMeal {
  return {
    id: "meal-1",
    eatenAt: "2026-03-02T12:40:00.000Z",
    mealType: "lunch",
    source: "photo",
    itemNames: ["White rice", "Grilled chicken", "Steamed broccoli"],
    photoHashes: [],
    ...overrides,
  };
}

describe("normalizeItemName", () => {
  it("ignores case, punctuation and spacing", () => {
    expect(normalizeItemName("  Grilled CHICKEN, 2 pieces ")).toBe("grilled chicken 2 pieces");
    expect(normalizeItemName("white   rice")).toBe("white rice");
  });

  it("keeps letters outside ASCII, which food names are full of", () => {
    expect(normalizeItemName("Crème Brûlée")).toBe("crème brûlée");
  });
});

describe("levenshteinDistance", () => {
  it.each([
    ["", "", 0],
    ["abc", "abc", 0],
    ["", "abc", 3],
    ["kitten", "sitting", 3],
    ["flaw", "lawn", 2],
  ])("distances %s and %s by %i", (a, b, expected) => {
    expect(levenshteinDistance(a, b)).toBe(expected);
  });
});

describe("similarityRatio", () => {
  it("is 1 for the same name, however it is punctuated", () => {
    expect(similarityRatio("White rice", "white  RICE")).toBe(1);
  });

  it("is 0 for strings sharing nothing at all", () => {
    expect(similarityRatio("abc", "xyz")).toBe(0);
  });

  it("scores unrelated foods far below the threshold, even when they share letters", () => {
    // "rice" and "broccoli" have letters in common, so this is not 0 — it is just low
    // enough that nobody would call them the same food.
    expect(similarityRatio("rice", "broccoli")).toBeLessThan(0.5);
    expect(namesMatch("rice", "broccoli")).toBe(false);
  });

  it("scores a near miss above the threshold", () => {
    expect(similarityRatio("Cherry tomatoes", "Cherry tomato")).toBeGreaterThan(
      SIMILARITY_THRESHOLD,
    );
    expect(similarityRatio("Grilled chicken", "Griled chicken")).toBeGreaterThan(
      SIMILARITY_THRESHOLD,
    );
  });

  it("scores different foods below it", () => {
    expect(similarityRatio("White rice", "Brown rice pilaf")).toBeLessThan(SIMILARITY_THRESHOLD);
    expect(similarityRatio("Hamburger patty", "Cherry tomatoes")).toBeLessThan(
      SIMILARITY_THRESHOLD,
    );
  });

  it("does not let a short name hide inside a long one", () => {
    // Normalising by the longer string is what stops "rice" matching everything.
    expect(similarityRatio("rice", "rice with grilled vegetables and tofu")).toBeLessThan(0.5);
  });

  it("treats two empty names as equal and one empty name as nothing alike", () => {
    expect(similarityRatio("", "")).toBe(1);
    expect(similarityRatio("rice", "")).toBe(0);
  });

  it("is symmetric", () => {
    expect(similarityRatio("grilled chicken", "grilled chikcen")).toBe(
      similarityRatio("grilled chikcen", "grilled chicken"),
    );
  });
});

describe("namesMatch", () => {
  it("uses the 0.85 threshold by default", () => {
    expect(SIMILARITY_THRESHOLD).toBe(0.85);
    expect(namesMatch("white rice", "white rice")).toBe(true);
    expect(namesMatch("white rice", "wild rice")).toBe(false);
  });
});

describe("countMatchingNames", () => {
  it("needs each existing name only once", () => {
    // "rice" and "rice" against one "rice" is one match, not two.
    expect(countMatchingNames(["rice", "rice"], ["rice"])).toBe(1);
  });

  it("counts a whole meal that lines up", () => {
    expect(
      countMatchingNames(
        ["White rice", "Grilled chicken", "Steamed broccoli"],
        ["white rice", "grilled chicken", "steamed broccoli"],
      ),
    ).toBe(3);
  });

  it("ignores an item the earlier meal did not have", () => {
    expect(countMatchingNames(["White rice", "Mango"], ["white rice", "grilled chicken"])).toBe(1);
  });

  it("prefers the closest unused name when two are plausible", () => {
    const matches = countMatchingNames(
      ["Grilled chicken breast"],
      ["Grilled chicken", "Grilled chicken breast"],
    );
    expect(matches).toBe(1);
  });
});

describe("findDuplicate", () => {
  it("matches on a shared photo hash before anything else", () => {
    const match = findDuplicate({ itemNames: [], photoHashes: ["hash-a"] }, [
      meal({ photoHashes: ["hash-b", "hash-a"] }),
    ]);
    expect(match?.reason).toBe("photo");
    expect(match?.meal.id).toBe("meal-1");
  });

  it("does not match photos when the capture has none", () => {
    const match = findDuplicate({ itemNames: [], photoHashes: [] }, [
      meal({ photoHashes: ["hash-a"] }),
    ]);
    expect(match).toBeNull();
  });

  it("matches two or more item names, even with no photos involved", () => {
    const match = findDuplicate(
      { itemNames: ["white rice", "steamed brocolli"], photoHashes: [] },
      [meal()],
    );
    expect(match?.reason).toBe("items");
    expect(match?.matchedItems).toBe(2);
  });

  it("does not match on a single name, which is a coincidence", () => {
    // Plenty of meals contain rice.
    const match = findDuplicate({ itemNames: ["White rice"], photoHashes: [] }, [meal()]);
    expect(match).toBeNull();
  });

  it("does not match a meal with entirely different items", () => {
    const match = findDuplicate({ itemNames: ["Salmon", "Asparagus"], photoHashes: [] }, [meal()]);
    expect(match).toBeNull();
  });

  it("picks the closest of several candidates", () => {
    const match = findDuplicate(
      { itemNames: ["white rice", "grilled chicken", "steamed broccoli"], photoHashes: [] },
      [
        meal({ id: "weak", itemNames: ["white rice"] }),
        meal({ id: "strong", itemNames: ["white rice", "grilled chicken"] }),
      ],
    );
    expect(match?.meal.id).toBe("strong");
    expect(match?.matchedItems).toBe(2);
  });

  it("returns null for an empty history", () => {
    expect(findDuplicate({ itemNames: ["White rice"], photoHashes: ["x"] }, [])).toBeNull();
  });
});

describe("formatMealTime", () => {
  it("renders the local clock time, which is what the banner quotes", () => {
    const iso = new Date(2026, 2, 2, 12, 40).toISOString();
    expect(formatMealTime(iso)).toBe("12:40");
  });

  it("returns nothing for an unparseable date rather than NaN", () => {
    expect(formatMealTime("not a date")).toBe("");
  });
});
