/**
 * When "you're at your target weight" is allowed to be said.
 *
 * The notice is a decision, not a sentence, so the decision is a pure function and this is the
 * whole of it. The cases below are the ones that were wrong or would be: one low weigh-in, a
 * week that is not a trend yet, a target reached by crossing, and a dismissal that has to last a
 * week without swallowing the moment the person actually arrives.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { lbToKg } from "./units";
import {
  MAINTAIN_DISMISS_KEY_PREFIX,
  MAINTAIN_QUIET_DAYS,
  MAINTAIN_TOLERANCE_KG,
  maintainSuggestion,
  readMaintainDismissal,
  saveMaintainDismissal,
  type MaintainDismissal,
} from "./maintain-suggestion";

const TODAY = "2026-11-12";

function suggestion(over: Partial<Parameters<typeof maintainSuggestion>[0]> = {}) {
  return maintainSuggestion({
    goal: "lose",
    averageKg: 69.5,
    readings: 5,
    targetKg: 70,
    dismissed: null,
    today: TODAY,
    ...over,
  });
}

describe("the average, not the last weigh-in", () => {
  it("says nothing from a single low weigh-in", () => {
    // One reading is a morning, not a trend, however far below the target it sits.
    expect(suggestion({ averageKg: 65, readings: 1 })).toBeNull();
  });

  it("says nothing with two readings either", () => {
    expect(suggestion({ averageKg: 69.5, readings: 2 })).toBeNull();
  });

  it("says so from three readings at the target", () => {
    expect(suggestion({ averageKg: 69.5, readings: 3 })).toEqual({
      averageKg: 69.5,
      crossed: false,
    });
  });
});

describe("how near counts as arrived", () => {
  it("counts the tolerance itself", () => {
    expect(suggestion({ averageKg: 70 - MAINTAIN_TOLERANCE_KG })).not.toBeNull();
    expect(suggestion({ averageKg: 70 + MAINTAIN_TOLERANCE_KG })).not.toBeNull();
  });

  it("counts a fraction of a pound, which is where the brief put it", () => {
    // A 170 lb target and a 169.4 lb average: 0.6 lb away, inside the one-pound band.
    expect(suggestion({ averageKg: lbToKg(169.4), targetKg: lbToKg(170) })).not.toBeNull();
    // 171.5 lb is 1.5 lb above a 170 lb target and still losing: nothing to say yet.
    expect(suggestion({ averageKg: lbToKg(171.5), targetKg: lbToKg(170) })).toBeNull();
  });

  it("stays quiet beyond the tolerance on the approach side", () => {
    expect(suggestion({ averageKg: 70.6 })).toBeNull();
  });

  it("says so once the average has crossed the target", () => {
    expect(suggestion({ averageKg: 68 })).toEqual({ averageKg: 68, crossed: true });
  });

  it("keeps the gain direction mirrored", () => {
    const gain = (averageKg: number) => suggestion({ goal: "gain", averageKg, targetKg: 70 });
    expect(gain(69.59)).not.toBeNull();
    expect(gain(68)).toBeNull();
    expect(gain(71.2)).toEqual({ averageKg: 71.2, crossed: true });
  });

  it("has nothing to say about maintain, or about no goal", () => {
    expect(suggestion({ goal: "maintain" })).toBeNull();
    expect(suggestion({ goal: null })).toBeNull();
  });

  it("has nothing to say without a target or an average", () => {
    expect(suggestion({ targetKg: null })).toBeNull();
    expect(suggestion({ averageKg: null })).toBeNull();
  });
});

describe("a dismissal", () => {
  const atTarget: MaintainDismissal = { targetKg: 70, averageKg: 69.5, dismissedOn: "2026-11-10" };

  it("stays quiet for its week", () => {
    expect(suggestion({ averageKg: 69.4, dismissed: atTarget })).toBeNull();
  });

  it("comes back when the week is up", () => {
    const weekAgo: MaintainDismissal = { ...atTarget, dismissedOn: "2026-11-05" };
    const days = 7;
    expect(MAINTAIN_QUIET_DAYS).toBe(days);
    expect(suggestion({ averageKg: 69.4, dismissed: weekAgo })).not.toBeNull();
  });

  it("is interrupted by the average crossing the target", () => {
    // Dismissed while 0.4 kg short, then it crossed: that is the moment it was waiting for.
    const short: MaintainDismissal = { targetKg: 70, averageKg: 70.4, dismissedOn: "2026-11-10" };
    expect(suggestion({ averageKg: 69.9, dismissed: short })).not.toBeNull();
  });

  it("is not interrupted by a crossing it already saw", () => {
    // Dismissed after arriving. Continuing to arrive is not news.
    expect(suggestion({ averageKg: 69.3, dismissed: atTarget })).toBeNull();
  });

  it("does not follow a changed target", () => {
    expect(suggestion({ averageKg: 79.6, targetKg: 80, dismissed: atTarget })).not.toBeNull();
  });
});

describe("remembering the dismissal", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips one account's record", () => {
    const record: MaintainDismissal = { targetKg: 70, averageKg: 69.5, dismissedOn: TODAY };
    saveMaintainDismissal("user-1", record);

    expect(readMaintainDismissal("user-1")).toEqual(record);
    expect(window.localStorage.getItem(`${MAINTAIN_DISMISS_KEY_PREFIX}.user-1`)).not.toBeNull();
  });

  it("does not hand one account another's record", () => {
    saveMaintainDismissal("user-1", {
      targetKg: 70,
      averageKg: 69.5,
      dismissedOn: TODAY,
    });

    expect(readMaintainDismissal("user-2")).toBeNull();
  });

  it("treats a malformed value as no dismissal at all", () => {
    window.localStorage.setItem(`${MAINTAIN_DISMISS_KEY_PREFIX}.user-1`, "not json");
    expect(readMaintainDismissal("user-1")).toBeNull();

    window.localStorage.setItem(
      `${MAINTAIN_DISMISS_KEY_PREFIX}.user-1`,
      JSON.stringify({ targetKg: "70", averageKg: 69.5, dismissedOn: TODAY }),
    );
    expect(readMaintainDismissal("user-1")).toBeNull();
  });

  it("does nothing at all without a user", () => {
    expect(readMaintainDismissal("")).toBeNull();
    saveMaintainDismissal("", { targetKg: 70, averageKg: 69.5, dismissedOn: TODAY });
    expect(window.localStorage.length).toBe(0);
  });
});
