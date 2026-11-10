/**
 * The signed trial token: an HMAC over an email and an expiry, valid for 30 days.
 *
 * Issued by the server once a visitor proves their email code, kept in localStorage so
 * a returning visitor skips the email step. The browser never has the signing key; it
 * only carries the token back, and the server re-checks the signature and the expiry
 * on every use.
 *
 * Pure and clock-injectable, so signing and expiry are unit tested without a key in a
 * fixture or a wall clock to wait on.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const TRIAL_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface TrialTokenPayload {
  email: string;
  /** Seconds since the epoch, when the token stops being accepted. */
  exp: number;
}

export function signTrialToken(email: string, secret: string, nowMs: number = Date.now()): string {
  const payload: TrialTokenPayload = {
    email,
    exp: Math.floor(nowMs / 1000) + TRIAL_TOKEN_TTL_SECONDS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return payloadB64 + "." + signature;
}

export type TrialTokenResult =
  { ok: true; email: string } | { ok: false; reason: "invalid" | "expired" };

/**
 * Verifies the token and returns the email it names.
 *
 * The signature is compared in constant time, so a wrong key cannot be found by
 * timing. The expiry is checked against the injected clock, so a test can freeze it.
 */
export function verifyTrialToken(
  token: string,
  secret: string,
  nowMs: number = Date.now(),
): TrialTokenResult {
  const dot = token.indexOf(".");
  if (dot <= 0) return { ok: false, reason: "invalid" };

  const payloadB64 = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(payloadB64).digest("base64url");

  const actual = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
    return { ok: false, reason: "invalid" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid" };
  }

  const record = payload as { email?: unknown; exp?: unknown };
  if (typeof record.email !== "string" || record.email === "") {
    return { ok: false, reason: "invalid" };
  }
  if (typeof record.exp !== "number" || record.exp <= Math.floor(nowMs / 1000)) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, email: record.email };
}
