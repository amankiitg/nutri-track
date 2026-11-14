/**
 * The trial's client: the three server calls, the localStorage token, and the read
 * of the parse result.
 *
 * The trial talks straight to the parse-meal service (the same origin the capture flow
 * uses), never to Supabase: a trial visitor has no account, and the server issues the
 * signed token.
 */
import { z } from "zod";
import { parseApiError, parseMealUrl } from "@/lib/capture";

const TRIAL_TOKEN_KEY = "nutritrack-trial-token";
const TRIAL_EMAIL_KEY = "nutritrack-trial-email";
const TRIAL_INVITED_KEY = "nutritrack-trial-invited";
const TRIAL_ANONYMOUS_KEY = "nutritrack-trial-anonymous";
const TRIAL_DEVICE_KEY = "nutritrack-trial-device";
const PENDING_TRIAL_KEY = "nutritrack-pending-trial";

function trialUrl(path: string): string {
  return parseMealUrl().replace(/\/parse-meal$/, "") + path;
}

/** Whether the server should ask for an email before the trial. False is the default. */
export function trialRequireEmailDefault(): boolean {
  const value = import.meta.env["VITE_TRIAL_REQUIRE_EMAIL"];
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

/**
 * The trial token, kept in localStorage so a returning visitor skips the gate.
 *
 * An email trial has an address and invited flag. An anonymous trial has neither, but
 * it keeps the device id the server issued: when the 30-day token expires, a new one is
 * signed for the same device row, so the 10 scans do not reset.
 */
export interface StoredTrial {
  token: string;
  email: string | null;
  /** Whether the mailbox is on the invite list, so a returning visitor still gets the right end screen. */
  invited: boolean;
  anonymous: boolean;
  deviceId: string | null;
}

export function getStoredTrial(): StoredTrial | null {
  try {
    const token = localStorage.getItem(TRIAL_TOKEN_KEY);
    if (token === null || token === "") return null;
    const email = localStorage.getItem(TRIAL_EMAIL_KEY);
    const anonymous = localStorage.getItem(TRIAL_ANONYMOUS_KEY) === "1";
    const rawDevice = localStorage.getItem(TRIAL_DEVICE_KEY);
    const deviceId = rawDevice === null || rawDevice === "" ? null : rawDevice;

    if (email === null || email === "") {
      // A token with neither an address nor the anonymous marker is not one this page
      // wrote, and guessing would show the wrong end screen.
      if (!anonymous) return null;
      return { token, email: null, invited: false, anonymous: true, deviceId };
    }

    return {
      token,
      email,
      invited: localStorage.getItem(TRIAL_INVITED_KEY) === "1",
      anonymous: false,
      deviceId: null,
    };
  } catch {
    return null;
  }
}

export function storeTrial(stored: StoredTrial): void {
  try {
    localStorage.setItem(TRIAL_TOKEN_KEY, stored.token);
    localStorage.setItem(TRIAL_EMAIL_KEY, stored.email ?? "");
    localStorage.setItem(TRIAL_INVITED_KEY, stored.invited ? "1" : "0");
    localStorage.setItem(TRIAL_ANONYMOUS_KEY, stored.anonymous ? "1" : "0");
    if (stored.deviceId !== null) {
      localStorage.setItem(TRIAL_DEVICE_KEY, stored.deviceId);
    } else {
      localStorage.removeItem(TRIAL_DEVICE_KEY);
    }
  } catch {
    // A private-browsing refusal is not worth failing the trial over.
  }
}

/** The browser's device row, kept when the token itself is cleared so a reissue reuses it. */
export function getStoredDeviceId(): string | null {
  try {
    const value = localStorage.getItem(TRIAL_DEVICE_KEY);
    return value === null || value === "" ? null : value;
  } catch {
    return null;
  }
}

/**
 * Forgets the token but keeps the device id. An expired anonymous token is reissued for
 * the same row, which is what makes the per-device limit survive the 30 days.
 */
export function clearTrial(): void {
  try {
    localStorage.removeItem(TRIAL_TOKEN_KEY);
    localStorage.removeItem(TRIAL_EMAIL_KEY);
    localStorage.removeItem(TRIAL_INVITED_KEY);
    localStorage.removeItem(TRIAL_ANONYMOUS_KEY);
  } catch {
    // ignored
  }
}

export interface SendCodeResult {
  status: "sent";
  email: string;
  /** True when the address is on the invite list: the page shows a sign-in line rather than a request-invite one. */
  invited: boolean;
}

const sendCodeResponseSchema = z.object({
  status: z.literal("sent"),
  email: z.string(),
  invited: z.boolean().default(false),
});

/** Step 1: ask the server for a code. The Turnstile token is checked server-side first. */
export async function sendTrialCode(
  email: string,
  firstName: string,
  turnstileToken: string,
): Promise<SendCodeResult> {
  const response = await postTrial(trialUrl("/trial/send-code"), {
    email,
    firstName,
    turnstileToken,
  });
  const parsed = sendCodeResponseSchema.safeParse(response);
  if (!parsed.success) throw new Error("The server sent something unexpected. Try again.");
  return parsed.data;
}

const verifyCodeResponseSchema = z.object({
  status: z.string(),
  token: z.string().optional(),
});

/** Step 2: prove the code. Returns the signed token on success. */
export async function verifyTrialCode(
  email: string,
  code: string,
): Promise<{ status: string; token?: string | undefined }> {
  const response = await postTrial(trialUrl("/trial/verify-code"), { email, code });
  const parsed = verifyCodeResponseSchema.safeParse(response);
  if (!parsed.success) throw new Error("The server sent something unexpected. Try again.");
  return parsed.data;
}

const anonymousStartResponseSchema = z.object({
  status: z.literal("ok"),
  token: z.string(),
  device_id: z.string(),
  scans_left: z.number(),
  scans_total: z.number().nullable(),
});

export interface AnonymousTrialStart {
  token: string;
  /** The trial_devices row, kept so a reissued token does not reset the 10 scans. */
  deviceId: string;
  scansLeft: number;
  scansTotal: number | null;
}

/**
 * The anonymous trial's first step: Turnstile, then a signed device token.
 *
 * No email, no code. The device id is sent back when the browser has one, so an expired
 * token is renewed against the same scan counter rather than starting a new trial.
 */
export async function startAnonymousTrial(
  turnstileToken: string,
  deviceId: string | null,
): Promise<AnonymousTrialStart> {
  const response = await postTrial(trialUrl("/trial/start"), {
    turnstileToken,
    deviceId,
  });
  const parsed = anonymousStartResponseSchema.safeParse(response);
  if (!parsed.success) throw new Error("The server sent something unexpected. Try again.");
  return {
    token: parsed.data.token,
    deviceId: parsed.data.device_id,
    scansLeft: parsed.data.scans_left,
    scansTotal: parsed.data.scans_total,
  };
}

const trialSettingsSchema = z.object({
  scans_limit: z.number(),
  // False is the anonymous flow, and the default for a server build that predates the
  // flag. The page still gets the truth from this answer before it starts a trial.
  require_email: z.boolean().default(false),
});

export interface TrialSettings {
  scansLimit: number;
  /** True restores the email and code step; false is the anonymous trial. */
  requireEmail: boolean;
}

/**
 * A refusal from the trial service, with its code: `trial_exhausted` and `trial_link_expired`
 * each draw a different screen, and a message is not something to match.
 */
export class TrialRequestError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.name = "TrialRequestError";
    this.code = code;
  }
}

