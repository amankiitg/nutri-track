/**
 * The trial: its database store (the security-definer RPCs) and the in-memory parse.
 *
 * The store talks to PostgREST with the publishable key, as the anon role, so every
 * write is a security-definer function that runs as its owner. Nothing here holds a
 * service-role key, and no trial photo is ever stored: the bytes arrive in the request
 * body, go straight into the model call, and are gone when the response returns.
 *
 * Every RPC now carries p_server_secret, the trial server secret held in Supabase
 * Vault. The database function raises unless the argument matches, so a stranger who
 * reaches the function directly through PostgREST gets nothing; only this service,
 * which holds the secret, can send a code or spend a scan.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  guessMealType,
  type MealItemDraft,
  type MealSource,
  type MealType,
} from "../../shared/meal-parse";
import type { LlmCallRecord, Photo } from "./caller-store";
import type { Config } from "./config";
import { ApiError } from "./errors";
import type { LlmClient } from "./llm";
import { analyzeMeal, buildSystemMessage, buildUserMessage } from "./parse-meal";
import type { ParseMealRequest } from "./schemas";

/** One message, because the visitor's next move is the same for every cause. */
export const TRIAL_FAILURE_MESSAGE =
  "Could not start the trial. Check your connection and try again.";

export const TRIAL_UNAVAILABLE_MESSAGE = "Trial unavailable right now";

export function trialExhaustedMessage(limit: number): string {
  return "You've used your " + limit + " free scans. Join to keep tracking.";
}

/** What a revoked, expired or forged personal link says. One sentence for all three. */
export const TRIAL_LINK_EXPIRED_MESSAGE =
  "This trial link has expired. Email invites@tracknutri.app for a new one.";

/** Where a personal trial link points. The token is appended as the last path segment. */
export const TRIAL_LINK_BASE = "https://tracknutri.app/t/";

const trialLinkStatusSchema = z.object({
  status: z.string(),
  email: z.string().optional(),
  first_name: z.string().nullable().optional(),
  token_version: z.number().int().optional(),
  scans_left: z.number().optional(),
  scans_total: z.number().nullable().optional(),
  invited: z.boolean().optional().default(false),
});

export type TrialLinkStatus = z.infer<typeof trialLinkStatusSchema>;

const trialSendResultSchema = z.object({
  status: z.string(),
  code: z.string().optional(),
  email: z.string().optional(),
  /** True when the canonical email is on the invite list, so the page knows its end screen. */
  invited: z.boolean().optional().default(false),
});

const trialScanResultSchema = z.object({
  status: z.string(),
  scans_left: z.number().optional().default(0),
  /** The per-mailbox total, returned so the refusal message names the right number. */
  scans_total: z.number().optional(),
  /** The reserved llm_calls row id, filled in by trial_log_call after the model answers. */
  call_id: z.string().optional(),
});

const trialAnonStartResultSchema = z.object({
  status: z.string(),
  /** The trial_devices row the signed token names. */
  device_id: z.string().optional(),
  token_version: z.number().int().optional(),
  scans_left: z.number().optional().default(0),
  scans_total: z.number().nullable().optional(),
});

export type TrialSendResult = z.infer<typeof trialSendResultSchema>;
export type TrialScanResult = z.infer<typeof trialScanResultSchema>;
export type TrialAnonStartResult = z.infer<typeof trialAnonStartResultSchema>;

export interface TrialStore {
  sendCode(email: string, firstName: string, ip: string | null): Promise<TrialSendResult>;
  verifyCode(email: string, code: string): Promise<string>;
  /** `version` is the token's; the database refuses it unless it is the mailbox's current one. */
  startScan(email: string, ip: string | null, version: number): Promise<TrialScanResult>;
  /**
   * Issues (or reuses) an anonymous device row. `deviceId` is the browser's existing
   * row when it has one, so an expired token does not reset its scans.
   */
  startAnonymousDevice(ip: string | null, deviceId: string | null): Promise<TrialAnonStartResult>;
  /** Spends one scan from an anonymous device, with the token's version checked. */
  startAnonymousScan(
    deviceId: string,
    ip: string | null,
    version: number,
  ): Promise<TrialScanResult>;
  /** What a token for this mailbox is worth now; a null version skips only the version check. */
  linkStatus(email: string, version: number | null): Promise<TrialLinkStatus>;
  logCall(callId: string, record: LlmCallRecord): Promise<void>;
  /** The per-mailbox scan limit, read from trial_settings so the page never hardcodes it. */
  getScansLimit(): Promise<number>;
}

/**
 * The trial store, over the anon client. Every RPC is a security-definer function
 * granted only to anon, so this client cannot read the tables directly — it can only
 * ask the functions, which enforce the limits and the secret gate.
 *
 * The limits are no longer passed here: the database reads them from trial_settings.
 * The server's only role in the limits is proving it is the server (the secret), and
 * then recording the model's answer against the reserved row the scan returned.
 */
