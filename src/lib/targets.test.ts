import { describe, expect, it } from "vitest";
import {
  ageFromDob,
  bmi,
  bmr,
  calorieExplanation,
  computeTargets,
  minSafeWeightKg,
  projectionFor,
  projectedTargetDate,
  targetProximity,
  tdee,
} from "./targets";
import { lbToKg } from "./units";

describe("Mifflin-St Jeor", () => {
  it("computes female BMR from the worked example", () => {
    // 10*70 + 6.25*165 - 5*32 - 161 = 700 + 1031.25 - 160 - 161
    expect(bmr({ sex: "female", weightKg: 70, heightCm: 165, age: 32 })).toBeCloseTo(1410.25, 5);
  });

  it("computes male BMR with the +5 constant", () => {
    expect(bmr({ sex: "male", weightKg: 80, heightCm: 180, age: 40 })).toBeCloseTo(1730, 5);
  });

  it("applies the activity multiplier", () => {
    expect(tdee(1410.25, "moderately_active")).toBeCloseTo(2185.8875, 4);
  });
});

describe("computeTargets — worked example", () => {
  const result = computeTargets({
    sex: "female",
    age: 32,
    heightCm: 165,
    weightKg: 70,
    activityLevel: "moderately_active",
    goal: "lose",
    paceKgPerWeek: 0.5,
    proteinGPerKg: 1.6,
  });

  it("BMR = 1410.25", () => expect(result.bmr).toBeCloseTo(1410.25, 5));
  it("TDEE ≈ 2185.9", () => expect(result.tdee).toBeCloseTo(2185.9, 1));
  it("adjustment = -550 kcal/day", () => expect(result.adjustment).toBeCloseTo(-550, 5));
  it("target = 1636 kcal", () => expect(result.calories).toBe(1636));
  it("protein = 112 g", () => expect(result.proteinG).toBe(112));
  it("fat = 45 g", () => expect(result.fatG).toBe(45));
  it("carbs = 196 g", () => expect(result.carbsG).toBe(196));
  it("floor not applied", () => {
    expect(result.floorApplied).toBe(false);
    expect(result.effectivePace).toBe(0.5);
  });
});

describe("computeTargets — goals and floors", () => {
  it("maintain has zero adjustment and target equals rounded TDEE", () => {
    const r = computeTargets({
      sex: "male",
      age: 40,
      heightCm: 180,
      weightKg: 80,
      activityLevel: "sedentary",
      goal: "maintain",
      paceKgPerWeek: 1,
    });
    expect(r.adjustment).toBe(0);
    expect(r.calories).toBe(Math.round(1730 * 1.2));
  });

  it("gain adds calories", () => {
    const r = computeTargets({
      sex: "male",
      age: 25,
      heightCm: 175,
      weightKg: 65,
      activityLevel: "very_active",
      goal: "gain",
      paceKgPerWeek: 0.25,
    });
    expect(r.adjustment).toBeCloseTo(275, 5);
    expect(r.calories).toBe(Math.round(r.tdee + 275));
  });

  it("applies the 1200 kcal floor for women and reports the capped pace", () => {
    const r = computeTargets({
      sex: "female",
      age: 60,
      heightCm: 155,
      weightKg: 50,
      activityLevel: "sedentary",
      goal: "lose",
      paceKgPerWeek: 1,
    });
    expect(r.floorApplied).toBe(true);
    expect(r.calories).toBe(1200);
    expect(r.effectivePace).toBeLessThan(1);
    expect(r.effectivePace).toBeCloseTo(((r.tdee - 1200) * 7) / 7700, 2);
  });

  it("applies the 1500 kcal floor for men", () => {
    const r = computeTargets({
      sex: "male",
      age: 70,
      heightCm: 160,
      weightKg: 55,
      activityLevel: "sedentary",
      goal: "lose",
      paceKgPerWeek: 1,
    });
    expect(r.floorApplied).toBe(true);
    expect(r.calories).toBe(1500);
  });

  it("never returns negative carbs", () => {
    const r = computeTargets({
      sex: "female",
      age: 30,
      heightCm: 160,
      weightKg: 120,
      activityLevel: "sedentary",
      goal: "lose",
      paceKgPerWeek: 1,
      proteinGPerKg: 3,
    });
    expect(r.carbsG).toBeGreaterThanOrEqual(0);
  });
});

