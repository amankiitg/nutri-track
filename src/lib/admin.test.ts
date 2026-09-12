/**
 * The pure half of the admin page.
 *
 * The normalisation tests are the important ones. An address that is stored in a form the
 * lookup cannot match is the worst outcome available here: it looks added, the admin
 * considers it done, and the person it was meant for stays locked out with no visible
 * reason. So the rule is pinned down on both sides of the boundary — what this file
 * produces, and (in the migration) what the database will accept.
 */
import { describe, expect, it } from "vitest";
import { MAX_LLM_CALLS_PER_DAY } from "@shared/meal-parse";
import {
  formatCount,
  inviteStatus,
  isPlausibleEmail,
  normalizeEmail,
  pendingCount,
  presentSpend,
  readableAdminError,
  requestStatus,
  sortRequests,
  type Invite,
  type InviteRequest,
  type UserSpend,
} from "./admin";

describe("normalizeEmail", () => {
  it("matches the rule the database enforces: lower(trim(email))", () => {
    expect(normalizeEmail("  Aman.IITG@Gmail.COM ")).toBe("aman.iitg@gmail.com");
  });

  it("leaves an already normal address alone", () => {
    expect(normalizeEmail("aman.iitg@gmail.com")).toBe("aman.iitg@gmail.com");
  });

  it("does not strip dots, which is a Gmail quirk the list does not share", () => {
    // 20260911130100 made the same choice deliberately.
    expect(normalizeEmail("a.b.c@example.com")).toBe("a.b.c@example.com");
  });
});

describe("isPlausibleEmail", () => {
  it.each(["aman@example.com", "A.B+tag@sub.example.co.uk", " a@b.co "])("accepts %s", (input) => {
    expect(isPlausibleEmail(input)).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["aman", "no at sign"],
    ["@example.com", "nothing before the at sign"],
    ["aman@", "nothing after it"],
    ["aman example.com", "a space in the middle"],
    ["aman@example", "no dot in the domain"],
  ])("rejects %s (%s)", (input) => {
    expect(isPlausibleEmail(input)).toBe(false);
  });

  it("is applied to the normalised form, so padding cannot sneak past it", () => {
    expect(isPlausibleEmail("  aman@example.com  ")).toBe(true);
    expect(isPlausibleEmail("  aman @example.com  ")).toBe(false);
  });
});

describe("presentSpend", () => {
  const base: UserSpend = {
    userId: "u1",
    email: "aman@example.com",
    timeZone: "America/New_York",
    callsToday: 11,
    resetsToday: "2026-09-12T04:00:00.000Z",
    callsMonth: 38,
    tokensMonth: 150_045,
    callsTotal: 1_203,
    tokensTotal: 4_511_002,
    lastCallAt: "2026-09-07T18:02:00.000Z",
  };

  it("counts down from the same limit the service enforces", () => {
    const shown = presentSpend(base);
    expect(shown.today).toBe(
      `${MAX_LLM_CALLS_PER_DAY - 11} of ${MAX_LLM_CALLS_PER_DAY} left today`,
    );
    expect(shown.exhausted).toBe(false);
  });

  it("says so plainly when the day is used up", () => {
    const shown = presentSpend({ ...base, callsToday: MAX_LLM_CALLS_PER_DAY });
    expect(shown.exhausted).toBe(true);
    expect(shown.today).toContain("All");
    expect(shown.todayFraction).toBe(1);
  });

  it("never reports more than full, however stale the read", () => {
    expect(presentSpend({ ...base, callsToday: MAX_LLM_CALLS_PER_DAY + 9 }).todayFraction).toBe(1);
  });

  it("shows tokens with separators and no currency", () => {
    const shown = presentSpend(base);
    expect(shown.month).toBe("38 calls · 150,045 tokens this month");
    expect(shown.total).toBe("1,203 calls · 4,511,002 tokens all time");
    // A price anywhere in here would be a rate card baked into the UI.
    expect(shown.month).not.toMatch(/[$£€]/);
  });

  it("says Never rather than showing an empty date", () => {
    expect(presentSpend({ ...base, lastCallAt: null }).lastUsed).toBe("Never analysed a meal");
  });
});

