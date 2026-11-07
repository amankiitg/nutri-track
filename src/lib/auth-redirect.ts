/**
 * Where to send someone after they sign in.
 *
 * The `_authenticated` guard puts the path they asked for into `?redirect=`, which makes it
 * attacker-controlled input: a link to `/auth?redirect=https://evil.example` would otherwise turn
 * the sign-in page into an open redirect that lends the app's domain to somebody else's page.
 *
 * Only a same-site absolute path is allowed. `//evil.example` looks like one and is not: browsers
 * read a leading `//` as a protocol-relative host, which is the classic way this check is written
 * one character too loosely.
 */
export const DEFAULT_REDIRECT = "/today";

export function safeRedirect(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_REDIRECT;
  if (!value.startsWith("/")) return DEFAULT_REDIRECT;
  if (value.startsWith("//") || value.startsWith("/\\")) return DEFAULT_REDIRECT;
  return value;
}
