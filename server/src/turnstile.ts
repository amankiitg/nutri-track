/**
 * Verifying a Cloudflare Turnstile response, server-side.
 *
 * The token comes from the widget on /try; the secret is TURNSTILE_SECRET on Render.
 * This is the only thing standing between the public trial endpoints and a script
 * that mints trial codes, so it is checked before any code is sent or any scan runs.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(
  secret: string,
  token: string,
  remoteIp: string | null,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp !== null && remoteIp !== "") body.set("remoteip", remoteIp);

  let response: Response;
  try {
    response = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return false;
  }

  if (!response.ok) return false;

  const json = (await response.json()) as { success?: unknown };
  return json.success === true;
}