describe("helpers", () => {
  it("ageFromDob handles birthdays not yet reached this year", () => {
    const today = new Date("2026-09-10T12:00:00");
    expect(ageFromDob("1994-09-11", today)).toBe(31);
    expect(ageFromDob("1994-09-10", today)).toBe(32);
  });

  it("bmi and minimum safe weight agree", () => {
    expect(bmi(70, 165)).toBeCloseTo(25.71, 2);
    expect(bmi(minSafeWeightKg(165), 165)).toBeCloseTo(18.5, 6);
  });

  it("projects the target date from pace", () => {
    const from = new Date("2026-01-01T00:00:00");
    const d = projectedTargetDate(70, 65, 0.5, from);
    // 5 kg at 0.5 kg/week = 10 weeks = 70 days
    expect(d?.toISOString().slice(0, 10)).toBe("2026-03-12");
    expect(projectedTargetDate(70, 65, 0, from)).toBeNull();
  });
});

describe("targetProximity", () => {
  it("reads the direction, not the distance: the same pair answers differently per goal", () => {
    expect(targetProximity("lose", 75, 72)).toBe("away");
    expect(targetProximity("gain", 72, 70)).toBe("wrong_side");
    expect(targetProximity("gain", 68, 70)).toBe("away");
    expect(targetProximity("lose", 77, 85)).toBe("wrong_side");
  });

  it("counts a kilogram either side of the target as being there", () => {
    // The same weight answers "at target" whether it is just short, exactly on it, or just past.
    expect(targetProximity("lose", 70.5, 70)).toBe("at_target");
    expect(targetProximity("lose", 70, 70)).toBe("at_target");
    expect(targetProximity("lose", 69.5, 70)).toBe("at_target");
    // And the tolerance is a full kilogram, so exactly one is still there and a tenth more is not.
    expect(targetProximity("lose", 69, 70)).toBe("at_target");
    expect(targetProximity("lose", 70, 71)).toBe("at_target");
    expect(targetProximity("lose", 70, 71.1)).toBe("wrong_side");
  });

  it("calls a target the weight has gone well past a wrong side too", () => {
    // 68.9 kg aiming at 70, and 77 kg aiming at 85, are the same numbers seen from two directions:
    // a form holds no history to tell somebody who overshot from somebody who mistyped.
    expect(targetProximity("lose", 68.9, 70)).toBe("wrong_side");
    expect(targetProximity("gain", 71.1, 70)).toBe("wrong_side");
  });

  it("reads 169.8 lb against a 170 lb target as being there, because it is 0.09 kg", () => {
    // The pair from the bug report: 1 lb apart in the boxes, 90 g apart in kilograms.
    expect(targetProximity("lose", lbToKg(169.8), lbToKg(170))).toBe("at_target");
  });

  it("calls 77 kg against an 85 kg lose target the wrong side, and it is 8 kg", () => {
    expect(targetProximity("lose", 77, 85)).toBe("wrong_side");
    expect(targetProximity("gain", 77, 69)).toBe("wrong_side");
  });

  it("does not apply to maintain, or when a number is missing", () => {
    expect(targetProximity("maintain", 70, 72)).toBeNull();
    expect(targetProximity(null, 70, 72)).toBeNull();
    expect(targetProximity("lose", null, 72)).toBeNull();
    expect(targetProximity("lose", 70, null)).toBeNull();
  });
});

