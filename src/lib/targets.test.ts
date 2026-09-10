import { describe, expect, it } from "vitest";
import {
  ageFromDob,
  bmi,
  bmr,
  computeTargets,
  minSafeWeightKg,
  projectedTargetDate,
  tdee,
} from "./targets";

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
