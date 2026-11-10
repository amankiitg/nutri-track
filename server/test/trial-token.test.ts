/**
 * The trial token: signing, round-tripping, tamper rejection and expiry.
 */
import { createHmac } from "node:crypto";
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
      version: 0,
      firstName: null,
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
      version: 0,
      firstName: null,
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

  it("carries a personal link's version and first name", () => {
    const token = signTrialToken("friend@example.com", SECRET, NOW, {
      version: 3,
      firstName: " Priya ",
    });
    expect(verifyTrialToken(token, SECRET, NOW)).toEqual({
      ok: true,
      email: "friend@example.com",
      version: 3,
      firstName: "Priya",
    });
  });

  it("refuses a link whose payload was edited to name another version or person", () => {
    const token = signTrialToken("friend@example.com", SECRET, NOW, { version: 1 });
    const [, signature] = token.split(".");
    const edited = Buffer.from(
      JSON.stringify({ email: "friend@example.com", exp: NOW / 1000 + 100, v: 2 }),
    ).toString("base64url");
    expect(verifyTrialToken(edited + "." + signature, SECRET, NOW)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("reads a token signed before versions existed as version 0", () => {
    // Exactly what the previous build signed: email and exp, nothing else.
    const payload = Buffer.from(
      JSON.stringify({ email: "early@example.com", exp: NOW / 1000 + 60 }),
    ).toString("base64url");
    const signature = createHmac("sha256", SECRET).update(payload).digest("base64url");
    expect(verifyTrialToken(payload + "." + signature, SECRET, NOW)).toEqual({
      ok: true,
      email: "early@example.com",
      version: 0,
      firstName: null,
    });
  });

  it("refuses a signed token whose version is not a whole number", () => {
    const payload = Buffer.from(
      JSON.stringify({ email: "x@example.com", exp: NOW / 1000 + 60, v: "1" }),
    ).toString("base64url");
    const signature = createHmac("sha256", SECRET).update(payload).digest("base64url");
    expect(verifyTrialToken(payload + "." + signature, SECRET, NOW).ok).toBe(false);
  });
});
