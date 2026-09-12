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
import { formFromProfile, toProfileInsert, DEFAULT_ONBOARDING_FORM } from "./onboarding";
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
