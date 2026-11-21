/**
 * The remembered address, and the comparison that decides whether to warn.
 *
 * Small on purpose: the callback only has to answer "did Google come back as somebody else", and
 * the cost of getting it wrong is a warning shown to the wrong person or no warning at all.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  PENDING_GOOGLE_EMAIL_KEY,
  clearPendingGoogleEmail,
  rememberPendingGoogleEmail,
  signedInAsSomebodyElse,
  takePendingGoogleEmail,
} from "./pending-google-email";

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("the remembered address", () => {
  it("is stored normalised, so casing cannot cause a false warning", () => {
    rememberPendingGoogleEmail("  Aman@Example.COM ");
    expect(window.sessionStorage.getItem(PENDING_GOOGLE_EMAIL_KEY)).toBe("aman@example.com");
  });

  it("is read once and cleared, so a reload shows no stale warning", () => {
    rememberPendingGoogleEmail("a@example.com");

    expect(takePendingGoogleEmail()).toBe("a@example.com");
    expect(takePendingGoogleEmail()).toBeNull();
  });

  it("remembers nothing when the field was empty", () => {
    rememberPendingGoogleEmail("a@example.com");
    rememberPendingGoogleEmail("   ");
    expect(takePendingGoogleEmail()).toBeNull();
  });

  it("can be cleared without being read", () => {
    rememberPendingGoogleEmail("a@example.com");
    clearPendingGoogleEmail();
    expect(takePendingGoogleEmail()).toBeNull();
  });
});

describe("signedInAsSomebodyElse", () => {
  it("is false when the addresses match in any casing", () => {
    expect(signedInAsSomebodyElse("a@example.com", "A@Example.com")).toBe(false);
  });

  it("is true when they differ", () => {
    expect(signedInAsSomebodyElse("a@example.com", "b@example.com")).toBe(true);
  });

  it("is false when either side is unknown, because a guess is not a warning", () => {
    expect(signedInAsSomebodyElse(null, "a@example.com")).toBe(false);
    expect(signedInAsSomebodyElse("a@example.com", null)).toBe(false);
    expect(signedInAsSomebodyElse(null, null)).toBe(false);
  });
});
