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
import { loadGmailConfig } from "./env.js";
import { rememberSecret, safeError } from "./redact.js";
import { createClient, findDraftsPath } from "./draft.js";

async function main(): Promise<void> {
  const config = loadGmailConfig();
  rememberSecret(config.appPassword);

  const client = createClient(config);
  await client.connect();
  try {
    const drafts = await findDraftsPath(client);
    stdout.write(
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
// stops. stderr is synchronous for a terminal, so nothing is cut off.
main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`\nCould not sign in.\n${safeError(error)}\n`);
    process.exit(1);
  },
);
