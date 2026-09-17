/**
 * Creating a Gmail draft, and nothing else.
 *
 * **There is no send path in this file, and that is the point of it being one file.** The only
 * request this module can build goes to `drafts.create`, the credential carries the
 * `gmail.compose` scope rather than `mail.google.com/`, and `server/test/gmail.test.ts` fails if
 * the Gmail send endpoint is ever named in this file — including in a comment, which it proved
 * by failing on an earlier draft of this one. An invite is a draft a person reads and sends
 * themselves; if this module could send, eventually something would.
 *
 * The credential is a refresh token, not an app password, because it lives on Render: it is
 * revocable on its own from the Google account page, scoped, and attributed to a named app in
 * the list of third-party access. It may not reach a response, a log or an error — see `scrub`.
 */
import { ApiError } from "./errors";
import { log } from "./log";

/**
 * The narrowest scope that can create a draft.
 *
 * Restricted rather than sensitive, which matters: a *public* app using it needs Google's
 * verification and an annual security assessment. This app is for personal use under Google's
 * exemption for apps with fewer than 100 users, so it needs neither, and the reader clicks
 * through one "unverified app" screen when granting access. Going past 100 users would require
 * the assessment.
 */
export const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRAFTS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";

/** One message, because the admin's next move is the same for every cause. */
export const GMAIL_FAILURE_MESSAGE =
  "Could not create the draft in Gmail. Nothing was added to the invite list. Check the Google " +
  "credentials, then try again.";

export interface GmailCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface GmailDraftClient {
  /** Creates the draft and returns its id. It cannot send. */
  createDraft(mime: Buffer): Promise<string>;
}

/** How the client reaches the network. Injected so tests never make a request. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function createGmailDraftClient(
  credentials: GmailCredentials,
  fetchImpl: FetchLike = fetch,
): GmailDraftClient {
  let accessToken: string | undefined;
  let expiresAt = 0;

  /**
   * Removes our own secrets from any string before it is logged.
   *
   * Google does not echo credentials back, but the rule is that they cannot reach a log or an
   * error *at all*, and a rule that depends on another party's behaviour is not a rule. Every
   * string this module logs goes through here first.
   */
  function scrub(text: string): string {
    let out = text;
    for (const value of [credentials.clientSecret, credentials.refreshToken, accessToken]) {
      if (value !== undefined && value !== "") out = out.split(value).join("[redacted]");
    }
    return out;
  }

  /** Google's own short error code, never its free-text description. */
  function shortError(body: unknown): string {
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      const code = record["error"];
      if (typeof code === "string") return code;
      if (typeof code === "object" && code !== null) {
        const nested = (code as Record<string, unknown>)["status"];
        if (typeof nested === "string") return nested;
      }
    }
    return "unknown";
  }

  async function readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  /** A fresh access token, or the cached one while it still has life in it. */
  async function token(): Promise<string> {
    // A minute of slack so a token cannot expire mid-request.
    if (accessToken !== undefined && Date.now() < expiresAt - 60_000) return accessToken;

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
    });

    let response: Response;
    try {
      response = await fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      // A transport failure names the URL, never the body it was sending.
      log("error", "gmail token request failed", { error: scrub(String(error)) });
      throw new ApiError(502, "upstream_error", GMAIL_FAILURE_MESSAGE);
    }

    const payload = await readJson(response);
    if (!response.ok) {
      log("error", "gmail rejected the refresh token", {
        status: response.status,
        error: shortError(payload),
      });
      throw new ApiError(502, "upstream_error", GMAIL_FAILURE_MESSAGE);
    }

    const parsed = payload as { access_token?: unknown; expires_in?: unknown };
    if (typeof parsed.access_token !== "string" || parsed.access_token === "") {
      log("error", "gmail token response had no access token", { status: response.status });
      throw new ApiError(502, "upstream_error", GMAIL_FAILURE_MESSAGE);
    }

    accessToken = parsed.access_token;
    const lifetimeSeconds = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
    expiresAt = Date.now() + lifetimeSeconds * 1000;
    return accessToken;
  }

  return {
    async createDraft(mime) {
      const bearer = await token();

      let response: Response;
      try {
        response = await fetchImpl(DRAFTS_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ message: { raw: mime.toString("base64url") } }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        log("error", "gmail draft request failed", { error: scrub(String(error)) });
        throw new ApiError(502, "upstream_error", GMAIL_FAILURE_MESSAGE);
      }

      const payload = await readJson(response);
      if (!response.ok) {
        log("error", "gmail refused to create the draft", {
          status: response.status,
          error: shortError(payload),
        });
        throw new ApiError(502, "upstream_error", GMAIL_FAILURE_MESSAGE);
      }

      const draft = (payload as { id?: unknown }).id;
      if (typeof draft !== "string" || draft === "") {
        log("error", "gmail created a draft with no id", { status: response.status });
        throw new ApiError(502, "upstream_error", GMAIL_FAILURE_MESSAGE);
      }
      return draft;
    },
  };
}