export function createTrialStore(
  client: SupabaseClient,
  serverSecret: string | undefined,
): TrialStore {
  return {
    async sendCode(email, firstName, ip) {
      const { data, error } = await client.rpc("trial_send_code", {
        p_server_secret: serverSecret,
        p_email: email,
        p_first_name: firstName,
        p_ip: ip,
      });
      if (error) throw new ApiError(502, "upstream_error", TRIAL_FAILURE_MESSAGE);
      const parsed = trialSendResultSchema.safeParse(data);
      if (!parsed.success) throw new ApiError(502, "upstream_error", TRIAL_FAILURE_MESSAGE);
      return parsed.data;
    },

    async verifyCode(email, code) {
      const { data, error } = await client.rpc("trial_verify_code", {
        p_server_secret: serverSecret,
        p_email: email,
        p_code: code,
      });
      if (error) throw new ApiError(502, "upstream_error", TRIAL_FAILURE_MESSAGE);
      return typeof data === "string" ? data : "invalid";
    },

    async getScansLimit() {
      const { data, error } = await client.rpc("trial_scans_limit", {
        p_server_secret: serverSecret,
      });
      if (error) throw new ApiError(502, "upstream_error", TRIAL_FAILURE_MESSAGE);
      if (typeof data !== "number" || !Number.isInteger(data)) {
        throw new ApiError(502, "upstream_error", TRIAL_FAILURE_MESSAGE);
      }
      return data;
    },

    async linkStatus(email, version) {
      const { data, error } = await client.rpc("trial_link_status", {
        p_server_secret: serverSecret,
        p_email: email,
        ...(version === null ? {} : { p_version: version }),
      });
      if (error) throw new ApiError(502, "upstream_error", TRIAL_FAILURE_MESSAGE);
      const parsed = trialLinkStatusSchema.safeParse(data);
      if (!parsed.success) throw new ApiError(502, "upstream_error", TRIAL_FAILURE_MESSAGE);
      return parsed.data;
    },

    async startScan(email, ip, version) {
      const { data, error } = await client.rpc("trial_scan_start", {
        p_server_secret: serverSecret,
        p_email: email,
        p_ip: ip,
        p_version: version,
      });
      if (error) throw new ApiError(502, "upstream_error", TRIAL_FAILURE_MESSAGE);
      const parsed = trialScanResultSchema.safeParse(data);
      if (!parsed.success) throw new ApiError(502, "upstream_error", TRIAL_FAILURE_MESSAGE);
      return parsed.data;
    },

    async startAnonymousDevice(ip, deviceId) {
      const { data, error } = await client.rpc("trial_anon_start", {
        p_server_secret: serverSecret,
        p_ip: ip,
        p_device_id: deviceId,
      });
      if (error) throw new ApiError(502, "upstream_error", TRIAL_FAILURE_MESSAGE);
      const parsed = trialAnonStartResultSchema.safeParse(data);
      if (!parsed.success) throw new ApiError(502, "upstream_error", TRIAL_FAILURE_MESSAGE);
      return parsed.data;
    },

    async startAnonymousScan(deviceId, ip, version) {
      const { data, error } = await client.rpc("trial_anon_scan_start", {
        p_server_secret: serverSecret,
        p_device_id: deviceId,
        p_ip: ip,
        p_version: version,
      });
      if (error) throw new ApiError(502, "upstream_error", TRIAL_FAILURE_MESSAGE);
      const parsed = trialScanResultSchema.safeParse(data);
      if (!parsed.success) throw new ApiError(502, "upstream_error", TRIAL_FAILURE_MESSAGE);
      return parsed.data;
    },

    async logCall(callId, record) {
      const { error } = await client.rpc("trial_log_call", {
        p_server_secret: serverSecret,
        p_call_id: callId,
        p_model: record.model,
        p_prompt_tokens: record.promptTokens,
        p_completion_tokens: record.completionTokens,
        p_latency_ms: record.latencyMs,
        p_status: record.status,
      });
      if (error) {
        // Best-effort, like the authenticated path: a telemetry failure must not fail a parse.
        return;
      }
    },
  };
}

/**
 * The visitor's network address, for the per-IP ceilings.
 *
 * The parse-meal service is reached directly (not through Cloudflare), so the address
 * is read from the headers the proxy in front sets. cf-connecting-ip is read first so
 * the same code works if Cloudflare is ever placed in front; x-forwarded-for is the
 * Render case. An unknown address is null, never a shared bucket.
 *
 * This is the end user's address, passed to the database function as p_ip. It is
 * trusted there only because the secret gate already proved the caller is this
 * service and not the visitor.
 */
