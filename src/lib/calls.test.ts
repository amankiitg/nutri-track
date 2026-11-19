/**
 * The budget's arithmetic and wording.
 *
 * The fetch is exercised through the app, not here: this file is about the two things
 * that decide whether the number on screen is honest — clamping a snapshot that can be
 * stale, and saying the result in words that do not overstate it.
 */
import { describe, expect, it } from "vitest";
import { DAILY_ANALYSIS_LIMIT } from "@shared/meal-parse";
import { analysesLine, budgetFrom, resetClock } from "./calls";

describe("budgetFrom", () => {
  it("reads the limit from the shared contract, not from a second copy", () => {
    expect(budgetFrom(0, "2026-03-03T05:00:00.000Z").limit).toBe(DAILY_ANALYSIS_LIMIT);
  });

  it("defaults to twenty analyses a day", () => {
    // The default the app shows when it cannot reach the service that enforces the number.
    expect(DAILY_ANALYSIS_LIMIT).toBe(20);
  });

  it("takes the limit it is given, which is what the service said", () => {
    // The screen must be able to say 60 to an admin and 5 to a deployment that set the variable.
    const budget = budgetFrom(3, "2026-03-03T05:00:00.000Z", 60);
    expect(budget.limit).toBe(60);
    expect(budget.remaining).toBe(57);
  });

  it("counts down from the limit", () => {
    const budget = budgetFrom(17, "2026-03-03T05:00:00.000Z");
    expect(budget.used).toBe(17);
    expect(budget.remaining).toBe(DAILY_ANALYSIS_LIMIT - 17);
  });

  it("never reports negative remaining, however stale the read", () => {
    // The count can be read a moment before another tab spends the last of it.
    const budget = budgetFrom(DAILY_ANALYSIS_LIMIT + 5, "2026-03-03T05:00:00.000Z");
    expect(budget.remaining).toBe(0);
    expect(budget.used).toBe(DAILY_ANALYSIS_LIMIT);
  });

  it("never reports more left than the limit allows", () => {
    expect(budgetFrom(-3, "2026-03-03T05:00:00.000Z").remaining).toBe(DAILY_ANALYSIS_LIMIT);
  });

  it("rounds a fractional count rather than showing a fraction of a call", () => {
    expect(budgetFrom(4.6, "2026-03-03T05:00:00.000Z").used).toBe(5);
  });
});

describe("resetClock", () => {
  it("renders the reset in the profile's zone, not the device's", () => {
    // 04:00Z is midnight in New York and 05:00 in Berlin. The budget really does reset
    // when the profile's local day ends, so saying "04:00" to someone in Berlin would
    // be wrong twice over: wrong clock, and wrong zone name.
    expect(resetClock("2026-09-12T04:00:00.000Z", "America/New_York")).toBe("00:00");
    expect(resetClock("2026-09-12T04:00:00.000Z", "Europe/Berlin")).toBe("06:00");
  });
});

describe("analysesLine", () => {
  const NEW_YORK = "America/New_York";

  it("says what is left, and folds the reset into the same line", () => {
    const shown = analysesLine(budgetFrom(17, "2026-09-12T04:00:00.000Z"), NEW_YORK);

    expect(shown?.line).toBe(
      `3 of ${DAILY_ANALYSIS_LIMIT} photo analyses left today · resets at midnight`,
    );
    expect(shown?.note).toBeNull();
  });

  it("names the limit it was given, so an admin reads sixty", () => {
    expect(analysesLine(budgetFrom(10, "2026-09-12T04:00:00.000Z", 60), NEW_YORK)?.line).toBe(
      "50 of 60 photo analyses left today · resets at midnight",
    );
  });

  it("says the clock time when the reset is not midnight in the profile zone", () => {
    // 04:00Z is midnight in New York but 05:00 in London, where the line must not claim midnight.
    expect(analysesLine(budgetFrom(1, "2026-09-12T04:00:00.000Z"), "Europe/London")?.line).toBe(
      "19 of 20 photo analyses left today · resets at 05:00 in Europe/London",
    );
  });

  it("keeps the way through when there is nothing left", () => {
    const shown = analysesLine(
      budgetFrom(DAILY_ANALYSIS_LIMIT, "2026-09-12T04:00:00.000Z"),
      NEW_YORK,
    );

    expect(shown?.line).toBe("0 of 20 photo analyses left today · resets at midnight");
    expect(shown?.note).toBe("You can still add meals by typing the numbers yourself.");
  });

  it("says nothing when the limit could not be read", () => {
    expect(analysesLine(null, NEW_YORK)).toBeNull();
    // A zero limit would read "0 of 0", which means nothing.
    expect(analysesLine(budgetFrom(0, "2026-09-12T04:00:00.000Z", 0), NEW_YORK)).toBeNull();
  });
});
