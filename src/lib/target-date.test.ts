/**
 * The arrival date, in the units people actually weigh themselves in.
 *
 * The projection is one number with three readers: the sentence under Settings' pace options, the
 * label on the Trends target line, and the reached-target notice's tolerance. The first two call
 * the functions here so they cannot print different days for the same target.
 */
import { describe, expect, it } from "vitest";
import {
  formatReachDate,
  goalSummary,
  reachTarget,
  reachTargetLabel,
  reachTargetSentence,
} from "./target-date";
import { lbToKg } from "./units";

/** Settings and Trends, given the same week and the same target. */
const METRIC = {
  goal: "lose" as const,
  basisKg: 71,
  targetKg: 70,
  paceKgPerWeek: 0.5,
  today: "2026-11-19",
  units: "metric" as const,
};

describe("the arrival date", () => {
  it("divides the distance by the pace and lands on a day", () => {
    // 1 kg at 0.5 kg/week is two weeks, and 19 Nov plus 14 days is 3 Dec.
    const reach = reachTarget(METRIC);
    expect(reach).not.toBeNull();
    expect(reach?.atTarget).toBe(false);
    expect(
      reach?.date === null || reach?.date === undefined ? "" : formatReachDate(reach.date),
    ).toBe("3 Dec");
  });

  it("works the same in pounds", () => {
    // 170 lb to 165 lb is 2.27 kg, which at 0.5 kg/week is 32 days from 19 Nov: 21 Dec.
    const reach = reachTarget({
      goal: "lose",
      basisKg: Number(lbToKg(170).toFixed(2)),
      targetKg: Number(lbToKg(165).toFixed(2)),
      paceKgPerWeek: 0.5,
      today: "2026-11-19",
    });
    expect(
      reach?.date === null || reach?.date === undefined ? "" : formatReachDate(reach.date),
    ).toBe("21 Dec");
  });

  it("counts backwards for a gain, and still lands on a day", () => {
    const reach = reachTarget({
      goal: "gain",
      basisKg: 69,
      targetKg: 70,
      paceKgPerWeek: 0.5,
      today: "2026-11-19",
    });
    expect(reach?.atTarget).toBe(false);
    expect(reach?.date).not.toBeNull();
  });

  it("says nothing for maintain, where there is nowhere to arrive", () => {
    expect(reachTarget({ ...METRIC, goal: "maintain" })).toBeNull();
    expect(reachTarget({ ...METRIC, goal: null })).toBeNull();
  });

  it("says nothing without an average, a target or a pace", () => {
    expect(reachTarget({ ...METRIC, basisKg: null })).toBeNull();
    expect(reachTarget({ ...METRIC, targetKg: null })).toBeNull();
    expect(reachTarget({ ...METRIC, paceKgPerWeek: null })).toBeNull();
    expect(reachTarget({ ...METRIC, paceKgPerWeek: 0 })).toBeNull();
    // A day that is not a day (an unset profile zone, say) is not a date to project from.
    expect(reachTarget({ ...METRIC, today: "" })).toBeNull();
  });

  it("treats the target as met within the notice's own tolerance", () => {
    // 0.3 kg away is the same 0.5 kg band `maintainSuggestion` uses, so the date and the notice
    // cannot disagree about whether the walk is over.
    expect(reachTarget({ ...METRIC, basisKg: 70.3 })?.atTarget).toBe(true);
    expect(reachTarget({ ...METRIC, basisKg: 69 })?.atTarget).toBe(true);
    expect(reachTarget({ ...METRIC, goal: "gain", basisKg: 70.4 })?.atTarget).toBe(true);
  });
});

describe("the two sentences", () => {
  it("says the target, the day and the pace under Settings' pace options", () => {
    expect(reachTargetSentence(METRIC)).toBe("You'll reach 70.0 kg around 3 Dec at 0.5 kg/week.");
  });

  it("says it in pounds too", () => {
    const sentence = reachTargetSentence({
      ...METRIC,
      basisKg: Number(lbToKg(170).toFixed(2)),
      targetKg: Number(lbToKg(165).toFixed(2)),
      units: "imperial",
    });
    expect(sentence).toContain("165.0 lb");
    expect(sentence).toContain("1.1 lb/week");
    expect(sentence).toContain("21 Dec");
  });

  it("says the target has been reached instead of dating it", () => {
    expect(reachTargetSentence({ ...METRIC, basisKg: 70.2 })).toBe("You're at your target.");
  });

  it("draws a label for the chart even when there is no date to give it", () => {
    expect(reachTargetLabel(METRIC)).toBe("Target 70.0 kg · 3 Dec");
    expect(reachTargetLabel({ ...METRIC, basisKg: null })).toBe("Target 70.0 kg");
    expect(reachTargetLabel({ ...METRIC, basisKg: 70.1 })).toBe("Target 70.0 kg · at target");
    expect(reachTargetLabel({ ...METRIC, targetKg: null })).toBeNull();
  });

  it("prints the same day on both screens", () => {
    // The requirement, as an assertion: one input, two sentences, one date.
    const day = /\d{1,2} [A-Z][a-z]{2}/;
    const sentence = reachTargetSentence(METRIC);
    const label = reachTargetLabel(METRIC);
    expect(String(sentence).match(day)?.[0]).toBe("3 Dec");
    expect(String(label).match(day)?.[0]).toBe(String(sentence).match(day)?.[0]);
  });

  it("has no sentence at all when there is nothing to say", () => {
    expect(reachTargetSentence({ ...METRIC, goal: "maintain" })).toBeNull();
    expect(reachTargetSentence({ ...METRIC, basisKg: null })).toBeNull();
  });
});

describe("the goal panel summary", () => {
  const WEEK = {
    goal: "lose" as const,
    basisKg: 71,
    targetKg: 70,
    paceKgPerWeek: 0.5,
    today: "2026-11-19",
    units: "metric" as const,
  };

  it("says the goal, the two weights, the pace and the day", () => {
    expect(goalSummary({ ...WEEK, currentKg: 72 })).toBe(
      "Lose · 72 → 70 kg · 0.5 kg/week · reach ~3 Dec",
    );
  });

  it("prints pounds for an imperial profile", () => {
    const summary = goalSummary({
      ...WEEK,
      currentKg: Number(lbToKg(160).toFixed(2)),
      targetKg: Number(lbToKg(155).toFixed(2)),
      basisKg: Number(lbToKg(157).toFixed(2)),
      units: "imperial",
    });
    expect(summary).toBe("Lose · 160 → 155 lb · 1.1 lb/week · reach ~2 Dec");
  });

  it("leaves the date off on maintain, where there is nowhere to arrive", () => {
    expect(
      goalSummary({
        ...WEEK,
        goal: "maintain",
        currentKg: 72,
        targetKg: null,
        paceKgPerWeek: null,
      }),
    ).toBe("Maintain");
  });

  it("leaves the date off once the week has arrived", () => {
    expect(goalSummary({ ...WEEK, currentKg: 72, basisKg: 70.2 })).toBe(
      "Lose · 72 → 70 kg · 0.5 kg/week",
    );
  });

  it("says so when no goal has been chosen yet", () => {
    expect(goalSummary({ ...WEEK, goal: null, currentKg: null, targetKg: null })).toBe(
      "No goal yet",
    );
  });
});