export function clientIp(
  headers: Record<string, string | string[] | undefined>,
  remoteAddress?: string,
): string | null {
  const cf = headers["cf-connecting-ip"];
  const cfFirst = Array.isArray(cf) ? cf[0] : cf;
  if (typeof cfFirst === "string" && cfFirst.trim() !== "") return cfFirst.trim();

  const xff = headers["x-forwarded-for"];
  const xffFirst = Array.isArray(xff) ? xff[0] : xff;
  if (typeof xffFirst === "string") {
    const first = xffFirst.split(",")[0]?.trim();
    if (first) return first;
  }

  if (typeof remoteAddress === "string" && remoteAddress.trim() !== "") {
    return remoteAddress.trim();
  }
  return null;
}

/** The scan refusal, in the words the visitor reads. */
export function trialScanError(scan: TrialScanResult): ApiError {
  if (scan.status === "no_scans_left") {
    // scans_total is present whenever the database returns no_scans_left; the ?? 0 is
    // only the type-level fallback and cannot be reached from a real refusal.
    return new ApiError(403, "trial_exhausted", trialExhaustedMessage(scan.scans_total ?? 0), {
      details: { scans_left: 0 },
    });
  }
  if (scan.status === "busy") {
    return new ApiError(429, "trial_busy", "Trial is busy today. Request an invite instead.", {
      details: { scans_left: scan.scans_left },
    });
  }
  if (scan.status === "revoked") {
    return new ApiError(401, "trial_link_expired", TRIAL_LINK_EXPIRED_MESSAGE);
  }
  if (scan.status === "rate_limited") {
    return new ApiError(429, "trial_busy", "Trial is busy right now. Request an invite instead.", {
      details: { scans_left: scan.scans_left },
    });
  }
  return new ApiError(403, "forbidden", "Trial is not available for this address.");
}

export interface TrialParseInput {
  email: string;
  /** The token's version, checked against the mailbox's current one. */
  version: number;
  ip: string | null;
  text: string | null;
  photos: Photo[];
  mealType: MealType | null;
  eatenAt: Date;
}

export interface TrialAnonymousParseInput {
  /** The trial_devices row the anonymous token names. */
  deviceId: string;
  /** The token's version, checked against the device's current one. */
  version: number;
  ip: string | null;
  text: string | null;
  photos: Photo[];
  mealType: MealType | null;
  eatenAt: Date;
}

export interface TrialParseOutcome {
  items: MealItemDraft[];
  scans_left: number;
  meal_type: MealType;
  source: MealSource;
  model: string;
  attempts: number;
}

export interface TrialParseDeps {
  config: Config;
  llm: LlmClient;
  trial: TrialStore;
}

/** The meal itself, whichever identity paid for the scan. */
interface TrialMeal {
  text: string | null;
  photos: Photo[];
  mealType: MealType | null;
  eatenAt: Date;
}

/**
 * The model half of a trial scan, shared by the email and anonymous paths.
 *
 * The photo bytes are only ever in memory. The slot has already been consumed by the
 * caller, and the reserved row's id is what the post-model record() fills in — one row
 * per scan, never two.
 */
async function analyzeTrialScan(
  meal: TrialMeal,
  scan: TrialScanResult,
  deps: TrialParseDeps,
): Promise<TrialParseOutcome> {
  if (scan.status !== "ok") {
    throw trialScanError(scan);
  }

  const source: MealSource = meal.photos.length > 0 ? "photo" : "text";
  const request: ParseMealRequest = {
    source,
    text: meal.text,
    photoPaths: [],
    eatenAt: meal.eatenAt.toISOString(),
    mealType: meal.mealType,
    hint: null,
  };

  const callId = scan.call_id ?? "";

  const messages = [buildSystemMessage(), buildUserMessage(request, meal.photos)];
  const { items, model, attempts } = await analyzeMeal(messages, {
    llm: deps.llm,
    model: deps.config.GEMINI_VISION_MODEL,
    record: (record) => deps.trial.logCall(callId, record),
  });

  const mealType = meal.mealType ?? guessMealType(meal.eatenAt, "UTC");

  return {
    items,
    scans_left: scan.scans_left,
    meal_type: mealType,
    source,
    model,
    attempts,
  };
}

/**
 * A trial scan, end to end: consume a slot, call the model, return the review items.
 *
 * The slot is consumed before the model call so a retry cannot spend two scans on one
 * meal.
 */
export async function parseTrialMeal(
  input: TrialParseInput,
  deps: TrialParseDeps,
): Promise<TrialParseOutcome> {
  const scan = await deps.trial.startScan(input.email, input.ip, input.version);
  return analyzeTrialScan(input, scan, deps);
}

/** The same scan, paid for by an anonymous device rather than a mailbox. */
export async function parseAnonymousTrialMeal(
  input: TrialAnonymousParseInput,
  deps: TrialParseDeps,
): Promise<TrialParseOutcome> {
  const scan = await deps.trial.startAnonymousScan(input.deviceId, input.ip, input.version);
  return analyzeTrialScan(input, scan, deps);
}
