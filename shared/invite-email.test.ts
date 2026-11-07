/**
 * The two emails, as strings.
 *
 * These live here rather than at the transport, because a transport encodes what it is given: the
 * MIME builder quoted-printable-encodes `=` and wraps long lines, so an assertion about a URL or a
 * name against the composed message is really an assertion about the encoder. What this file pins is
 * what the message says; `server/test/app.test.ts` pins that the service sends it.
 *
 * The three things worth being careful about are all about a value a person typed:
 *
 *   - an address in a link has to be percent-encoded, because `+` is a space to a query parser
 *   - a name in HTML has to be escaped, because otherwise it is markup in somebody's inbox
 *   - a name in a header has to have its line breaks and quotes removed, because a header is
 *     line-based and a quote ends the display name
 */
import { describe, expect, it } from "vitest";
import {
  approvedMessageFields,
  inviteMessageFields,
  renderApprovedHtml,
  renderApprovedText,
  renderInviteHtml,
} from "./invite-email";

const TAGGED = "amank.iitg+nt1@gmail.com";
const TAGGED_ENCODED = "amank.iitg%2Bnt1%40gmail.com";

describe("the approval", () => {
  it("puts the address in the link, in the button and in the plain text", () => {
    const fields = approvedMessageFields({ firstName: "Hope", invitedEmail: TAGGED });

    // `?email=` is what makes the sign-in page continue by itself, so the person lands on the form
    // their account needs. Both parts carry it: a reader that cannot render HTML still gets a link.
    expect(fields.html).toContain(`href="https://tracknutri.app/auth?email=${TAGGED_ENCODED}"`);
    expect(fields.text).toContain(`https://tracknutri.app/auth?email=${TAGGED_ENCODED}`);
  });

  it("greets by name, and by nothing at all when there is no name", () => {
    expect(renderApprovedText({ firstName: "Hope", invitedEmail: TAGGED })).toContain("Hi Hope,");
    expect(renderApprovedText({ firstName: "   ", invitedEmail: TAGGED })).toContain("Hi there,");
    // Not "Hi ,", which is what an empty name produces without the fallback.
    expect(renderApprovedText({ firstName: "", invitedEmail: TAGGED })).not.toContain("Hi ,");
  });

  it("escapes the name in the HTML part and leaves it alone in the text part", () => {
    const recipient = { firstName: "<b>Bo & co</b>", invitedEmail: TAGGED };

    // HTML: the angle brackets are text, not markup.
    expect(renderApprovedHtml(recipient)).toContain("Hi &lt;b&gt;Bo &amp; co&lt;/b&gt;,");
    expect(renderApprovedHtml(recipient)).not.toContain("Hi <b>Bo");
    // Plain text has no markup to escape, so the same name reads as what they typed.
    expect(renderApprovedText(recipient)).toContain("Hi <b>Bo & co</b>,");
  });

  it("keeps a name out of the headers it could break", () => {
    const fields = approvedMessageFields({
      firstName: 'Hope\r\nBcc: someone@example.com"',
      invitedEmail: TAGGED,
    });

    // A newline in a header value is how a second header gets added, and a quote ends the display
    // name early. Neither survives.
    expect(fields.to.name).not.toMatch(/[\r\n"]/);
    expect(fields.to.address).toBe(TAGGED);
    expect(fields.from).toEqual({ name: "NutriTrack", address: "invites@tracknutri.app" });
  });
});

describe("the invite", () => {
  it("escapes the name and the address in its HTML part too", () => {
    // The invite has the same two person-controlled values, so it has the same two risks. Written
    // once as a helper and used in both, which is why this test exists: the second template is
    // where escaping gets forgotten.
    const html = renderInviteHtml({
      firstName: "<i>Ada</i>",
      invitedEmail: "ada+x@example.com",
    });

    expect(html).toContain("Hi &lt;i&gt;Ada&lt;/i&gt;,");
    expect(html).not.toContain("Hi <i>Ada</i>,");
    expect(html).toContain("ada+x@example.com");
  });

  it("has a From the app owns, not the mailbox the draft lives in", () => {
    expect(inviteMessageFields({ firstName: "Ada", invitedEmail: TAGGED }).from).toEqual({
      name: "NutriTrack",
      address: "invites@tracknutri.app",
    });
  });
});
