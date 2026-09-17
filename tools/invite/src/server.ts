/**
 * The local invite page: two boxes and a button.
 *
 * Binds to `127.0.0.1` only. Keeping the Gmail credential on this laptop is the whole reason this
 * tool is not a panel on the admin page, and listening on `0.0.0.0` would undo that in one line by
 * putting an endpoint that can write to your mailbox on the local network.
 *
 * It creates drafts. There is no code path here that sends.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stdout } from "node:process";
import { loadGmailConfig, type GmailConfig } from "./env.js";
import { rememberSecret, safeError } from "./redact.js";
import { describeAuthFailure, isImapFailure, pageAuthFailure } from "./imap-error.js";
import {
  renderInviteHtml,
  renderInviteText,
  SENDER_NAME,
  SUBJECT,
} from "../../../shared/invite-email.js";
import { buildMessage, createDraft } from "./draft.js";
import { createdPage, formPage, problemPage } from "./page.js";

/** 8080 is the app and 8787 is the parse-meal service, so this keeps out of both. */
const PORT = 8788;
const HOST = "127.0.0.1";

/** A form with two fields. Anything larger than this is not that. */
const MAX_BODY_BYTES = 4096;

/** Enough to catch a typo. Not an attempt at validating addresses, which is not really possible. */
function looksLikeAnAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    // The page loads nothing from anywhere, and says so.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    "x-content-type-options": "nosniff",
  });
  res.end(html);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("That request was too large to be this form."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * The failure, as the page shows it.
 *
 * Google's own words when the error came from IMAP, and the plain message otherwise: a request
 * body this tool rejected itself would otherwise be reported as Google refusing a credential.
 */
function failureText(error: unknown): string {
  return isImapFailure(error) ? pageAuthFailure(describeAuthFailure(error)) : safeError(error);
}

async function createFromForm(
  req: IncomingMessage,
  res: ServerResponse,
  config: GmailConfig,
): Promise<void> {
  const form = new URLSearchParams(await readBody(req));
  const name = (form.get("name") ?? "").trim();
  const email = (form.get("email") ?? "").trim();

  if (name === "") {
    sendHtml(res, 400, formPage(config.address, "A first name is needed for the greeting."));
    return;
  }
  if (!looksLikeAnAddress(email)) {
    sendHtml(res, 400, formPage(config.address, `"${email}" does not look like an email address.`));
    return;
  }

  const recipient = { firstName: name, invitedEmail: email };
  const message = await buildMessage(
    {
      fromName: SENDER_NAME,
      toName: name,
      toEmail: email,
      subject: SUBJECT,
      html: renderInviteHtml(recipient),
      text: renderInviteText(recipient),
    },
    config,
  );

  await createDraft(message, config);
  sendHtml(res, 200, createdPage({ name, email, address: config.address }));
}

function main(): void {
  const config = loadGmailConfig();
  rememberSecret(config.appPassword);

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === "GET") {
          sendHtml(res, 200, formPage(config.address));
          return;
        }
        if (req.method === "POST" && req.url === "/draft") {
          await createFromForm(req, res, config);
          return;
        }
        sendHtml(res, 404, problemPage("No such page."));
      } catch (error) {
        // The only thing that reaches the browser is a redacted message. A login failure gets
        // Google's own words, because "Command failed" is not something anyone can act on.
        sendHtml(res, 500, problemPage(failureText(error)));
      }
    })();
  });

  server.on("error", (error) => {
    process.stderr.write(`\n${safeError(error)}\n`);
    process.exitCode = 1;
  });

  server.listen(PORT, HOST, () => {
    stdout.write(
      [
        "",
        `  Invite someone  →  http://${HOST}:${PORT}`,
        "",
        `  Creates a Gmail draft in ${config.address}. It never sends.`,
        "  Ctrl+C to stop.",
        "",
      ].join("\n"),
    );
  });
}

main();
