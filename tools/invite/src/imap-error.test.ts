/**
 * Reading the reason out of an imapflow failure.
 *
 * The shapes here are not invented: `captured()` is the error Gmail actually returned for a
 * credential that could not possibly be right, copied field for field from a live probe. What
 * made this file necessary is that `message` on that error is the string `Command failed`, while
 * every useful part of it sits in fields beside the message.
 *
 * The last two tests are the point of the redaction rule: the credential must not reach the
 * output even when it has been pasted into the error by whatever produced it.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  describeAuthFailure,
  formatAuthFailure,
  isImapFailure,
  pageAuthFailure,
} from "./imap-error.js";
import { rememberSecret } from "./redact.js";

const SECRET = "abcdefghijklmnop";

/** The error imapflow raises for a rejected credential, exactly as observed. */
function captured(): Error {
  const error = new Error("Command failed");
  Object.assign(error, {
    response: "3 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)",
    responseText: "Invalid credentials (Failure)",
    serverResponseCode: "AUTHENTICATIONFAILED",
    responseStatus: "NO",
    authenticationFailed: true,
  });
  return error;
}

test("the server's own reason is reported, not the generic message imapflow leaves behind", () => {
  const failure = describeAuthFailure(captured());

  assert.equal(failure.reason, "Invalid credentials (Failure)");
  assert.equal(failure.code, "AUTHENTICATIONFAILED");
  // The message is still the useless string, which is the whole reason this module reads
  // the fields beside it instead.
  assert.equal((captured() as Error).message, "Command failed");
});

test("a rejected credential names both credential causes, because the code cannot separate them", () => {
  const { interpretation } = describeAuthFailure(captured());

  assert.match(interpretation, /app password/);
  assert.match(interpretation, /2-Step Verification/);
  assert.match(interpretation, /Advanced Protection/);
  // And it must not claim the one thing this error does not say.
  assert.doesNotMatch(interpretation, /switched off/);
});

test("text saying IMAP is off names that cause and the setting to change", () => {
  const error = new Error("Command failed");
  Object.assign(error, {
    responseText: "IMAP access is disabled for your domain",
    serverResponseCode: "ALERT",
  });
  const { interpretation } = describeAuthFailure(error);

  assert.match(interpretation, /IMAP is switched off/);
  assert.match(interpretation, /Forwarding and POP\/IMAP/);
});

test("a login the server never answered is reported as a connection problem, not a credential one", () => {
  const error = new Error("Command failed");
  Object.assign(error, { responseStatus: "NO" });
  const { interpretation } = describeAuthFailure(error);

  assert.match(interpretation, /never answered/);
  assert.doesNotMatch(interpretation, /app password is wrong/);
});

test("an error that is not an IMAP failure is not treated as one", () => {
  assert.equal(isImapFailure(captured()), true);
  assert.equal(isImapFailure(new Error("that request was too large to be this form")), false);
});

test("the credential is redacted out of the server text, wherever it was pasted in", () => {
  rememberSecret(SECRET);

  const error = new Error("Command failed");
  Object.assign(error, {
    response: `3 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure) ${SECRET}`,
    responseText: `Invalid credentials (Failure) ${SECRET}`,
    serverResponseCode: "AUTHENTICATIONFAILED",
  });
  const failure = describeAuthFailure(error);

  for (const output of [formatAuthFailure(failure), pageAuthFailure(failure)]) {
    assert.ok(!output.includes(SECRET));
    assert.ok(output.includes("[redacted]"));
  }
});

test("executedCommand is never read, even though it is on the error", () => {
  rememberSecret(SECRET);

  const base64 = Buffer.from(SECRET).toString("base64");
  const error = captured();
  Object.assign(error, { executedCommand: `4 AUTHENTICATE PLAIN ${base64}` });

  for (const output of [
    formatAuthFailure(describeAuthFailure(error)),
    pageAuthFailure(describeAuthFailure(error)),
  ]) {
    assert.ok(!output.includes(base64));
    assert.ok(!output.includes("executedCommand"));
    assert.ok(!output.includes("AUTHENTICATE"));
  }
});

test("the page's form of the report is unindented, since it renders in a paragraph", () => {
  const text = pageAuthFailure(describeAuthFailure(captured()));

  assert.ok(text.startsWith("Invalid credentials (Failure) (AUTHENTICATIONFAILED)"));
  assert.ok(!text.split("\n").some((line) => line.startsWith(" ")));
});
