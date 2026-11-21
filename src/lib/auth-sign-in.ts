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
import type { SupabaseClient } from "@supabase/supabase-js";

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

/** Emails a magic link, with a token when the widget produced one. */
export async function requestEmailLink(
  client: SignInClient,
  source: CaptchaSource,
  params: {
    email: string;
    options: Parameters<SignInClient["auth"]["signInWithOtp"]>[0]["options"];
  },
): ReturnType<SignInClient["auth"]["signInWithOtp"]> {
  const token = await source.ensure();
  try {
    return await client.auth.signInWithOtp({
      email: params.email,
      options: { ...params.options, ...tokenField(token) },
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
  const token = await source.ensure();
  try {
    return await client.auth.signInWithOAuth({
      provider: params.provider,
      options: { ...params.options, ...tokenField(token) },
    });
  } finally {
    source.reset();
  }
}

/** Resends a confirmation email, which GoTrue also guards behind the captcha. */
export async function resendConfirmation(
  client: SignInClient,
  source: CaptchaSource,
  params: { type: "signup"; email: string },
): ReturnType<SignInClient["auth"]["resend"]> {
  const token = await source.ensure();
  try {
    return await client.auth.resend({
      type: params.type,
      email: params.email,
      ...(token === null ? {} : { options: { captchaToken: token } }),
    });
  } finally {
    source.reset();
  }
}