/** What a personal trial link (/t/<token>) is worth, as the service answers it. */
export type TrialLinkResult =
  | {
      status: "ok";
      email: string;
      firstName: string | null;
      scansLeft: number;
      scansTotal: number | null;
      invited: boolean;
    }
  | { status: "expired" };

const trialLinkResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    email: z.string(),
    firstName: z.string().nullable(),
    scansLeft: z.number(),
    scansTotal: z.number().nullable(),
    invited: z.boolean().default(false),
  }),
  z.object({ status: z.literal("expired") }).passthrough(),
]);

/** Asks the service whether a personal link is still good. The token is the only credential. */
export async function verifyTrialLink(token: string): Promise<TrialLinkResult> {
  const response = await postTrial(trialUrl("/trial/link"), { token });
  const parsed = trialLinkResponseSchema.safeParse(response);
  if (!parsed.success) throw new Error("The server sent something unexpected. Try again.");
  if (parsed.data.status === "expired") return { status: "expired" };
  return parsed.data;
}

export async function getTrialSettings(): Promise<TrialSettings> {
  const response = await getTrial(trialUrl("/trial/settings"));
  const parsed = trialSettingsSchema.safeParse(response);
  if (!parsed.success) throw new Error("The server sent something unexpected. Try again.");
  return {
    scansLimit: parsed.data.scans_limit,
    requireEmail: parsed.data.require_email,
  };
}

