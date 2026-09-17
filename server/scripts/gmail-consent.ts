/**
 * One-time, on a laptop: turn a Google consent into a refresh token. Never run on Render.
 *
 * The token is what the deployed service uses to create drafts. This is the only moment the
 * credential is visible in any form, so it goes straight into a file outside the repository with
 * owner-only permissions, and is never printed — not to the terminal, not into a shell history,
 * not into the page it serves.
 *
 * Setup, once, in the Google Cloud console:
 *
 *   1. Create an OAuth client of type **Web application**.
 *   2. Add `http://127.0.0.1:8789/callback` as an authorised redirect URI, exactly.
 *   3. On the OAuth consent screen, add `https://www.googleapis.com/auth/gmail.compose` and add
 *      your own address as a test user. Publishing to "In production" is what removes the 7-day
 *      refresh-token expiry; this app is personal use, so it needs no verification review.
 *   4. Put the client id and secret in the root `.env` as GMAIL_OAUTH_CLIENT_ID and
 *      GMAIL_OAUTH_CLIENT_SECRET.
 *
 * Then run `npm run gmail:consent` from `server/` and follow the one line it prints.
 */
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { stdout } from "node:process";
import { GMAIL_COMPOSE_SCOPE } from "../src/gmail";
import { loadRootEnvFile } from "../src/env-file";

const PORT = 8789;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Outside the repository on purpose: a file that cannot be committed cannot be committed by accident. */
const TOKEN_FILE = join(homedir(), ".nutritrack-gmail-refresh-token");

loadRootEnvFile();

const clientId = process.env["GMAIL_OAUTH_CLIENT_ID"] ?? "";
const clientSecret = process.env["GMAIL_OAUTH_CLIENT_SECRET"] ?? "";

if (clientId === "" || clientSecret === "") {
  stdout.write(
    "\nSet GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET in the root .env first.\n" +
      "They come from the OAuth client described at the top of this file.\n\n",
  );
  process.exit(1);
}

const consentUrl = `${AUTH_URL}?${new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT,
  response_type: "code",
  scope: GMAIL_COMPOSE_SCOPE,
  // Offline is what asks for a refresh token at all, and prompt=consent forces one even on a
  // re-run. Without both, a second run returns no refresh token and looks like a failure.
  access_type: "offline",
  prompt: "consent",
}).toString()}`;

/**
 * Exchanges the code and writes the token.
 *
 * The token is written before anything is said about it, and the only thing said is where it is.
 * Printing it, even once, would put it in a scrollback buffer and a shell history.
 */
async function exchange(code: string): Promise<void> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
    }).toString(),
  });

  const body = (await response.json()) as { refresh_token?: unknown; error?: unknown };
  if (!response.ok || typeof body.refresh_token !== "string" || body.refresh_token === "") {
    // Google's own error code, never a description that might quote something.
    stdout.write(
      `\nGoogle refused the exchange (${response.status}, ${
        typeof body.error === "string" ? body.error : "unknown"
      }).\n` +
        "A refresh token is only returned with access_type=offline and prompt=consent, which this\n" +
        "script sets, so check that the redirect URI is registered exactly.\n\n",
    );
    return;
  }

  writeFileSync(TOKEN_FILE, `${body.refresh_token}\n`, { mode: 0o600 });
  stdout.write(
    [
      "",
      "Done. The refresh token is in:",
      `  ${TOKEN_FILE}`,
      "",
      "  It was not printed here and should not be. Next:",
      "    1. On Render, set GMAIL_OAUTH_REFRESH_TOKEN to the file's contents.",
      "    2. Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET there too.",
      "    3. Set INVITE_SENDER_ADDRESS to the mailbox the drafts belong in.",
      "    4. Delete the file.",
      "",
      "  The service reads them from Render's environment panel only. If it ever needs",
      "  re-authorising, run this again and paste the new value.",
      "",
    ].join("\n"),
  );
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", REDIRECT);
  if (url.pathname !== "/callback") {
    response.writeHead(404).end("Not here.");
    return;
  }
  const code = url.searchParams.get("code");
  if (code === null) {
    response.writeHead(400).end("Google did not send a code. Run the script again.");
    return;
  }

  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.end("Done. Close this tab and go back to the terminal.");

  void exchange(code).finally(() => {
    server.close(() => process.exit(0));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  stdout.write(
    [
      "",
      "Open this in the browser you are signed in to Google with, and approve:",
      "",
      `  ${consentUrl}`,
      "",
      "Waiting for the redirect. Ctrl+C to give up.",
      "",
    ].join("\n"),
  );
});
