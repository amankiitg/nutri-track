import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "./errors";

/**
 * The browser sends its Supabase access token as a bearer header. The service
 * verifies it against Supabase and derives the user id from the verified token —
 * never from the request body, which the caller controls.
 */
export interface VerifiedUser {
  id: string;
  email: string | null;
}

export type TokenVerifier = (token: string) => Promise<VerifiedUser>;

/** Pulls the token out of the header, or rejects with a 401 that explains itself. */
export function bearerToken(header: string | undefined): string {
  const value = header?.trim();
  if (!value) {
    throw new ApiError(
      401,
      "unauthorized",
      "Missing Authorization header. Send `Authorization: Bearer <supabase access token>`.",
    );
  }
  const match = /^Bearer\s+(\S+)$/i.exec(value);
  const token = match?.[1];
  if (token === undefined) {
    throw new ApiError(
      401,
      "unauthorized",
      "Authorization header must be `Bearer <supabase access token>`.",
    );
  }
  return token;
}

/**
 * `auth.getUser(token)` checks the token's signature and expiry with Supabase,
 * which is the only way to be sure the token was issued by this project rather
 * than merely being well-formed. It needs no privileged key.
 */
export function createTokenVerifier(authClient: SupabaseClient): TokenVerifier {
  return async (token) => {
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data.user) {
      throw new ApiError(401, "unauthorized", "Invalid or expired access token.");
    }
    return { id: data.user.id, email: data.user.email ?? null };
  };
}
