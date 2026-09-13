/**
 * The credential must never be printed, logged, or put in an error message.
 *
 * Not a hypothetical: an earlier version of this script carried the app password in plaintext in
 * the source, and it ended up somewhere it should not have. So the sieve gets its own tests.
 *
 * `rememberSecret` is module state and node:test runs a file's tests in declaration order, which
 * the first test depends on.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { redact, rememberSecret, safeError } from "./redact.js";

/** Shaped like a Gmail app password. Not one, and not used to authenticate anywhere. */
const SECRET = "abcd efgh ijkl mnop";

test("passes text through untouched before a secret is known", () => {
  assert.equal(redact("nothing to hide here"), "nothing to hide here");
});

test("cuts the secret out of a longer string", () => {
  rememberSecret(SECRET);
  assert.equal(
    redact(`login failed for ${SECRET} at imap.gmail.com`),
    "login failed for [redacted] at imap.gmail.com",
  );
});

test("replaces every occurrence, not only the first", () => {
  assert.equal(redact(`${SECRET} and again ${SECRET}`), "[redacted] and again [redacted]");
});

test("strips the secret from an Error's message", () => {
  assert.equal(
    safeError(new Error(`AUTHENTICATE ${SECRET} failed`)),
    "AUTHENTICATE [redacted] failed",
  );
});

test("strips it from a thrown string, which is not an Error at all", () => {
  assert.equal(safeError(`boom ${SECRET}`), "boom [redacted]");
});

test("never returns an empty message", () => {
  assert.equal(safeError(new Error("")), "unknown error");
});

test("says only the message, never the stack", () => {
  // The CLI prints `safeError` and never the error itself, because a stack quotes source lines
  // and argument values. This pins that the stack is not what reaches a reader.
  const error = new Error("sign-in failed");
  error.stack = `Error: sign-in failed\n    at login("${SECRET}")`;

  const message = safeError(error);
  assert.equal(message, "sign-in failed");
  assert.ok(!message.includes(SECRET));
});
