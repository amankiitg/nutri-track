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
import { ApiError } from "./errors";
import { safeTimeZone } from "./time";

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
}

/** The bucket the capture sheet uploads to. */
export const MEAL_PHOTO_BUCKET = "meal-photos";

const timeZoneRow = z.object({ timezone: z.string().nullable() });

const toBase64 = (bytes: ArrayBuffer): string => Buffer.from(bytes).toString("base64");

export function createCallerStore(client: SupabaseClient, userId: string): CallerStore {
  function fail(operation: string, error: { message: string }): never {
    throw new ApiError(502, "upstream_error", `Supabase ${operation} failed: ${error.message}`);
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
        .eq("id", userId)
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
  };
}
