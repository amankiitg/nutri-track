/**
 * The address someone typed on the sign-in screen, kept only until Google comes back.
 *
 * A person types an address, then presses Continue with Google and picks a different account in
 * the chooser, which is easy to do and leaves them signed in as somebody they did not name. The
 * screen that returns them cannot know what they typed unless it is remembered, and it must not
 * be remembered for longer than that: session storage, one key, cleared the moment it is read.
 *
 * Not localStorage: this is not a preference, and a value left on the device after the browser is
 * closed would outlive the attempt it belongs to.
 */

export const PENDING_GOOGLE_EMAIL_KEY = "nutritrack:pending-google-email";

/** Remembers the address the person meant to use, if they typed one. */
export function rememberPendingGoogleEmail(address: string): void {
  try {
    const trimmed = address.trim().toLowerCase();
    if (trimmed === "") {
      window.sessionStorage.removeItem(PENDING_GOOGLE_EMAIL_KEY);
      return;
    }
    window.sessionStorage.setItem(PENDING_GOOGLE_EMAIL_KEY, trimmed);
  } catch {
    // Storage can be blocked or full. The check is a courtesy; losing it must not stop a sign-in.
  }
}

/** What they typed, and nothing at all once the answer has been used. */
export function takePendingGoogleEmail(): string | null {
  try {
    const value = window.sessionStorage.getItem(PENDING_GOOGLE_EMAIL_KEY);
    window.sessionStorage.removeItem(PENDING_GOOGLE_EMAIL_KEY);
    return value === null || value === "" ? null : value;
  } catch {
    return null;
  }
}

/** Forgets it without reading it, for the paths that never look. */
export function clearPendingGoogleEmail(): void {
  try {
    window.sessionStorage.removeItem(PENDING_GOOGLE_EMAIL_KEY);
  } catch {
    // Nothing to do: there was no readable store to begin with.
  }
}

/**
 * Whether Google came back as somebody else.
 *
 * Compared case-insensitively and after trimming, because an address is the same address in any
 * casing and a false warning would be worse than none.
 */
export function signedInAsSomebodyElse(typed: string | null, actual: string | null): boolean {
  if (typed === null || actual === null) return false;
  return typed.trim().toLowerCase() !== actual.trim().toLowerCase();
}
