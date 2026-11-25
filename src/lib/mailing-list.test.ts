/**
 * The two sentences the admin card prints. Pure, so they are tested without a session.
 */
import { describe, expect, it } from "vitest";
import { mailingListSummary, syncResultLine, type MailingListState } from "./mailing-list";

function state(overrides: Partial<MailingListState> = {}): MailingListState {
  return {
    lastSyncAt: "2026-11-21T06:00:00Z",
    checked: 0,
    added: 0,
    already: 0,
    names: 0,
    failed: 0,
    excluded: 0,
    unsubscribed: 0,
    firstError: null,
    ...overrides,
  };
}

describe("mailingListSummary", () => {
  it("says plainly that a list nobody has synced has not been synced", () => {
    expect(mailingListSummary(state({ lastSyncAt: null }))).toBe("Never synced.");
  });

  it("prints the time, every counter, and the totals", () => {
    const line = mailingListSummary(
      state({ checked: 9, added: 2, already: 6, names: 1, excluded: 3, unsubscribed: 1 }),
    );
    expect(line).toMatch(
      /^Last synced .+\. 9 checked: 2 added, 6 already up to date, 1 name filled in\. 3 excluded, 1 unsubscribed\.$/,
    );
  });

  /**
   * The shape of the 25 Nov run, which the old card could not describe: it said "0 synced" and
   * nothing distinguished that from a run that read no rows or a run that failed on every one.
   */
  it("tells an idle run from a run that read nothing at all", () => {
    const idle = mailingListSummary(state({ checked: 52, already: 52 }));
    expect(idle).toContain("52 checked: 0 added, 52 already up to date, 0 names filled in.");

    const empty = mailingListSummary(state({ checked: 0 }));
    expect(empty).toContain("0 checked: 0 added, 0 already up to date, 0 names filled in.");
  });

  it("names the first refusal rather than pointing at a log", () => {
    const line = mailingListSummary(
      state({
        checked: 5,
        already: 3,
        failed: 2,
        firstError: "Resend contact create failed (422)",
      }),
    );
    expect(line).toMatch(/2 contacts refused, first: Resend contact create failed \(422\)$/);
  });

  it("counts a single refusal in the singular", () => {
    const line = mailingListSummary(state({ checked: 1, failed: 1, firstError: "refused" }));
    expect(line).toContain("1 contact refused, first: refused");
  });

  it("still says something when the service would not say why", () => {
    const line = mailingListSummary(state({ checked: 1, failed: 1, firstError: null }));
    expect(line).toContain("1 contact refused, first: the service did not say why");
  });
});

describe("syncResultLine", () => {
  it("says nothing about refusals when there were none", () => {
    expect(
      syncResultLine({
        checked: 9,
        added: 2,
        alreadyUpToDate: 6,
        namesUpdated: 1,
        failed: 0,
        firstError: null,
        excluded: 3,
        unsubscribed: 1,
      }),
    ).toBe(
      "9 checked: 2 added, 6 already up to date, 1 name filled in. 3 excluded, 1 unsubscribed.",
    );
  });

  it("names the first refusal in the toast itself", () => {
    expect(
      syncResultLine({
        checked: 9,
        added: 2,
        alreadyUpToDate: 5,
        namesUpdated: 0,
        failed: 2,
        firstError: "Resend contact update failed (500)",
        excluded: 3,
        unsubscribed: 1,
      }),
    ).toBe(
      "9 checked: 2 added, 5 already up to date, 0 names filled in. 3 excluded, 1 unsubscribed. 2 contacts refused, first: Resend contact update failed (500).",
    );
  });

  it("plurals a single name", () => {
    expect(
      syncResultLine({
        checked: 1,
        added: 0,
        alreadyUpToDate: 0,
        namesUpdated: 1,
        failed: 0,
        firstError: null,
        excluded: 0,
        unsubscribed: 0,
      }),
    ).toContain("1 name filled in");
  });
});
