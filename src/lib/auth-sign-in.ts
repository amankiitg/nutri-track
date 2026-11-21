/**
 * The only two places the app starts a Supabase sign-in.
 *
 * Both take the client and a captcha source and do the same three things in the same order: ask
 * for a fresh token, put it inside the request's own `options` object, and give the token back
 * afterwards whether the call worked or not. That last part matters because a Turnstile token is
 * single use: the retry after a failed attempt needs a new one, and a token kept around is a token
 * spent.
 *
 * They live here rather than in `auth.tsx` so that "every sign-in goes through the helper" is a
 * property a test can read off the source tree instead of a convention somebody has to remember.
 * Nothing else in `src/` may call `signInWithOtp`, `signInWithOAuth` or `auth.resend`.
 */
import { AuthApiError, type SupabaseClient } from "@supabase/supabase-js";
import { CaptchaUnavailableError } from "./turnstile-token";

/** The Supabase client, narrowed to the part these helpers touch. */
export type SignInClient = Pick<SupabaseClient, "auth">;

export interface CaptchaSource {
  /** A token for this attempt, or null when no widget could produce one. */
  ensure(): Promise<string | null>;
  /** Drops the token and resets the widget, called after every attempt. */
  reset(): void;
}

/** A source with no widget behind it, for a page that has none. */
export const NO_CAPTCHA: CaptchaSource = {
  ensure: async () => null,
  reset: () => {},
};

/** The token, in the shape each call wants, or an empty object when there is none. */
function tokenField(token: string | null): { captchaToken?: string } {
  return token === null ? {} : { captchaToken: token };
}

/** The code the screens key the "tap again" sentence on, rather than matching on its words. */
export const CAPTCHA_UNAVAILABLE_CODE = "captcha_unavailable";

/**
 * What the person is told when CAPTCHA is on and the widget would not answer.
 *
 * This is the whole point of the change this constant belongs to: a request without a token is
 * refused by GoTrue for the missing token, and the screen then blames the password or says
 * "something went wrong" about a request that never had a chance. Saying what actually happened,
 * and that tapping again will work, is both true and actionable.
 */
export const CAPTCHA_STILL_LOADING = "Security check is still loading. Tap again in a second.";

/**
 * The refusal, shaped like an auth error so every screen's existing handling works unchanged.
 *
 * Status 0 because it never reached the server; the detail line hides itself for that status rather
 * than printing "HTTP 0" under a sentence that already says everything.
 */
function captchaUnavailable(): AuthApiError {
  return new AuthApiError(CAPTCHA_STILL_LOADING, 0, CAPTCHA_UNAVAILABLE_CODE);
}

/**
 * The token for one attempt, or a refusal the caller returns as-is.
 *
 * Every function below goes through this, which is what makes "no auth request without a token" a
 * property of the module rather than a rule each caller has to remember.
 */
async function tokenOrRefusal(
  source: CaptchaSource,
): Promise<{ token: string | null } | { refusal: AuthApiError }> {
  try {
    return { token: await source.ensure() };
  } catch (error) {
    if (error instanceof CaptchaUnavailableError) return { refusal: captchaUnavailable() };
    throw error;
  }
}

/** Emails a magic link, with a token when the widget produced one. */
export async function requestEmailLink(
  client: SignInClient,
  source: CaptchaSource,
  params: {
    email: string;
    options: Parameters<SignInClient["auth"]["signInWithOtp"]>[0]["options"];
  },
): ReturnType<SignInClient["auth"]["signInWithOtp"]> {
  const attempt = await tokenOrRefusal(source);
  if ("refusal" in attempt) return { data: { user: null, session: null }, error: attempt.refusal };

  try {
    return await client.auth.signInWithOtp({
      email: params.email,
      options: { ...params.options, ...tokenField(attempt.token) },
    });
  } finally {
    source.reset();
  }
}

/** Starts an OAuth sign-in, with a token when the widget produced one. */
export async function startOAuthSignIn(
  client: SignInClient,
  source: CaptchaSource,
  params: {
    provider: "google";
    options: Parameters<SignInClient["auth"]["signInWithOAuth"]>[0]["options"];
  },
): ReturnType<SignInClient["auth"]["signInWithOAuth"]> {
  const attempt = await tokenOrRefusal(source);
  if ("refusal" in attempt)
    return { data: { provider: params.provider, url: null }, error: attempt.refusal };

  try {
    return await client.auth.signInWithOAuth({
      provider: params.provider,
      options: { ...params.options, ...tokenField(attempt.token) },
    });
  } finally {
    source.reset();
  }
}

/**
 * Signs in with a password, with a token.
 *
 * This was the one sign-in path with no token at all, and it is the path that failed on the local
 * stack with "captcha protection: request disallowed (no captcha_token found)". A wrong password is
 * worth a sentence about the password; a refusal for a missing token deserves the sentence about the
 * security check instead.
 */
export async function signInWithPassword(
  client: SignInClient,
  source: CaptchaSource,
  params: { email: string; password: string },
): Promise<
  ReturnType<SignInClient["auth"]["signInWithPassword"]> extends Promise<infer R> ? R : never
> {
  const attempt = await tokenOrRefusal(source);
  if ("refusal" in attempt) return { data: { user: null, session: null }, error: attempt.refusal };

  try {
    return await client.auth.signInWithPassword({
      email: params.email,
      password: params.password,
      options: tokenField(attempt.token),
    });
  } finally {
    source.reset();
  }
}

/** Sends a reset link, with a token, because GoTrue guards recovery the same way. */
export async function requestPasswordReset(
  client: SignInClient,
  source: CaptchaSource,
  params: { email: string; redirectTo: string },
): Promise<
  ReturnType<SignInClient["auth"]["resetPasswordForEmail"]> extends Promise<infer R> ? R : never
> {
  const attempt = await tokenOrRefusal(source);
  if ("refusal" in attempt) return { data: null, error: attempt.refusal };

  try {
    return await client.auth.resetPasswordForEmail(params.email, {
      redirectTo: params.redirectTo,
      ...tokenField(attempt.token),
    });
  } finally {
    source.reset();
  }
}

/**
 * Ends the session.
 *
 * No captcha: signing out spends nothing and grants nothing. It lives here so the two places that
 * offer it do the same thing, and so a screen that has just told somebody they are signed in as the
 * wrong person can undo it without reaching for the client itself.
 */
export async function endSession(
  client: SignInClient,
): Promise<{ error: { message?: string } | null }> {
  return await client.auth.signOut();
}

/** Resends a confirmation email, which GoTrue also guards behind the captcha. */
export async function resendConfirmation(
  client: SignInClient,
  source: CaptchaSource,
  params: { type: "signup"; email: string },
): ReturnType<SignInClient["auth"]["resend"]> {
  const attempt = await tokenOrRefusal(source);
  if ("refusal" in attempt) return { data: { user: null, session: null }, error: attempt.refusal };

  try {
    return await client.auth.resend({
      type: params.type,
      email: params.email,
      ...(attempt.token === null ? {} : { options: { captchaToken: attempt.token } }),
    });
  } finally {
    source.reset();
  }
}
