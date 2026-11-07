/**
 * The choices the form asks for, and the ones it will not make up.
 *
 * Four rules live here, all of them about a value the form used to assume: sex and goal have no
 * default any more, a target on the wrong side of the current weight is refused, the device
 * suggests a unit system but never decides one, and the age window has its own sentence.
 *
 * They are pure, so they are tested here rather than through a screen; the wizard's own tests prove
 * that each one stops Continue.
 */
import { describe, expect, it } from "vitest";
import {
  CHOOSE_ONE,
  DEFAULT_ONBOARDING_FORM,
  MAX_AGE,
  MIN_AGE,
  defaultUnits,
  firstInvalidStep,
  loadOnboardingDraft,
  saveOnboardingDraft,
  targetDirectionMessage,
  validateForm,
  validateStep,
  type OnboardingForm,
} from "./onboarding";
import { targetProximity } from "./targets";

/** Everything but the two choices, so a test can add one and watch what the other does. */
const FILLED: OnboardingForm = {
  ...DEFAULT_ONBOARDING_FORM,
  display_name: "Aman",
  dob: "1994-01-01",
  height_cm: 165,
  weight_kg: 70,
};

const ABOVE = "Your target is above your current weight. Choose Gain weight, or lower the target.";
const BELOW = "Your target is below your current weight. Choose Lose weight, or raise the target.";

describe("a target on the wrong side of the current weight", () => {
  it("asks a losing goal to lower the target rather than raise it", () => {
    expect(targetDirectionMessage({ goal: "lose", weight_kg: 70, target_weight_kg: 75 })).toBe(
      ABOVE,
    );
  });

  it("asks a gaining goal to raise the target rather than lower it", () => {
    expect(targetDirectionMessage({ goal: "gain", weight_kg: 70, target_weight_kg: 65 })).toBe(
      BELOW,
    );
  });

  it("says nothing when the target is the weight they already are", () => {
    // Being at your target is not a direction error. The sentence that used to live here pointed at
    // Maintain, and it fired next to "you're at your target weight", which is the pair this split.
    // The advice now belongs to the notice, on the two screens that show it.
    expect(
      targetDirectionMessage({ goal: "lose", weight_kg: 72, target_weight_kg: 72 }),
    ).toBeNull();
    expect(
      targetDirectionMessage({ goal: "gain", weight_kg: 72, target_weight_kg: 72 }),
    ).toBeNull();
    expect(targetProximity("lose", 72, 72)).toBe("at_target");
    expect(targetProximity("gain", 72, 72)).toBe("at_target");
  });

  it("still refuses a target a whole kilogram past the weight", () => {
    // The tolerance is what separates the two messages, so its edge is worth pinning: 1 kg is
    // "there", 1.1 kg is the wrong side.
    expect(
      targetDirectionMessage({ goal: "lose", weight_kg: 77, target_weight_kg: 78 }),
    ).toBeNull();
    expect(targetDirectionMessage({ goal: "lose", weight_kg: 77, target_weight_kg: 78.1 })).toBe(
      ABOVE,
    );
  });

  it("says nothing about a target on the right side", () => {
    expect(
      targetDirectionMessage({ goal: "lose", weight_kg: 70, target_weight_kg: 65 }),
    ).toBeNull();
    expect(
      targetDirectionMessage({ goal: "gain", weight_kg: 70, target_weight_kg: 75 }),
    ).toBeNull();
  });

  it("says nothing for maintain, which has no side to be on", () => {
    expect(
      targetDirectionMessage({ goal: "maintain", weight_kg: 70, target_weight_kg: 75 }),
    ).toBeNull();
  });

  it("says nothing until a goal and two weights are all present", () => {
    expect(targetDirectionMessage({ goal: null, weight_kg: 70, target_weight_kg: 75 })).toBeNull();
    expect(
      targetDirectionMessage({ goal: "lose", weight_kg: null, target_weight_kg: 75 }),
    ).toBeNull();
    expect(
      targetDirectionMessage({ goal: "lose", weight_kg: 70, target_weight_kg: null }),
    ).toBeNull();
  });

  it("says nothing when the target is within a kilogram, which is the round-trip case", () => {
    // 160 lb is 72.5748 kg, and a target typed as 160 lb comes back as 72.6 kg. A difference of
    // 25 g must not read as "above your current weight" and send somebody back to the unit select;
    // that is what the kilogram of tolerance is for.
    expect(
      targetDirectionMessage({ goal: "lose", weight_kg: 72.5748, target_weight_kg: 72.6 }),
    ).toBeNull();
  });

  it("stops a whole form being saved with the target on the wrong side", () => {
    // This is the Settings path: it validates the whole form rather than one step.
    const errors = validateForm({ ...FILLED, sex: "female", goal: "lose", target_weight_kg: 75 });
    expect(errors.target_weight_kg).toBe(ABOVE);
  });

  it("stops the goal step, and says it on the target field", () => {
    const errors = validateStep("goal", {
      ...FILLED,
      sex: "female",
      goal: "gain",
      target_weight_kg: 65,
    });
    expect(errors.target_weight_kg).toBe(BELOW);
  });

  it("still reaches the BMI floor for a target on the right side", () => {
    // 40 kg at 165 cm is the floor question, not the direction one.
    const errors = validateStep("goal", {
      ...FILLED,
      sex: "female",
      goal: "lose",
      target_weight_kg: 40,
    });
    expect(errors.target_weight_kg).toMatch(/below a BMI of 18.5/i);
  });
});