/** Kept for the personal-link page, which only needs the number. */
export async function getTrialScansLimit(): Promise<number> {
  return (await getTrialSettings()).scansLimit;
}

/** One in-memory photo for the trial parse. */
export interface TrialPhoto {
  base64: string;
  mimeType: string;
}

/** The meal a visitor entered before proving their email, kept across a reload. */
export type PendingTrialMeal =
  { kind: "text"; text: string } | { kind: "photo"; photos: TrialPhoto[] };

/** What to restore after the visitor left the tab to read their code. */
export interface PendingTrial {
  step: "email" | "code";
  email: string;
  firstName: string;
  invited: boolean;
  meal: PendingTrialMeal;
}

const pendingTrialSchema = z.object({
  step: z.enum(["email", "code"]),
  email: z.string(),
  firstName: z.string(),
  invited: z.boolean(),
  meal: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), text: z.string() }),
    z.object({
      kind: z.literal("photo"),
      photos: z.array(z.object({ base64: z.string(), mimeType: z.string() })),
    }),
  ]),
});

/** sessionStorage, not localStorage: the meal is only needed for this one tab's reload. */
export function savePendingTrial(pending: PendingTrial): void {
  try {
    sessionStorage.setItem(PENDING_TRIAL_KEY, JSON.stringify(pending));
  } catch {
    // Unwritable storage means the meal may be lost on a reload; nothing worse.
  }
}

export function getPendingTrial(): PendingTrial | null {
  try {
    const raw = sessionStorage.getItem(PENDING_TRIAL_KEY);
    if (raw === null) return null;
    const parsed = pendingTrialSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function clearPendingTrial(): void {
  try {
    sessionStorage.removeItem(PENDING_TRIAL_KEY);
  } catch {
    // ignored
  }
}

export interface TrialParseInput {
  token: string;
  text: string | null;
  photos: TrialPhoto[];
  eatenAt: Date;
  mealType: string | null;
}

const trialItemSchema = z.object({
  name: z.string(),
  calories: z.number(),
  protein_g: z.number(),
  carbs_g: z.number(),
  fat_g: z.number(),
  cooking_fat: z
    .object({
      type: z.enum(["oil", "ghee", "butter", "dressing", "none"]),
      amount_tsp: z.number(),
      kcal_per_tsp: z.number().nullable(),
      fat_per_tsp: z.number().nullable(),
    })
    .nullable(),
});

export interface TrialParseResult {
  items: Array<{
    name: string;
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    cooking_fat: {
      type: "oil" | "ghee" | "butter" | "dressing" | "none";
      amount_tsp: number;
      kcal_per_tsp: number | null;
      fat_per_tsp: number | null;
    } | null;
  }>;
  scans_left: number;
  meal_type: string;
  source: string;
  model: string;
  attempts: number;
}

const trialParseResponseSchema = z.object({
  items: z.array(trialItemSchema),
  scans_left: z.number(),
  meal_type: z.string(),
  source: z.string(),
  model: z.string(),
  attempts: z.number(),
});

/** Step 3: a scan. The result carries the scans left, which is what the page shows. */
export async function parseTrialMeal(input: TrialParseInput): Promise<TrialParseResult> {
  const response = await postTrial(trialUrl("/trial/parse"), input);
  const parsed = trialParseResponseSchema.safeParse(response);
  if (!parsed.success) throw new Error("The server sent something unexpected. Try again.");
  return parsed.data;
}

/**
 * Posts to the trial service and turns its error envelope into a readable message.
 *
 * The trial's refusals (exhausted, busy) carry the sentence the page shows; everything
 * else becomes the generic "try again" sentence.
 */
async function postTrial(url: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new Error("Could not reach the meal service. Check your connection and try again.");
  }

  return readTrialResponse(response);
}

async function getTrial(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(90_000) });
  } catch {
    throw new Error("Could not reach the meal service. Check your connection and try again.");
  }
  return readTrialResponse(response);
}

/** One response handler for the trial's POST and GET calls, so the error sentence is one. */
async function readTrialResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // fall through; a non-JSON body is not the success shape.
  }

  if (!response.ok) {
    const envelope = parseApiError(text);
    throw new TrialRequestError(
      envelope?.message ?? "Could not start the trial. Try again.",
      envelope?.code ?? null,
    );
  }

  return json;
}
