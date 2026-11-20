/**
 * The funnel chain, from the admin function's reply to the numbers the panel draws.
 *
 * The arithmetic is small, which is exactly why it is pinned here rather than in a component
 * test: a percentage of zero, a step that rises, and a missing key are all one-character
 * mistakes away from looking plausible on screen.
 */
import { describe, expect, it } from "vitest";
import { funnelDrop, presentFunnel } from "./admin";

const reply = {
  day: "2026-11-20",
  days: 7,
  window_start: "2026-11-14",
  today: {
    try_page_view: 40,
    analyse_tapped: 12,
    token_issued: 10,
    analysis_ok: 9,
    limit_reached: 2,
    request_invite_submitted: 1,
    turnstile_failed: 3,
    analysis_no_food: 4,
    analysis_error: 1,
  },
  window: {
    try_page_view: 200,
    analyse_tapped: 100,
    token_issued: 90,
    analysis_ok: 80,
    limit_reached: 20,
    request_invite_submitted: 10,
    turnstile_failed: 12,
    analysis_no_food: 9,
    analysis_error: 6,
  },
};

describe("funnelDrop", () => {
  it("is the share of the step above that did not continue", () => {
    expect(funnelDrop(40, 12)).toBe(70);
    expect(funnelDrop(200, 100)).toBe(50);
  });

  it("is null when there was nobody to lose", () => {
    // 0% would read as "everyone continued", which is the opposite of the truth.
    expect(funnelDrop(0, 0)).toBeNull();
    expect(funnelDrop(0, 5)).toBeNull();
  });

  it("is signed when a later step outnumbers an earlier one", () => {
    // The page's two counts are capped at 20 a day per network; the service's are not, so on a
    // shared address the chain genuinely can grow. Clamping this to 0 would hide it.
    expect(funnelDrop(5, 8)).toBe(-60);
  });
});

describe("presentFunnel", () => {
  it("draws the chain in walking order, with today and the week side by side", () => {
    const funnel = presentFunnel(reply);

    expect(funnel.steps.map((step) => step.label)).toEqual([
      "/try views",
      "Analyse",
      "Token",
      "Result",
      "Out of scans",
      "Invite requests",
    ]);
    expect(funnel.steps.map((step) => step.today)).toEqual([40, 12, 10, 9, 2, 1]);
    expect(funnel.steps.map((step) => step.week)).toEqual([200, 100, 90, 80, 20, 10]);
  });

  it("computes each drop against the step above it in the same column", () => {
    const funnel = presentFunnel(reply);

    // Views -> Analyse is 70% lost, and Analyse -> Token is 17% (2 of 12).
    expect(funnel.steps.map((step) => step.dropToday)).toEqual([null, 70, 17, 10, 78, 50]);
    expect(funnel.steps.map((step) => step.dropWeek)).toEqual([null, 50, 10, 11, 75, 50]);
  });

  it("keeps the two events that end a step out of the chain", () => {
    const funnel = presentFunnel(reply);

    // Neither is a stage a visitor walks through, so a drop-off computed through one would be a
    // percentage of the wrong thing.
    expect(funnel.steps.map((step) => step.event)).not.toContain("turnstile_failed");
    expect(funnel.steps.map((step) => step.event)).not.toContain("analysis_error");
    expect(funnel.branches).toEqual([
      { event: "turnstile_failed", label: "Turnstile refusals", today: 3, week: 12 },
      { event: "analysis_no_food", label: "No food found", today: 4, week: 9 },
      { event: "analysis_error", label: "Failed analyses", today: 1, week: 6 },
    ]);
  });

  it("reads a missing event as zero rather than dropping the row", () => {
    // The function builds every allowlisted event into its reply, so this is the defensive case:
    // a row that vanished from the SQL must still draw, at zero, instead of leaving a gap.
    const funnel = presentFunnel({ ...reply, today: { try_page_view: 4 }, window: {} });

    expect(funnel.steps).toHaveLength(6);
    expect(funnel.steps[1]).toMatchObject({ label: "Analyse", today: 0, week: 0, dropToday: 100 });
    expect(funnel.branches.map((branch) => branch.today)).toEqual([0, 0, 0]);
  });
});
