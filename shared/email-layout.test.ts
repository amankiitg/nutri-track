/**
 * Every email comes from `renderEmail`, and every email carries the brand.
 *
 * The rule this file enforces is the one that was broken: the same shell was hand-written four
 * times, so the Diwali note and the Black Friday note each drifted from the invite. Now the
 * checked-in broadcast HTML must equal the renderer's output exactly, which makes a hand edit a
 * failing test rather than a slow divergence nobody notices until an email goes out.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMAIL_COLOURS, FOOTER_REASON, renderEmail } from "./email-layout";
import { renderApprovedHtml, renderInviteHtml } from "./invite-email";
import { renderBroadcasts } from "../tools/email/render";

const REPO = process.cwd();
const read = (file: string): string => readFileSync(join(REPO, file), "utf8");
const RECIPIENT = { firstName: "Aman", invitedEmail: "amank.iitg@gmail.com" };

/** What "has the brand" means, in one place: the header, the card and the button. */
function expectBrand(html: string, label: string): void {
  expect(html, label + " is missing the logo row").toContain(
    'src="https://tracknutri.app/icons/icon-192.png"',
  );
  expect(html, label + " is missing the page colour").toContain(
    `background-color: ${EMAIL_COLOURS.page}`,
  );
  expect(html, label + " is missing the card").toContain(`background-color: ${EMAIL_COLOURS.card}`);
  expect(html, label + " is missing the leaf green").toContain(EMAIL_COLOURS.leaf);
  expect(html, label + " is missing the 20px card radius").toContain("border-radius: 20px");
  expect(html, label + " is missing the display font").toContain("Fraunces");
  expect(html, label + " is missing the body font").toContain("Manrope");
}

function expectNoDashes(html: string, label: string): void {
  expect(html.match(/\u2014/g) ?? [], label + " has an em dash").toHaveLength(0);
  expect(html.match(/\u2013/g) ?? [], label + " has an en dash").toHaveLength(0);
  expect(
    html.match(/&mdash;|&ndash;|&#8212;|&#8211;/g) ?? [],
    label + " has a dash entity",
  ).toHaveLength(0);
}

describe("renderEmail", () => {
  it("builds the brand shell around whatever it is given", () => {
    const html = renderEmail({
      title: "Test note",
      preview: "A preview line.",
      sections: [{ type: "paragraphs", html: '<p style="margin: 0">Hello.</p>' }],
    });

    expectBrand(html, "a rendered note");
    expect(html).toContain("Hello.");
    expect(html).toContain(FOOTER_REASON);
    expect(html).toContain("{{{RESEND_UNSUBSCRIBE_URL}}}");
    expect(html).toContain("A preview line.");
  });

  it("adds the button, the demo and the headline only when asked", () => {
    const bare = renderEmail({
      title: "Bare",
      preview: "Nothing here.",
      sections: [{ type: "paragraphs", html: "<p>Text.</p>" }],
    });
    expect(bare).not.toContain("border-radius: 999px");
    expect(bare).not.toContain("email-demo.gif");
    expect(bare).not.toContain("font-size: 34px");

    const full = renderEmail({
      title: "Full",
      preview: "Everything.",
      headlineHtml: "Hello <em>there</em>.",
      sections: [
        { type: "paragraphs", html: "<p>Text.</p>" },
        {
          type: "gif",
          src: "https://tracknutri.app/demo/email-demo.gif",
          href: "https://tracknutri.app/try",
          alt: "NutriTrack analysing a meal photo",
        },
        { type: "button", label: "Try it free", href: "https://tracknutri.app/try" },
      ],
    });
    expect(full).toContain("email-demo.gif");
    expect(full).toContain('alt="NutriTrack analysing a meal photo"');
    expect(full).toContain("border-radius: 999px");
    expect(full).toContain("font-size: 34px");
  });
});

describe("the transactional emails", () => {
  it("the invite renders through the layout, brand and all", () => {
    const html = renderInviteHtml(RECIPIENT);
    expectBrand(html, "the invite");
    expectNoDashes(html, "the invite");
    expect(html).toContain("amank.iitg@gmail.com");
  });

  it("the approval note does too", () => {
    const html = renderApprovedHtml(RECIPIENT);
    expectBrand(html, "the approval note");
    expectNoDashes(html, "the approval note");
  });
});

describe("every file in emails/", () => {
  const broadcasts = renderBroadcasts();

  it("renders exactly what renderEmail produces", () => {
    for (const broadcast of broadcasts) {
      const onDisk = read(broadcast.file);
      expect(onDisk, broadcast.file + " is not the renderer's output").toBe(broadcast.html);
    }
  });

  it("carries the brand shell, not a hand-written card", () => {
    for (const broadcast of broadcasts) {
      const onDisk = read(broadcast.file);
      expectBrand(onDisk, broadcast.file);
      expect(onDisk, broadcast.file + " has no footer reason").toContain(FOOTER_REASON);
      expect(onDisk, broadcast.file + " has no unsubscribe token").toContain(
        "{{{RESEND_UNSUBSCRIBE_URL}}}",
      );
      expectNoDashes(onDisk, broadcast.file);
    }
  });

  it("keeps the Black Friday copy, headline and links", () => {
    const html = read("emails/thanksgiving-2026.html");
    expect(html).toContain("Try it free");
    // The headline keeps its green italic, and the body now makes one promise in bold: that the app
    // is open to everyone. The bold is the announcement; the headline is the joke around it.
    expect(html).toContain('Black Friday deal: <em style="color: #195c2e">100% off</em>.');
    expect(html).toContain("<strong>NutriTrack is now open to everyone.</strong>");
    expect(html).toContain("Open to everyone now. No invite, no sign-up to try.");
    // The animated demo, whose first frame is the result screen, so a client that does not
    // animate still shows the numbers. Its own filename, so no cached copy of the older GIF
    // (which opened on the add-meal form) can linger.
    expect(html).toContain("email-demo-result.gif");
    expect(html).not.toContain("email-result-card.png");
    expect(html).not.toContain("email-demo.gif");
    expect(html.match(/utm_campaign=black_friday/g) ?? []).toHaveLength(2);
    expect(html).toContain('alt="NutriTrack analysing a meal photo"');
  });

  it("keeps the Diwali headline and its panel", () => {
    const html = read("emails/diwali-2026.html");
    expect(html).toContain('Happy <em style="color: #195c2e">Diwali</em>.');
    expect(html).toContain("{{{contact.first_name|there}}}");
  });
});

describe("the plain-text parts", () => {
  it("carry no em or en dashes either", () => {
    for (const file of ["emails/diwali-2026.txt", "emails/thanksgiving-2026.txt"]) {
      expectNoDashes(read(file), file);
    }
  });
});
