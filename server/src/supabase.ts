/**
 * Supabase clients for the service.
 *
 * The publishable key goes in the `apikey` header on every request, because
 * PostgREST and Storage reject a request without one. It is not a credential in
 * the sense that matters: it identifies the project, and authorisation comes from
 * the caller's own JWT, which the caller client sends as `Authorization`.
 *
 * This is why SUPABASE_SERVICE_ROLE_KEY is absent from the service's own config.
 * Nothing on the request path ever needs to bypass RLS. The one exception in this
 * repository is the orphan-photo sweeper, which is a separate job with a separate
 * config (`sweep-config.ts`) precisely so that the key cannot reach the service.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "./config";

/**
 * supabase-js falls back to `Authorization: Bearer <key>` when it has no session,
 * and the new `sb_publishable_…` keys are opaque strings rather than JWTs, so that
 * header is nonsense. This wrapper pins the headers down: `apikey` always, and
 * `Authorization` only when we mean it.
 */
function apiKeyFetch(apiKey: string, authorization?: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("apikey", apiKey);
    if (authorization !== undefined) {
      headers.set("Authorization", authorization);
    } else if (headers.get("Authorization") === `Bearer ${apiKey}`) {
      headers.delete("Authorization");
    }
    return fetch(input, { ...init, headers });
  };
}

function baseOptions(apiKey: string, authorization?: string) {
  return {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: apiKeyFetch(apiKey, authorization) },
  };
}

/** Used only to verify access tokens. Carries no user's authority. */
export function createAuthClient(config: Config): SupabaseClient {
  return createClient(
    config.SUPABASE_URL,
    config.SUPABASE_PUBLISHABLE_KEY,
    baseOptions(config.SUPABASE_PUBLISHABLE_KEY),
  );
}

/** Every request this client makes is authorised as the caller, through RLS. */
export function createCallerClient(config: Config, accessToken: string): SupabaseClient {
  return createClient(
    config.SUPABASE_URL,
    config.SUPABASE_PUBLISHABLE_KEY,
    baseOptions(config.SUPABASE_PUBLISHABLE_KEY, `Bearer ${accessToken}`),
  );
}

/**
 * The service role client, used by the orphan-photo sweeper and by nothing else.
 *
 * RLS does not apply to it, which is the whole point: the sweeper has to read every
 * meal in the database to know which photos are still referenced. The publishable key
 * still goes in `apikey` because Storage rejects a request without one; the service
 * role key is what carries the authority.
 *
 * Do not reach for this from the request path. A query made with it is unscoped, and
 * the reason the parse-meal service is safe is that it never has one of these.
 */
export function createServiceClient(
  url: string,
  publishableKey: string,
  serviceRoleKey: string,
): SupabaseClient {
  return createClient(url, publishableKey, baseOptions(publishableKey, `Bearer ${serviceRoleKey}`));
}
