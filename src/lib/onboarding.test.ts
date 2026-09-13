/**
 * What the form carries, and what it deliberately does not.
 *
 * The "Daily reminder" field was removed because nothing read it. `profiles.reminder_time`
 * is still there, and the only thing keeping whatever it holds safe is that a profile save
 * no longer mentions the column at all — `upsert` writes the columns it is given and
 * leaves the rest alone.
 *
 * So this file guards an absence. It is a small file for a small rule, but the rule is the
 * whole reason the removal was free: if `reminder_time` ever reappears in the payload,
 * every save starts overwriting a value nothing in the app can show or correct.
 */
import { describe, expect, it } from "vitest";
import {
  BMI_MESSAGE,
  formFromProfile,
  heightMessage,
  targetWeightMessage,
  toProfileInsert,
  weightMessage,
  DEFAULT_ONBOARDING_FORM,
} from "./onboarding";
import { MIN_SAFE_BMI, minSafeWeightKg } from "./targets";
import { lbToKg } from "./units";
import type { Profile } from "./profile";

const COMPLETE_FORM = {
  ...DEFAULT_ONBOARDING_FORM,
  display_name: "Aman",
  dob: "1994-01-01",
  height_cm: 165,
  weight_kg: 70,
  target_weight_kg: 65,
  timezone: "America/New_York",
};

describe("the implausible-value guards", () => {
  it("blames the unit first when the digits could be a mix-up", () => {
    // 55 with lb selected is 24.9 kg, which at 165 cm is a BMI of 9.2, so the floor fires. But
    // the reader's actual mistake is the unit select, so that is what leads.
    const message = targetWeightMessage(lbToKg(55), 165, "imperial");

    expect(message).toContain("looks very low for your height");
    expect(message).toContain("lb is selected, so 55 is being read as 24.9 kg");
    expect(message).toContain("If you meant 55 kg, switch to Metric");
    // The safety point is still there, and still second.
    expect(message).toContain(`below the ${MIN_SAFE_BMI}`);
    expect(message).toContain("talk to a doctor first");
  });

  it("keeps the plain safety message when the digits cannot be a mix-up", () => {
    // 40 kg at 165 cm is a BMI of 14.7, and 40 is not 40 lb either (18 kg). Nothing about units
    // would be true here, so nothing about units is said.
    expect(targetWeightMessage(40, 165, "metric")).toBe(BMI_MESSAGE);
    // The floor is untouched: this is still the same guard, with better wording.
    expect(minSafeWeightKg(165)).toBeCloseTo(50.4, 1);
  });

  it("names the selected unit on a height that is in the wrong one", () => {
    const message = heightMessage(65, "metric");

    expect(message).toContain("looks too short");
    expect(message).toContain("cm is selected, so 65 is being read as 25.6 in");
    expect(message).toContain("switch to Imperial");
  });

  it("leaves a height alone when no unit reading of it works", () => {
    expect(heightMessage(5, "metric")).toBe("That height looks too short.");
  });

  it("does not speculate about units for an imperial height", () => {
    // Two labelled boxes, ft and in: the unit is never ambiguous for the field itself.
    expect(heightMessage(40, "imperial")).toBe("That height looks too short.");
  });

  it("names the selected unit on a weight that is in the wrong one", () => {
    const message = weightMessage(lbToKg(60), "imperial");

    expect(message).toContain("looks too low");
    expect(message).toContain("lb is selected, so 60 is being read as 27.2 kg");
    expect(message).toContain("switch to Metric");
  });

  it("leaves a weight alone when no unit reading of it works", () => {
    expect(weightMessage(10, "metric")).toBe("That weight looks too low.");
  });
});

describe("a profile save", () => {
  it("does not mention the reminder, so it cannot overwrite a stored one", () => {
    const row = toProfileInsert(COMPLETE_FORM, "user-1");
    expect(Object.keys(row)).not.toContain("reminder_time");
  });

  it("still writes everything the app actually shows", () => {
    // The guard above is only worth having if the rest of the row is intact.
    const row = toProfileInsert(COMPLETE_FORM, "user-1");
    expect(row).toMatchObject({
      user_id: "user-1",
      display_name: "Aman",
      dob: "1994-01-01",
      height_cm: 165,
      weight_kg: 70,
      target_weight_kg: 65,
      units: "metric",
      timezone: "America/New_York",
    });
  });
});

describe("loading a stored profile", () => {
  it("does not carry a reminder into the form either", () => {
    // A value with no field to show it in and no validator to check it is worse than
    // either having the field or not reading the column.
    const profile = {
      user_id: "user-1",
      display_name: "Aman",
      dob: "1994-01-01",
      sex: "female",
      height_cm: 165,
      weight_kg: 70,
      target_weight_kg: 65,
      activity_level: "moderately_active",
      goal: "lose",
      pace_kg_per_week: 0.5,
      units: "metric",
      dietary_tags: [],
      timezone: "America/New_York",
      reminder_time: "20:00:00",
      protein_g_per_kg: 1.6,
    } as unknown as Profile;

    expect(Object.keys(formFromProfile(profile))).not.toContain("reminder_time");
  });
});
