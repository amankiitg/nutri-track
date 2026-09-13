/**
 * Why a Gmail login failed, in Google's own words.
 *
 * imapflow reports *every* failed command as `Error('Command failed')` and puts the reason in
 * fields beside the message: `responseText` (the human-readable tail), `response` (the whole
 * response line) and `serverResponseCode` (the bracketed code, e.g. AUTHENTICATIONFAILED). A
 * reader given only `message` learns nothing, and for a while this tool gave them exactly that.
 *
 * Three rules.
 *
 * **Google's own text is always printed.** It is the only part of this that is evidence rather
 * than inference, so it is never summarised away. A captured example, from a login that could not
 * possibly succeed: `responseText` was `Invalid credentials (Failure)` and `serverResponseCode`
 * was `AUTHENTICATIONFAILED`, while `message` was still `Command failed`.
 *
 * **A cause is named only where the evidence names one.** `AUTHENTICATIONFAILED` is what Google
 * returns for any credential it will not accept, so it does not distinguish a wrong app password
 * from an account password on an account that requires an app password. Where the reply is
 * genuinely ambiguous, the ambiguity is stated and nothing is asserted.
 *
 * **Nothing here prints the credential, or any part of it.** Every string goes through `redact`,
 * and `executedCommand` is never read at all: it is the compiled command line, and a field whose
 * whole purpose is to quote the command is not one to print.
 */
import { redact } from "./redact.js";

export interface AuthFailure {
  /** What the server said, redacted. `undefined` when the error carried no server text. */
  reason: string | undefined;
  /** The bracketed response code, e.g. AUTHENTICATIONFAILED. `undefined` when there was none. */
  code: string | undefined;
  /** What the evidence points at, or an explicit statement that it points at nothing. */
  interpretation: string;
}

/** Reads a field off an unknown error without asserting a shape it has not been shown. */
function fieldOf(error: unknown, key: string): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  return (error as Record<string, unknown>)[key];
}

/** A redacted, trimmed string, or `undefined` if there was nothing to say. */
function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = redact(value).trim();
  return trimmed === "" ? undefined : trimmed;
}

const IMAP_DISABLED = /imap[^.]{0,40}disab|disab[^.]{0,40}imap/i;
const WANTS_WEB_SIGN_IN = /web browser|less secure|application-specific password/i;

/**
 * Splits a failure into the server's own words, its code, and what that points at.
 *
 * The interpretations are written to say which of the three causes it is *when* the server has
 * said so, and to say that it has not when it has not. Guessing between them is worse than
 * listing them: the two credential causes need different actions, and one of them needs a
 * different tool.
 */
export function describeAuthFailure(error: unknown): AuthFailure {
  const code = textOf(fieldOf(error, "serverResponseCode"));
  const responseText = textOf(fieldOf(error, "responseText"));
  const response = textOf(fieldOf(error, "response"));
  const message = textOf(error instanceof Error ? error.message : error);

  // `response` is the whole line ("3 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)")
  // and `responseText` is the tail of it. The tail is the readable one; the line is the fallback
  // for when a server sends a code with no text. `message` is last, because on a connection
  // failure it is the only thing there is and it is then genuinely informative ("Socket timeout").
  const reason = responseText ?? response ?? message;

  const hasServerText = responseText !== undefined || response !== undefined;

  if (!hasServerText && code === undefined) {
    return {
      reason,
      code,
      interpretation:
        "No reason came back from the server, which is not a credential problem: the login was never answered. The usual causes are the network this machine is on, or a proxy blocking port 993.",
    };
  }

  if (reason !== undefined && IMAP_DISABLED.test(reason)) {
    return {
      reason,
      code,
      interpretation:
        "Gmail is saying IMAP is switched off for this account, so no password will work. Turn it on in Gmail: Settings, See all settings, Forwarding and POP/IMAP, Enable IMAP. It takes a few minutes to take effect.",
    };
  }

  if (code === "AUTHENTICATIONFAILED") {
    const pointed =
      reason !== undefined && WANTS_WEB_SIGN_IN.test(reason)
        ? "Gmail is refusing this password and pointing you at the web sign-in, which is what it says when the password is the account password rather than an app password.\n"
        : "Gmail rejected the credential. This reply is the same for every credential it will not accept, so it does not say which of these it was:\n";
    return {
      reason,
      code,
      interpretation:
        pointed +
        "  - the app password is wrong, or has been revoked (make a new one)\n" +
        "  - the password used is the account password, not an app password: app passwords need 2-Step Verification, and Google does not offer them at all on accounts enrolled in Advanced Protection. If yours is in Advanced Protection, no app password exists to use and this tool needs the Gmail API instead.",
    };
  }

  if (code === "ALERT") {
    return {
      reason,
      code,
      interpretation:
        "Gmail is asking for something to change in the account rather than saying the password was wrong, and its own words above say what. This is the code it uses for most account-state problems, so read the text rather than the code.",
    };
  }

  return {
    reason,
    code,
    interpretation:
      "This does not match any of the failures this tool knows how to name, so the text above is the whole of what is known. Nothing is inferred from it.",
  };
}

/** The multi-line report `npm run invite:check` prints. */
export function formatAuthFailure(failure: AuthFailure): string {
  const lines = [
    "",
    `  Google said: ${failure.reason ?? "(nothing)"}`,
    `  Response code: ${failure.code ?? "(none)"}`,
    "",
    `  ${failure.interpretation}`,
    "",
  ];
  return lines.join("\n");
}

/**
 * The same report, unindented, for the page's wrapping box.
 *
 * The interpretation is written with two-space indentation because that is what reads well under
 * a terminal prompt; in a paragraph box the indentation just makes it look accidental.
 */
export function pageAuthFailure(failure: AuthFailure): string {
  const prose = failure.interpretation
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
  const code = failure.code === undefined ? "" : ` (${failure.code})`;
  return `${failure.reason ?? "Gmail gave no reason"}${code}\n\n${prose}`;
}

/**
 * Whether this is a failure from the IMAP server rather than one this tool raised itself.
 *
 * `describeAuthFailure` interprets every error it is given as a login failure, so a
 * missing-environment-variable error or an oversized request would be reported as Google
 * refusing a credential. Those never carry any of these fields; an IMAP failure always does.
 */
export function isImapFailure(error: unknown): boolean {
  return [
    "serverResponseCode",
    "responseText",
    "response",
    "authenticationFailed",
    "responseStatus",
  ].some((key) => fieldOf(error, key) !== undefined);
}
