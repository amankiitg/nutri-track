/**
 * Supabase's auth errors, rewritten for the person reading them.
 *
 * The raw strings are not wrong so much as unusable. "Invalid login credentials" tells someone
 * nothing they can act on, and "Database error saving new user" reads as though their account was
 * damaged. This maps the handful a person *can* do something about, and gives everything else one
 * honest sentence rather than a stack of internals.
 *
 * The original is logged instead of shown: it is the only thing that helps when the screen is
 * being diagnosed from a bug report, and it is exactly the thing that confuses the person holding
 * the phone. That is the same split the parse-meal service makes with `ApiError.details`.
 *
 * Ordering matters in one place: "User already registered" also contains "registered", and
 * "Database error saving new user" must win over the generic fallback, so the specific cases come
 * first.
 */
export function friendlyAuthError(error: unknown): string {
  const raw =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : "";

  if (raw !== "") console.error("[auth]", raw);
  const text = raw.toLowerCase();

  if (text === "") return "Something went wrong. Please try again.";

  if (text.includes("invalid login credentials") || text.includes("invalid credentials")) {
    return "That email and password don't match. Try again, or create an account.";
  }
  if (text.includes("email not confirmed")) {
    return "Confirm your email first. Check your inbox for the link, then sign in.";
  }
  if (text.includes("rate limit") || text.includes("too many") || text.includes("429")) {
    return "Too many attempts in a short time. Wait a minute and try again.";
  }
  if (text.includes("already registered") || text.includes("already been registered")) {
    return "You already have an account with this email. Sign in instead, or use Continue with Google if that's how you joined.";
  }
  if (text.includes("database error saving new user")) {
    return "We couldn't create the account just now. That is on us, not you; try again in a moment.";
  }
  if (text.includes("expired") || text.includes("invalid or has expired")) {
    return "That link has expired or was already used. Request a new one and try again.";
  }
  if (text.includes("access_denied") || text.includes("cancelled") || text.includes("canceled")) {
    return "Sign-in was cancelled. You can try again whenever you like.";
  }
  if (text.includes("password") && (text.includes("least") || text.includes("weak"))) {
    return "Use at least 8 characters for your password.";
  }
  if (text.includes("user not found")) {
    return "There is no account with that email. Create one instead.";
  }
  if (
    text.includes("failed to fetch") ||
    text.includes("network") ||
    text.includes("load failed") ||
    text.includes("fetch failed")
  ) {
    return "Couldn't reach the server. Check your connection and try again.";
  }

  return "Something went wrong signing in. Please try again.";
}
