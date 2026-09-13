/**
 * The three pages, as strings.
 *
 * `createdPage` is the reason this file exists: the success path cannot be reached without a real
 * mailbox, so it is the one screen I cannot open in a browser. Everything else here is cheap; this
 * pins the parts of that screen that matter if they were to drift.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createdPage, escapeHtml, formPage, problemPage } from "./page.js";
import { SUBJECT } from "./invite.js";

test("the form is two boxes and a button, and posts to the draft route", () => {
  const html = formPage("aman@example.com");

  assert.match(html, /<form method="post" action="\/draft">/);
  assert.match(html, /<input id="name" name="name"/);
  assert.match(html, /<input id="email" name="email"/);
  assert.match(html, /<button type="submit">Generate draft<\/button>/);
});

test("the form says which account the draft lands in", () => {
  assert.ok(formPage("aman@example.com").includes("aman@example.com"));
});

test("a notice is shown back on the form rather than replacing it", () => {
  const html = formPage("aman@example.com", `"priya@example" is not an address`);

  // Escaped in the markup, which is the point: the notice is echoed back, not injected.
  assert.ok(html.includes("&quot;priya@example&quot; is not an address"));
  // Still a usable form: the point of showing the notice is to let them fix the field.
  assert.match(html, /<button type="submit">Generate draft<\/button>/);
});

test("the created page sends you to Gmail drafts, because that is where reviewing happens", () => {
  const html = createdPage({
    name: "Priya",
    email: "priya@example.com",
    address: "aman@example.com",
  });

  assert.ok(html.includes("https://mail.google.com/mail/u/0/#drafts"));
  assert.ok(html.includes("priya@example.com"));
  assert.ok(html.includes(SUBJECT));
  // It has to be plain text about what happened, never a claim that it was sent.
  assert.ok(html.includes("Draft created"));
});

test("the created page escapes what came out of the form", () => {
  const html = createdPage({
    name: "Tom & Jerry",
    email: "tj@example.com",
    address: "aman@example.com",
  });

  assert.ok(html.includes("Tom &amp; Jerry"));
  assert.ok(!html.includes("Tom & Jerry"));
});

test("the problem page carries a redacted message, so it cannot print a credential", () => {
  const html = problemPage("Command failed");

  assert.ok(html.includes("Command failed"));
  assert.ok(html.includes("Nothing was created and nothing was sent"));
  // The way back, so a failure is not a dead end.
  assert.ok(html.includes('href="/"'));
});

test("escapeHtml covers the four characters that would break the markup", () => {
  assert.equal(escapeHtml(`<a href="x">&`), "&lt;a href=&quot;x&quot;&gt;&amp;");
});