describe("nothing is chosen for you", () => {
  it("has no default sex and no default goal", () => {
    expect(DEFAULT_ONBOARDING_FORM.sex).toBeNull();
    expect(DEFAULT_ONBOARDING_FORM.goal).toBeNull();
  });

  it("asks for a sex on the about step", () => {
    expect(validateStep("about", FILLED).sex).toBe(CHOOSE_ONE);
  });

  it("accepts the about step once a sex is chosen", () => {
    expect(validateStep("about", { ...FILLED, sex: "female" })).toEqual({});
  });

  it("asks for a goal on the goal step", () => {
    expect(validateStep("goal", FILLED).goal).toBe(CHOOSE_ONE);
  });

  it("accepts the goal step once a goal is chosen", () => {
    expect(validateStep("goal", { ...FILLED, sex: "male", goal: "maintain" })).toEqual({});
  });

  it("asks for both in a whole-form save, as Settings does", () => {
    const errors = validateForm(FILLED);
    expect(errors.sex).toBe(CHOOSE_ONE);
    expect(errors.goal).toBe(CHOOSE_ONE);
  });
});

describe("the age window", () => {
  it("names the range in one sentence under the field", () => {
    expect(validateStep("about", { ...FILLED, sex: "female", dob: "2014-01-01" }).dob).toBe(
      `You must be between ${MIN_AGE} and ${MAX_AGE} to use NutriTrack.`,
    );
    expect(validateStep("about", { ...FILLED, sex: "female", dob: "1900-01-01" }).dob).toBe(
      `You must be between ${MIN_AGE} and ${MAX_AGE} to use NutriTrack.`,
    );
  });

  it("says nothing about an age inside the window", () => {
    expect(validateStep("about", { ...FILLED, sex: "female" }).dob).toBeUndefined();
  });
});

describe("the unit system a device suggests", () => {
  it("suggests imperial for a page served in en-US, whatever the zone", () => {
    expect(defaultUnits("Europe/London", "en-US")).toBe("imperial");
    expect(defaultUnits("UTC", "en-US")).toBe("imperial");
  });

  it("suggests imperial for a US time zone", () => {
    expect(defaultUnits("America/New_York", "en-GB")).toBe("imperial");
    expect(defaultUnits("America/Los_Angeles", "es-MX")).toBe("imperial");
    expect(defaultUnits("Pacific/Honolulu", "en-GB")).toBe("imperial");
  });

  it("keeps metric for the Americas that are not the United States", () => {
    // The naive rule — "America/ means imperial" — is wrong for every one of these, and wrong in a
    // way the person then has to notice and undo.
    for (const zone of [
      "America/Toronto",
      "America/Sao_Paulo",
      "America/Mexico_City",
      "America/Bogota",
      "America/Argentina/Buenos_Aires",
    ]) {
      expect(defaultUnits(zone, "en-CA")).toBe("metric");
    }
  });

  it("keeps metric for everything else", () => {
    expect(defaultUnits("Europe/Berlin", "de-DE")).toBe("metric");
    expect(defaultUnits("Asia/Kolkata", "en-IN")).toBe("metric");
    expect(defaultUnits("UTC", "")).toBe("metric");
  });
});

describe("where a form that fails should open", () => {
  const SOUND: OnboardingForm = {
    ...FILLED,
    sex: "female",
    goal: "lose",
    target_weight_kg: 65,
  };

  it("has nothing to report about a form that holds", () => {
    expect(firstInvalidStep(SOUND)).toBeNull();
  });

  it("reports the goal step for the draft that exposed the gap", () => {
    // Goal lose, target 85 kg, weight 77 kg: saved on Review, refused by a later rule.
    const problem = firstInvalidStep({ ...SOUND, target_weight_kg: 85 });

    expect(problem?.step).toBe("goal");
    expect(problem?.errors.target_weight_kg).toBe(ABOVE);
  });

  it("reports the earlier of two failing steps, because that is the one to open", () => {
    const problem = firstInvalidStep({ ...SOUND, sex: null, target_weight_kg: 85 });

    expect(problem?.step).toBe("about");
    expect(problem?.errors.sex).toBe(CHOOSE_ONE);
  });

  it("never reports Review itself, which has no answers of its own to check", () => {
    // The step is a summary, so a form that fails must be attributed to a step that asks something.
    for (const problem of [firstInvalidStep({ ...SOUND, target_weight_kg: 85 })]) {
      expect(problem?.step).not.toBe("review");
    }
  });
});

describe("a draft is written before there is anything valid to write", () => {
  it("comes back rather than being thrown away on load", () => {
    // The wizard saves on every keystroke, so the first thing it ever stores has an empty name and
    // no sex chosen. Parsing that with the rules a save uses threw the draft away in silence, and
    // the person started again from nothing.
    const midStep: OnboardingForm = {
      ...DEFAULT_ONBOARDING_FORM,
      display_name: "",
      dob: "",
      height_cm: null,
      weight_kg: null,
    };
    saveOnboardingDraft({ step: "about", form: midStep });

    const loaded = loadOnboardingDraft();

    expect(loaded?.step).toBe("about");
    expect(loaded?.form.sex).toBeNull();
    expect(loaded?.form.height_cm).toBeNull();
  });

  it("keeps a half-typed name and a stale target while the person is inside", () => {
    saveOnboardingDraft({
      step: "goal",
      form: { ...FILLED, display_name: "Ad", sex: "female", goal: "lose", target_weight_kg: 85 },
    });

    const loaded = loadOnboardingDraft();

    expect(loaded?.form.display_name).toBe("Ad");
    expect(loaded?.form.target_weight_kg).toBe(85);
  });
});
