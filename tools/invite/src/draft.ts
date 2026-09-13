/**
 * Building the message, and putting it in Gmail's Drafts folder.
 *
 * There is no code path in this tool that sends. A draft is the whole output: the point is to
 * read each one before it goes, and a tool that could send would eventually send something
 * unreviewed.
 */
import { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer";
import type { GmailConfig } from "./env.js";

export interface DraftInput {
  fromName: string;
  toName: string;
  toEmail: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * The RFC 5322 message, as `multipart/alternative` so a client that refuses HTML still gets
 * something readable.
 *
 * Composed rather than assembled by hand: the transfer encoding for a part that is not pure
 * ASCII, the line-length limits, and the boundary bookkeeping are all easy to get subtly wrong,
 * and a body that arrives with `=C3=A9` showing in it is worse than no HTML at all.
 */
export async function buildMessage(input: DraftInput, config: GmailConfig): Promise<Buffer> {
  const composer = new MailComposer({
    from: { name: input.fromName, address: config.address },
    to: { name: input.toName, address: input.toEmail },
    subject: input.subject,
    text: input.text,
    html: input.html,
  });

  return composer.compile().build();
}

/**
 * A client for Gmail, not yet connected.
 *
 * `logger: false` is not tidiness. imapflow logs the IMAP commands it sends, and AUTHENTICATE is
 * one of them: left on, the app password reaches stdout.
 */
export function createClient(config: GmailConfig): ImapFlow {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: config.address, pass: config.appPassword },
    logger: false,
  });

  // imapflow is an EventEmitter, and an unhandled 'error' event is an uncaught exception: Node
  // prints the stack and kills the process. That happened on a socket timeout, which is both a
  // crash and a second copy of the failure printed by a path that never went through `redact`.
  // The failure is already reported — `connect()` and `append()` both reject with it — so this
  // only has to be a handler.
  client.on("error", () => undefined);

  return client;
}

/**
 * The path of the Drafts mailbox.
 *
 * Found by its special-use flag rather than hardcoded: Gmail localises the mailbox name, so
 * "[Gmail]/Drafts" is simply wrong on an account that calls it something else.
 */
export async function findDraftsPath(client: ImapFlow): Promise<string> {
  const mailboxes = await client.list();
  const drafts = mailboxes.find((mailbox) => mailbox.specialUse === "\\Drafts");
  if (drafts === undefined) {
    throw new Error(
      "No Drafts folder on this account, so there is nowhere to put the draft. " +
        "Check that IMAP is enabled in Gmail's settings.",
    );
  }
  return drafts.path;
}

/**
 * Appends a draft to Gmail.
 *
 * `\Draft` is what files it under Drafts rather than showing it as received mail, and it stays
 * editable and sendable like any other draft in the web client. Nothing here sends.
 */
export async function createDraft(message: Buffer, config: GmailConfig): Promise<void> {
  const client = createClient(config);
  await client.connect();
  try {
    await client.append(await findDraftsPath(client), message, ["\\Draft"]);
  } finally {
    // Best effort: a draft that was appended is a success even if the logout does not land.
    await client.logout().catch(() => undefined);
  }
}
