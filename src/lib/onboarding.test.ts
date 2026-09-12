/**
 * The reminder's two representations, and the rule that reconciles them.
 *
 * `profiles.reminder_time` is `time without time zone`, which PostgREST serialises as
 * `20:00:00`. The form, the validator and the input all speak `HH:MM`. These tests pin the
 * boundary between the two, because the bug they exist for was exactly a value that went
 * out in one form and came back in another.
 */
import { describe, expect, it } from "vitest";
import { normalizeTimeOfDay, validateForm, type OnboardingForm } from "./onboarding";

/** A form that passes everything else, so a failure here is about the reminder. */
const COMPLETE_FORM: OnboardingForm = {
  display_name: "Aman",
  dob: "1994-01-01",
  sex: "female",
  height_cm: 165,
  weight_kg: 70,
  units: "metric",
  activity_level: "moderately_active",
  goal: "lose",
  target_weight_kg: 65,
  pace_kg_per_week: 0.5,
  protein_g_per_kg: 1.6,
  dietary_tags: [],
  timezone: "America/New_York",
  reminder_time: "",
};

describe("normalizeTimeOfDay", () => {
  it.each([
    ["20:00:00", "20:00", "what the time column round-trips as"],
    ["20:00", "20:00", "already normal"],
    [" 19:30 ", "19:30", "padded, because inputs and databases pad differently"],
    ["9:05", "09:05", "a single-digit hour"],
    ["00:00", "00:00", "midnight"],
    ["23:59", "23:59", "the last minute of the day"],
    ["19:30:45", "19:30", "seconds that are not zero"],
    ["", "", "no reminder at all"],
  ])("turns %s into %s (%s)", (input, expected) => {
    expect(normalizeTimeOfDay(input)).toBe(expected);
  });

  it.each([["25:00"], ["19:60"], ["8pm"], ["19"], ["19.30"], ["not a time"]])(
    "leaves %s alone, so the validator can complain about it",
    (input) => {
      // Coercing an unrecognised value to "" would silently delete a reminder the user
      // meant to set. Refusing it is louder and recoverable.
      expect(normalizeTimeOfDay(input)).toBe(input);
    },
  );
});

describe("validateForm and the reminder", () => {
  it("accepts the form the database hands back", () => {
    // The regression. This is the value a saved reminder comes back as, and the form used
    // to reject it — leaving Settings invalid on load and blaming a field nobody touched.
    expect(validateForm({ ...COMPLETE_FORM, reminder_time: "20:00:00" })).toEqual({});
  });

  it.each([["20:00"], [""], ["00:00"]])("accepts %s", (reminder) => {
    expect(validateForm({ ...COMPLETE_FORM, reminder_time: reminder })).toEqual({});
  });

  it("still refuses something that is not a time", () => {
    const errors = validateForm({ ...COMPLETE_FORM, reminder_time: "8pm" });
    expect(errors.reminder_time).toBe("Use a time like 19:30.");
  });

  it("still refuses a time that does not exist", () => {
    expect(validateForm({ ...COMPLETE_FORM, reminder_time: "25:00" }).reminder_time).toBeDefined();
  });
});
