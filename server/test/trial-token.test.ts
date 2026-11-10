/**
 * The trial token: signing, round-tripping, tamper rejection and expiry.
 */
import { describe, expect, it } from "vitest";
import { signTrialToken, TRIAL_TOKEN_TTL_SECONDS, verifyTrialToken } from "../src/trial-token";

const SECRET = "trial-secret-for-tests";
const NOW = Date.UTC(2026, 2, 2, 12, 0, 0);

describe("signTrialToken / verifyTrialToken", () => {
  it("round-trips the email it signed", () => {
    const token = signTrialToken("trial@example.com", SECRET, NOW);
    expect(verifyTrialToken(token, SECRET, NOW)).toEqual({
      ok: true,
      email: "trial@example.com",
    });
  });

  it("rejects a token signed with a different secret", () => {
    const token = signTrialToken("trial@example.com", SECRET, NOW);
    expect(verifyTrialToken(token, "a-different-secret", NOW)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects a tampered token", () => {
    const token = signTrialToken("trial@example.com", SECRET, NOW);
    const tampered = token.slice(0, -2) + "zz";
    expect(verifyTrialToken(tampered, SECRET, NOW).ok).toBe(false);
  });

  it("rejects a token whose signature was removed", () => {
    expect(verifyTrialToken("not-a-token", SECRET, NOW).ok).toBe(false);
  });

  it("is valid for 30 days and expired the moment the 30 days are up", () => {
    const token = signTrialToken("trial@example.com", SECRET, NOW);
    const atExpiry = NOW + TRIAL_TOKEN_TTL_SECONDS * 1000;
    expect(verifyTrialToken(token, SECRET, atExpiry - 1000)).toEqual({
      ok: true,
      email: "trial@example.com",
    });
    expect(verifyTrialToken(token, SECRET, atExpiry)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("refuses a token whose payload is not JSON", () => {
    const forged = Buffer.from("not-json").toString("base64url") + "." + "bad";
    expect(verifyTrialToken(forged, SECRET, NOW).ok).toBe(false);
  });
});
