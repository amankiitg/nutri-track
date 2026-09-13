/**
 * Checks the Gmail credential and the connection, without creating anything.
 *
 * This answers the questions the tool otherwise cannot answer for you: whether the app password
 * is accepted at all, whether IMAP is enabled on the account, and whether there is a Drafts
 * folder to append to. It creates no draft and sends nothing, so it is safe to run before the
 * first invite, and again if something stops working.
 *
 * An app password is not offered at all on accounts enrolled in Advanced Protection, and it
 * requires 2-Step Verification. A failure here saying the credentials were rejected is usually
 * one of those two, or a password that has since been rotated.
 */
import { stdout } from "node:process";
import type { Writable } from "node:stream";
import { loadGmailConfig } from "./env.js";
import { rememberSecret, safeError } from "./redact.js";
import { describeAuthFailure, formatAuthFailure, isImapFailure } from "./imap-error.js";
import { createClient, findDraftsPath } from "./draft.js";

/** Awaiting the write is what makes the explicit exits below safe when stdout is a pipe. */
function write(stream: Writable, text: string): Promise<void> {
  return new Promise<void>((resolve) => {
    stream.write(text, () => resolve());
  });
}

async function main(): Promise<void> {
  const config = loadGmailConfig();
  rememberSecret(config.appPassword);

  const client = createClient(config);
  await client.connect();
  try {
    const drafts = await findDraftsPath(client);
    await write(
      stdout,
      [
        "",
        `${config.address} signed in over IMAP.`,
        `  Drafts folder: ${drafts}`,
        "",
        "Ready. `npm run invite` will create a draft for you to read and send.",
        "",
      ].join("\n"),
    );
  } finally {
    await client.logout().catch(() => undefined);
  }
}

// Explicit exits rather than an exit code: a failed IMAP handshake can leave a socket timer
// behind, and a one-shot command that hangs after printing its answer is worse than one that
// stops. The writes above are awaited first, because a pipe takes them asynchronously and
// `process.exit` would otherwise discard them: the command would print nothing and look like
// it had failed for a different reason.
//
// A login failure is reported through `describeAuthFailure`, not `safeError`: imapflow leaves the
// server's reason beside the error message and the message is always the same generic string, so
// `safeError` alone is what made this command say `Command failed` and nothing more.
main().then(
  () => process.exit(0),
  async (error: unknown) => {
    const report = isImapFailure(error)
      ? `\nCould not sign in.\n${formatAuthFailure(describeAuthFailure(error))}`
      : `\n${safeError(error)}\n`;
    await write(process.stderr, report);
    process.exit(1);
  },
);
