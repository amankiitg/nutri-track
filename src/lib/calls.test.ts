/**
 * The budget's arithmetic and wording.
 *
 * The fetch is exercised through the app, not here: this file is about the two things
 * that decide whether the number on screen is honest — clamping a snapshot that can be
 * stale, and saying the result in words that do not overstate it.
 */
import { describe, expect, it } from "vitest";
import { MAX_LLM_CALLS_PER_DAY } from "@shared/meal-parse";
import { budgetFrom, countsNote, presentBudget, resetClock } from "./calls";

describe("budgetFrom", () => {
  it("reads the limit from the shared contract, not from a second copy", () => {
    expect(budgetFrom(0, "2026-03-03T05:00:00.000Z").limit).toBe(MAX_LLM_CALLS_PER_DAY);
  });

  it("counts down from the limit", () => {
    const budget = budgetFrom(17, "2026-03-03T05:00:00.000Z");
    expect(budget.used).toBe(17);
    expect(budget.remaining).toBe(MAX_LLM_CALLS_PER_DAY - 17);
  });

  it("never reports negative remaining, however stale the read", () => {
    // The count can be read a moment before another tab spends the last of it.
    const budget = budgetFrom(MAX_LLM_CALLS_PER_DAY + 5, "2026-03-03T05:00:00.000Z");
    expect(budget.remaining).toBe(0);
    expect(budget.used).toBe(MAX_LLM_CALLS_PER_DAY);
  });

  it("never reports more left than the limit allows", () => {
    expect(budgetFrom(-3, "2026-03-03T05:00:00.000Z").remaining).toBe(MAX_LLM_CALLS_PER_DAY);
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

describe("presentBudget", () => {
  const NEW_YORK = "America/New_York";

  it("shows what is left out of the limit, and when it comes back", () => {
    const shown = presentBudget(budgetFrom(17, "2026-09-12T04:00:00.000Z"), NEW_YORK);
    expect(shown.remaining).toBe(MAX_LLM_CALLS_PER_DAY - 17);
    expect(shown.scale).toBe(`of ${MAX_LLM_CALLS_PER_DAY} left today`);
    expect(shown.reset).toContain("Resets at midnight — 00:00");
    expect(shown.reset).toContain(NEW_YORK);
  });

  it("says nothing about being out when there is plenty left", () => {
    expect(presentBudget(budgetFrom(1, "2026-09-12T04:00:00.000Z"), NEW_YORK).exhausted).toBeNull();
  });

  it("gives the way around it when there is nothing left", () => {
    // The whole reason to show the number is to answer "can I log this now". When the
    // answer is no, that is only useful with the escape route attached.
    const shown = presentBudget(
      budgetFrom(MAX_LLM_CALLS_PER_DAY, "2026-09-12T04:00:00.000Z"),
      NEW_YORK,
    );
    expect(shown.remaining).toBe(0);
    expect(shown.exhausted).toContain("all 60");
    expect(shown.exhausted).toContain("typing still work");
  });
});

describe("countsNote", () => {
  it("explains the unit, because it is not the same as meals", () => {
    // Someone who has logged forty meals and sees fifty used should not have to guess
    // why. The service counts model calls and a retry costs two.
    expect(countsNote).toContain("twice");
    expect(countsNote).toContain("two");
  });
});