describe("projectionFor", () => {
  const from = new Date("2026-11-06T00:00:00Z");

  it("gives a future date for a target still ahead", () => {
    const date = projectionFor({
      goal: "lose",
      currentKg: 80,
      targetKg: 70,
      paceKgPerWeek: 0.5,
      from,
    });

    expect(date).not.toBeNull();
    expect(date?.getTime()).toBeGreaterThan(from.getTime());
  });

  it("gives no date for a target already passed, in either direction", () => {
    expect(
      projectionFor({ goal: "lose", currentKg: 69, targetKg: 70, paceKgPerWeek: 0.5, from }),
    ).toBeNull();
    expect(
      projectionFor({ goal: "gain", currentKg: 71, targetKg: 70, paceKgPerWeek: 0.5, from }),
    ).toBeNull();
  });

  it("gives no date when there is nothing to project", () => {
    expect(
      projectionFor({ goal: "maintain", currentKg: 80, targetKg: 70, paceKgPerWeek: 0.5, from }),
    ).toBeNull();
    expect(
      projectionFor({ goal: "lose", currentKg: 80, targetKg: 70, paceKgPerWeek: null, from }),
    ).toBeNull();
    expect(
      projectionFor({ goal: "lose", currentKg: null, targetKg: 70, paceKgPerWeek: 0.5, from }),
    ).toBeNull();
  });

  it("never dates a target the weight has overshot, which is the bug this replaced", () => {
    // `projectedTargetDate` alone would happily return a future date here, because it is handed a
    // distance and a distance has no direction.
    expect(projectedTargetDate(65, 70, 0.5, from)).not.toBeNull();
    expect(
      projectionFor({ goal: "lose", currentKg: 65, targetKg: 70, paceKgPerWeek: 0.5, from }),
    ).toBeNull();
  });
});

describe("the sentence under the calorie number", () => {
  const result = { tdee: 2398, adjustment: -550, requestedPace: 0.5 } as const;

  it("shows the subtraction it performed, in the units on screen", () => {
    expect(calorieExplanation(result, "lose", "metric")).toBe(
      "Maintenance \u2248 2,398 kcal \u2212 550 kcal for 0.5 kg/week",
    );
  });

  it("names the pace in pounds where pounds are selected", () => {
    // 0.5 kg/week is 1.1 lb/week, and a line that said kg on an imperial profile would be the one
    // number on the screen in the other unit system.
    expect(calorieExplanation(result, "lose", "imperial")).toContain("for 1.1 lb/week");
  });

  it("adds rather than subtracts for a surplus", () => {
    expect(
      calorieExplanation({ tdee: 2398, adjustment: 300, requestedPace: 0.25 }, "gain", "metric"),
    ).toBe("Maintenance \u2248 2,398 kcal + 300 kcal for 0.25 kg/week");
  });

  it("says there is no adjustment when maintaining", () => {
    expect(
      calorieExplanation({ tdee: 2398.4, adjustment: 0, requestedPace: 0.5 }, "maintain", "metric"),
    ).toBe("Maintenance \u2248 2,398 kcal, with no adjustment.");
  });

  it("reads the real result as prose, not as a formula", () => {
    // The worked example: female, 32, 165 cm, 70 kg, moderately active, lose 0.5 kg/week.
    const targets = computeTargets({
      sex: "female",
      age: ageFromDob("1994-01-01", new Date("2026-01-01T00:00:00Z")),
      heightCm: 165,
      weightKg: 70,
      activityLevel: "moderately_active",
      goal: "lose",
      paceKgPerWeek: 0.5,
      proteinGPerKg: 1.6,
    });
    const sentence = calorieExplanation(targets, "lose", "metric");

    expect(sentence).toBe(
      `Maintenance \u2248 ${Math.round(targets.tdee).toLocaleString("en-US")} kcal \u2212 ${Math.round(Math.abs(targets.adjustment)).toLocaleString("en-US")} kcal for 0.5 kg/week`,
    );
    // The two numbers in the sentence, subtracted, are the number printed above it. The result is
    // not repeated in the sentence: that is what the big number is for.
    const fromSentence = Math.round(targets.tdee) - Math.round(Math.abs(targets.adjustment));
    expect(Math.abs(fromSentence - targets.calories)).toBeLessThanOrEqual(1);
  });
});
