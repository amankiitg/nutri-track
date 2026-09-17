/**
 * Every database and storage operation the service performs, behind an interface.
 *
 * Two reasons for the indirection. The whole service is testable without a network
 * or a Supabase project — the tests supply a fake store. And it is the only place
 * that talks to Postgres, so it is easy to see that every query is scoped to the
 * caller by RLS rather than by a `user_id` filter this code has to remember to add.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { MEAL_PHOTO_BUCKET } from "../../shared/meal-parse";
import { ApiError } from "./errors";
import { log } from "./log";
import { safeTimeZone } from "./time";

/** One message, because the user's next move is the same for every cause. */
export const SUPABASE_FAILURE_MESSAGE =
  "Could not read this meal's photos. They may have been removed — capture the meal again, or type what you ate instead.";

/** The invite action's own failure, so an admin hears which of the two halves went wrong. */
export const INVITE_FAILURE_MESSAGE =
  "Could not add that address to the invite list. Nothing was changed, so try again.";

export interface LlmCallRecord {
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number | null;
  /** "ok", "invalid_json", "invalid_schema" or "error". */
  status: string;
}

export interface Photo {
  base64: string;
  mimeType: string;
}

export interface CallerStore {
  /** How many model calls the caller has already made since `since`. */
  countCallsSince(since: Date): Promise<number>;
  recordCall(record: LlmCallRecord): Promise<void>;
  /** The profile's timezone, so the service agrees with the rest of the app. */
  timeZone(): Promise<string>;
  /** Reads photos the caller owns. Storage policies enforce the ownership. */
  loadPhotos(paths: readonly string[]): Promise<Photo[]>;
  /**
   * Whether the caller is an admin, asked of the database with the caller's own token.
   *
   * The answer comes from `is_admin()`, which reads `auth.uid()` from that token, so it cannot
   * be spoofed by the client. This is the check that makes /invite admin-only; the UI hiding the
   * button is not a check.
   */
  isAdmin(): Promise<boolean>;
  /** Whether this address is already on the invite list. Admin-only, by the table's policy. */
  hasAllowedEmail(email: string): Promise<boolean>;
  /** Adds the address. Idempotent, so a retry after a failure adds no second row. */
  addAllowedEmail(email: string): Promise<void>;
}

const timeZoneRow = z.object({ timezone: z.string().nullable() });

const toBase64 = (bytes: ArrayBuffer): string => Buffer.from(bytes).toString("base64");

export function createCallerStore(client: SupabaseClient, userId: string): CallerStore {
  /**
   * A Supabase failure, said to the person holding the phone.
   *
   * The operation and the raw message go to the logs and nowhere else. They used to
   * be the response body, which meant a storage hiccup was reported to the user as
   * `Supabase storage download of ... failed: Object not found` — true, unhelpful,
   * and something no one can act on. What a person can act on is whether the photo is
   * gone and whether retrying will help.
   */
  function fail(operation: string, error: { message: string }): never {
    log("error", "supabase call failed", { operation, userId, error: error.message });
    throw new ApiError(502, "upstream_error", SUPABASE_FAILURE_MESSAGE);
  }

  /**
   * The same, for a table whose rows *are* an email address.
   *
   * Postgres puts the offending key value in some of its messages — a unique violation says
   * "Key (email)=(someone@example.com) already exists" — so the message is not logged here. The
   * code is enough to act on and it names nobody.
   */
  function failQuietly(operation: string, code: string | undefined): never {
    log("error", "supabase call failed", { operation, userId, code: code ?? "unknown" });
    throw new ApiError(502, "upstream_error", INVITE_FAILURE_MESSAGE);
  }

  return {
    async countCallsSince(since) {
      const { count, error } = await client
        .from("llm_calls")
        .select("id", { count: "exact", head: true })
        .gte("created_at", since.toISOString());
      if (error) fail("llm_calls count", error);
      return count ?? 0;
    },

    async recordCall(record) {
      const { error } = await client.from("llm_calls").insert({
        user_id: userId,
        model: record.model,
        prompt_tokens: record.promptTokens,
        completion_tokens: record.completionTokens,
        latency_ms: record.latencyMs,
        status: record.status,
      });
      if (error) fail("llm_calls insert", error);
    },

    async timeZone() {
      const { data, error } = await client
        .from("profiles")
        .select("timezone")
        // profiles is keyed by user_id, not id. RLS would scope this anyway, but the
        // filter is explicit so a wider grant could not silently widen the read.
        .eq("user_id", userId)
        .maybeSingle();
      if (error) fail("profiles select", error);
      // A missing profile is not worth failing the request over; UTC is the
      // column's own default.
      const parsed = timeZoneRow.safeParse(data);
      return safeTimeZone(parsed.success ? parsed.data.timezone : null);
    },

    async loadPhotos(paths) {
      const photos: Photo[] = [];
      for (const path of paths) {
        const { data, error } = await client.storage.from(MEAL_PHOTO_BUCKET).download(path);
        if (error || !data) {
          fail(`storage download of ${path}`, error ?? { message: "no data returned" });
        }
        photos.push({
          base64: toBase64(await data.arrayBuffer()),
          mimeType: data.type || "image/jpeg",
        });
      }
      return photos;
    },

    async isAdmin() {
      const { data, error } = await client.rpc("is_admin");
      if (error) fail("is_admin", error);
      return data === true;
    },

    async hasAllowedEmail(email) {
      const { data, error } = await client
        .from("allowed_emails")
        .select("email")
        .eq("email", email)
        .maybeSingle();
      if (error) failQuietly("allowed_emails select", error.code);
      return data !== null;
    },

    async addAllowedEmail(email) {
      // DO NOTHING rather than DO UPDATE: the row's own address is the key, there is nothing to
      // change, and a retry after a partly failed invite should not rewrite who added it first.
      const { error } = await client
        .from("allowed_emails")
        .upsert({ email, added_by: userId }, { onConflict: "email", ignoreDuplicates: true });
      if (error) failQuietly("allowed_emails insert", error.code);
    },
  };
}