describe("formatCount", () => {
  it("groups thousands so six-digit token counts stay readable", () => {
    expect(formatCount(4_511_002)).toBe("4,511,002");
    expect(formatCount(0)).toBe("0");
  });
});

describe("inviteStatus", () => {
  const invite: Invite = {
    email: "a@b.co",
    addedBy: null,
    createdAt: "2026-09-07T12:00:00.000Z",
    signedUpAt: null,
    userId: null,
    isAdmin: false,
  };

  it("distinguishes invited from arrived, which is the whole point of the join", () => {
    expect(inviteStatus(invite)).toEqual({ label: "Invited, not arrived", tone: "silent" });
    expect(inviteStatus({ ...invite, signedUpAt: "2026-09-09T12:00:00.000Z" })).toEqual({
      label: "Joined",
      tone: "joined",
    });
  });

  it("says when an account is also an admin, since that is not visible anywhere else", () => {
    const joined = { ...invite, signedUpAt: "2026-09-09T12:00:00.000Z", isAdmin: true };
    expect(inviteStatus(joined).label).toBe("Joined · admin");
  });
});

describe("requestStatus", () => {
  const request: InviteRequest = {
    id: "r1",
    email: "a@b.co",
    requestedAt: "2026-09-11T12:00:00.000Z",
    status: "pending",
    handledAt: null,
  };

  it.each([
    ["pending", "Waiting"],
    ["approved", "Approved"],
    ["declined", "Declined"],
  ])("calls %s %s", (status, label) => {
    expect(requestStatus({ ...request, status }).label).toBe(label);
  });
});

describe("sortRequests", () => {
  const at = (id: string, status: string, requestedAt: string): InviteRequest => ({
    id,
    email: `${id}@b.co`,
    requestedAt,
    status,
    handledAt: null,
  });

  it("puts pending first, then newest first, because that is the order they are worked", () => {
    const sorted = sortRequests([
      at("old-pending", "pending", "2026-09-01T00:00:00.000Z"),
      at("new-approved", "approved", "2026-09-10T00:00:00.000Z"),
      at("new-pending", "pending", "2026-09-09T00:00:00.000Z"),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["new-pending", "old-pending", "new-approved"]);
  });

  it("does not mutate the array it was given", () => {
    const input = [
      at("a", "approved", "2026-09-01T00:00:00.000Z"),
      at("b", "pending", "2026-09-02T00:00:00.000Z"),
    ];
    const before = input.map((r) => r.id);
    sortRequests(input);
    expect(input.map((r) => r.id)).toEqual(before);
  });
});

describe("pendingCount", () => {
  it("counts only what still needs a decision", () => {
    const requests: InviteRequest[] = [
      { id: "1", email: "a@b.co", requestedAt: "", status: "pending", handledAt: null },
      { id: "2", email: "c@d.co", requestedAt: "", status: "approved", handledAt: null },
      { id: "3", email: "e@f.co", requestedAt: "", status: "pending", handledAt: null },
    ];
    expect(pendingCount(requests)).toBe(2);
  });
});

describe("readableAdminError", () => {
  it("names the two things an admin can do something about", () => {
    expect(readableAdminError("duplicate key value violates unique constraint")).toBe(
      "That address is already on the list.",
    );
    expect(readableAdminError("admin only")).toBe(
      "That needs an admin account, and this one is not one.",
    );
    expect(readableAdminError("new row violates row-level security policy")).toBe(
      "That needs an admin account, and this one is not one.",
    );
  });

  it("keeps the raw text as a fallback rather than swallowing it", () => {
    expect(readableAdminError("connection reset")).toContain("connection reset");
  });
});
