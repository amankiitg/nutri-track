/**
 * The template, and the message built from it.
 *
 * No network and no credentials: `buildMessage` is pure. What matters is that both parts exist,
 * the recipient is right, the sender comes from the configuration rather than from the source,
 * and the instruction people get wrong — which address to sign in with — survives into the
 * plain-text fallback.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PREVIEW, renderInviteHtml, renderInviteText, SENDER_NAME, SUBJECT } from "./invite.js";
import { buildMessage } from "./draft.js";

const RECIPIENT = { firstName: "Priya", invitedEmail: "priya@example.com" };
const CONFIG = { address: "aman@example.com", appPassword: "not-a-real-password" };

const INPUT = {
  fromName: SENDER_NAME,
  toName: RECIPIENT.firstName,
  toEmail: RECIPIENT.invitedEmail,
  subject: SUBJECT,
  html: renderInviteHtml(RECIPIENT),
  text: renderInviteText(RECIPIENT),
};

test("the preview renders the placeholders, so the committed file stays generic", () => {
  const html = renderInviteHtml(PREVIEW);

  assert.ok(html.includes("{{First name}}"));
  assert.ok(html.includes("{{invited email}}"));
});

test("the HTML names the person and the address the invite is tied to", () => {
  const html = renderInviteHtml(RECIPIENT);

  assert.ok(html.includes("Hi Priya,"));
  assert.ok(html.includes("priya@example.com"));
  assert.ok(html.includes("invite is tied to that address"));
  assert.ok(html.includes(SENDER_NAME));
  // Real values means no placeholder is left behind.
  assert.ok(!html.includes("{{"));
});

test("the plain-text fallback carries the address too, which is the part people get wrong", () => {
  const text = renderInviteText(RECIPIENT);

  assert.ok(text.includes("Hi Priya,"));
  assert.ok(text.includes("priya@example.com"));
  assert.ok(text.includes("https://tracknutri.app"));
  assert.ok(!text.includes("{{"));
});

test("the message is multipart/alternative, not HTML only", async () => {
  const raw = (await buildMessage(INPUT, CONFIG)).toString("utf8");

  assert.match(raw, /Content-Type: multipart\/alternative/);
  assert.match(raw, /Content-Type: text\/plain/);
  assert.match(raw, /Content-Type: text\/html/);
  assert.ok(raw.includes("priya@example.com"));
  assert.ok(raw.includes("Subject: "));
});

test("the sender is the configured mailbox, not a name written into the source", async () => {
  const raw = (await buildMessage(INPUT, CONFIG)).toString("utf8");

  assert.ok(raw.includes(CONFIG.address));
});

test("the home-screen tip names Safari in both parts, since it is the only iOS browser that can", () => {
  const html = renderInviteHtml(RECIPIENT);
  const text = renderInviteText(RECIPIENT);

  for (const part of [html, text]) {
    assert.match(part, /Safari/);
    assert.match(part, /Add to Home Screen/);
  }
});
