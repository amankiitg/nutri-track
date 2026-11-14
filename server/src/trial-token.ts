/**
 * The signed trial token: an HMAC over either an email or an anonymous device id, an
 * expiry, a version and (for a personal link) a first name, valid for 30 days.
 *
 * Two shapes share one signature and one secret:
 *
 *   email token     issued after a visitor proves an email code, or by an admin as a
 *                   personal link (/t/<token>), and kept in localStorage. The email is
 *                   the identity, and its version is the mailbox's revocation.
 *   device token    issued after Turnstile to a browser that gave no email. It names a
 *                   trial_devices row, which is the scan counter. Its version is that
 *                   row's revoke, unused today but the same mechanism.
 *
 * The browser never has the signing key; it only carries the token back, and the server
 * re-checks the signature and the expiry on every use. Verification returns a
 * discriminated result so the routes cannot mistake one kind for the other: an email
 * token can never be spent as a device, and a device token can never be mistaken for a
 * mailbox.
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
  /** trial_users.token_version when the token was signed. */
  v: number;
  /** The name a personal link greets with, when the admin gave one. */
  n?: string;
}

export interface AnonymousTrialTokenPayload {
  /** The trial_devices row this browser may spend scans from. */
  a: string;
  exp: number;
  /** trial_devices.token_version when the token was signed. */
  v: number;
}

export interface TrialTokenOptions {
  version?: number;
  firstName?: string | null;
}

function signPayload(
  payload: TrialTokenPayload | AnonymousTrialTokenPayload,
  secret: string,
): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return payloadB64 + "." + signature;
}

export function signTrialToken(
  email: string,
  secret: string,
  nowMs: number = Date.now(),
  options: TrialTokenOptions = {},
): string {
  const payload: TrialTokenPayload = {
    email,
    exp: Math.floor(nowMs / 1000) + TRIAL_TOKEN_TTL_SECONDS,
    v: options.version ?? 0,
  };
  const name = options.firstName?.trim() ?? "";
  if (name !== "") payload.n = name;
  return signPayload(payload, secret);
}

/**
 * Signs an anonymous trial token. The device id is a trial_devices primary key, which
 * the database issued, so an empty one is a bug here rather than something to sign.
 */
export function signAnonymousTrialToken(
  deviceId: string,
  secret: string,
  nowMs: number = Date.now(),
  options: TrialTokenOptions = {},
): string {
  const id = deviceId.trim();
  if (id === "") throw new Error("cannot sign an anonymous trial token without a device id");
  return signPayload(
    { a: id, exp: Math.floor(nowMs / 1000) + TRIAL_TOKEN_TTL_SECONDS, v: options.version ?? 0 },
    secret,
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TrialTokenResult =
  | {
      ok: true;
      kind: "email";
      email: string;
      version: number;
      firstName: string | null;
    }
  | { ok: true; kind: "anonymous"; deviceId: string; version: number }
  | { ok: false; reason: "invalid" | "expired" };

/**
 * Verifies the token and returns the identity it names.
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

  const record = payload as {
    email?: unknown;
    a?: unknown;
    exp?: unknown;
    v?: unknown;
    n?: unknown;
  };
  if (typeof record.exp !== "number" || record.exp <= Math.floor(nowMs / 1000)) {
    return { ok: false, reason: "expired" };
  }

  // Absent on tokens signed before versions existed: those are version 0. Anything else that
  // is not a whole number is not a token this service signed.
  const version = record.v === undefined ? 0 : record.v;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    return { ok: false, reason: "invalid" };
  }

  // Exactly one identity. A payload carrying both, or neither, is not one this service
  // signs, and treating it as either would let a hand-built token choose its own checks.
  const hasEmail = typeof record.email === "string" && record.email !== "";
  const hasDevice = typeof record.a === "string" && record.a !== "";
  if (hasEmail === hasDevice) return { ok: false, reason: "invalid" };

  if (hasDevice) {
    if (typeof record.a !== "string" || !UUID_PATTERN.test(record.a)) {
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, kind: "anonymous", deviceId: record.a, version };
  }

  const firstName = typeof record.n === "string" && record.n.trim() !== "" ? record.n : null;
  return {
    ok: true,
    kind: "email",
    email: record.email as string,
    version,
    firstName,
  };
}
