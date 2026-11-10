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

function trialUrl(path: string): string {
  return parseMealUrl().replace(/\/parse-meal$/, "") + path;
}

/** The trial token, kept in localStorage so a returning visitor skips the email step. */
export interface StoredTrial {
  token: string;
  email: string;
}

export function getStoredTrial(): StoredTrial | null {
  try {
    const token = localStorage.getItem(TRIAL_TOKEN_KEY);
    const email = localStorage.getItem(TRIAL_EMAIL_KEY);
    if (token === null || token === "" || email === null) return null;
    return { token, email };
  } catch {
    return null;
  }
}

export function storeTrial(stored: StoredTrial): void {
  try {
    localStorage.setItem(TRIAL_TOKEN_KEY, stored.token);
    localStorage.setItem(TRIAL_EMAIL_KEY, stored.email);
  } catch {
    // A private-browsing refusal is not worth failing the trial over.
  }
}

export function clearTrial(): void {
  try {
    localStorage.removeItem(TRIAL_TOKEN_KEY);
    localStorage.removeItem(TRIAL_EMAIL_KEY);
  } catch {
    // ignored
  }
}

export type SendCodeStatus = "sent" | "already_access";

export interface SendCodeResult {
  status: SendCodeStatus;
  email: string;
}

const sendCodeResponseSchema = z.object({
  status: z.enum(["sent", "already_access"]),
  email: z.string(),
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

const trialSettingsSchema = z.object({
  scans_limit: z.number(),
});

/** The per-mailbox scan limit, read from the server so the page never hardcodes it. */
export async function getTrialScansLimit(): Promise<number> {
  const response = await getTrial(trialUrl("/trial/settings"));
  const parsed = trialSettingsSchema.safeParse(response);
  if (!parsed.success) throw new Error("The server sent something unexpected. Try again.");
  return parsed.data.scans_limit;
}

/** One in-memory photo for the trial parse. */
export interface TrialPhoto {
  base64: string;
  mimeType: string;
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
    throw new Error(envelope?.message ?? "Could not start the trial. Try again.");
  }

  return json;
}
