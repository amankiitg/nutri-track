/**
 * The two sentences the admin card prints. Pure, so they are tested without a session.
 */
import { describe, expect, it } from "vitest";
import { mailingListSummary, syncResultLine } from "./mailing-list";

describe("mailingListSummary", () => {
  it("says plainly that a list nobody has synced has not been synced", () => {
    expect(
      mailingListSummary({
        lastSyncAt: null,
        contacts: 0,
        excluded: 0,
        unsubscribed: 0,
      }),
    ).toBe("Never synced. 0 synced, 0 excluded, 0 unsubscribed.");
  });

  it("prints the time and the three counts after a run", () => {
    const line = mailingListSummary({
      lastSyncAt: "2026-11-21T06:00:00Z",
      contacts: 4,
      excluded: 3,
      unsubscribed: 1,
    });
    expect(line).toMatch(/^Last synced .+\. 4 synced, 3 excluded, 1 unsubscribed\.$/);
  });
});

describe("syncResultLine", () => {
  it("says nothing about refusals when there were none", () => {
    expect(syncResultLine({ contacts: 4, failed: 0, excluded: 3, unsubscribed: 1 })).toBe(
      "4 synced, 3 excluded, 1 unsubscribed.",
    );
  });

  it("names the refusals and points at the log", () => {
    expect(syncResultLine({ contacts: 4, failed: 2, excluded: 3, unsubscribed: 1 })).toBe(
      "4 synced, 3 excluded, 1 unsubscribed. 2 refused; see the service log.",
    );
  });
});
