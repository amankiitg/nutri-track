/**
 * The one place the Gmail credential is allowed to exist, and the sieve every message passes
 * through before it is printed.
 *
 * The previous version of this script had the app password written into it in plaintext, and it
 * ended up somewhere it should not have. So the rules here are absolute: the secret is read from
 * the environment into exactly one module-level binding, nothing in this tool prints it, logs it
 * or puts it in an error message, and every string that reaches stdout or stderr goes through
 * `redact` first.
 *
 * `rememberSecret` exists so that even the failure paths are covered: an IMAP server that echoes
 * a failed LOGIN line back, a library that puts the connection options in its message, a stack
 * whose source line quotes the argument. All of those are strings, and all of them can be
 * sieved.
 */
let secret = "";

/** Marks the credential for redaction. Called once, before anything can fail. */
export function rememberSecret(value: string): void {
  secret = value;
}

/** Replaces the credential with a marker wherever it appears. */
export function redact(text: string): string {
  if (secret === "") return text;
  return text.split(secret).join("[redacted]");
}

/**
 * An error message, safe to print.
 *
 * Only the message, never the stack: a stack quotes source lines and argument values, and there
 * is nothing in a stack this tool needs to say to a reader.
 */
export function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const sieved = redact(raw).trim();
  return sieved === "" ? "unknown error" : sieved;
}
