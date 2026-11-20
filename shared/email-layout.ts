/**
 * The one email layout. Every email in this repo is a call to `renderEmail`.
 *
 * It exists because the same shell was hand-written four times and drifted: the invite, the
 * approval note, the Diwali note and the Black Friday note each carried their own copy of the
 * card, and the copies stopped agreeing on spacing and colours. The values here are copied from
 * the invite email, which is the oldest and the one checked against the app's tokens: cream
 * `#f0ece4` page, card `#fffdf9` on a `#e2ded2` border with a 20px radius, ink `#192217`, quiet
 * ink `#5e6657`, leaf green `#195c2e`, panel `#f4f0e6`, button text `#fbf8f1`, trial note
 * `#2f3a2b`. Nothing here is invented, and nothing here is a new design decision.
 *
 * Why table layout and inline styles: Gmail drops `<style>` blocks and `@media` queries when
 * markup is pasted into its composer. Why no `<link>` to a web font: the stacks name Fraunces
 * and Manrope and fall back to Georgia and Arial, so nothing waits on a request a mail client
 * may refuse.
 *
 * Copy rules live in docs/email-style.md: plain and personal, written as Aman, no em dashes,
 * one button, and a footer that says why the message arrived.
 */

/** Every colour an email may use, copied from the app's tokens via the invite email. */
export const EMAIL_COLOURS = {
  page: "#f0ece4",
  card: "#fffdf9",
  ink: "#192217",
  quietInk: "#5e6657",
  leaf: "#195c2e",
  border: "#e2ded2",
  panel: "#f4f0e6",
  buttonText: "#fbf8f1",
  trialNote: "#2f3a2b",
} as const;

/** The two stacks, as inline CSS values. */
export const EMAIL_FONTS = {
  display: "&quot;Fraunces&quot;, Georgia, &quot;Times New Roman&quot;, serif",
  body: [
    "&quot;Manrope&quot;,",
    "-apple-system,",
    "BlinkMacSystemFont,",
    "&quot;Segoe UI&quot;,",
    "Roboto,",
    "Helvetica,",
    "Arial,",
    "sans-serif",
  ].join("\n                          "),
} as const;

const PREHEADER_PADDING =
  "&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;";

/** The sentence every broadcast carries above the unsubscribe link. */
export const FOOTER_REASON =
  "You&apos;re getting this because you joined NutriTrack or were invited to it.";

const UNSUBSCRIBE = `<a
                        href="{{{RESEND_UNSUBSCRIBE_URL}}}"
                        style="color: #195c2e; text-decoration: underline"
                        >Unsubscribe</a
                      >`;

export type EmailSection =
  /** Body paragraphs in the 16px block. `paddingTop` is 24 by default; the invite uses 26 for
   *  the block after its button, and keeping that number is why the knob exists. */
  | { type: "paragraphs"; html: string; paddingTop?: number }
  /** The quiet aside: `#f4f0e6` panel, 15px, quiet ink. */
  | { type: "panel"; html: string }
  /** The demo GIF, linked. Remote, because it is served from the Worker. */
  | { type: "gif"; src: string; href: string; alt: string; width?: number }
  /** One filled button. `noteHtml` is the 12px line directly under it; `subNoteHtml` is the 14px
   *  offer line below that, which the invite and the approval note both carry. */
  | { type: "button"; label: string; href: string; noteHtml?: string; subNoteHtml?: string }
  /** A sign-off: one or more lines, the last being the name. */
  | { type: "signoff"; lines: string[]; paddingTop?: number }
  /** Anything the shapes above cannot express, emitted as its own row verbatim. */
  | { type: "custom"; html: string };

export interface RenderEmailInput {
  /** The inbox title, usually the subject. */
  title: string;
  /** The hidden preview line. */
  preview: string;
  /** Optional note in the head, for the generated-file warning. */
  comment?: string;
  /** The one big line under the logo: 34px Fraunces, one phrase in leaf green. Optional, because
   *  a short note from Aman often has none and a headline is a decision rather than a default. */
  headlineHtml?: string;
  sections: EmailSection[];
  /** What the footer says above the unsubscribe link. Defaults to FOOTER_REASON. */
  footerNoteHtml?: string;
  /** Replaces the whole footer content, for a message that is not a broadcast and carries no
   *  unsubscribe token (the invite links to the site there instead). */
  footerHtml?: string;
}

function paragraphBlock(section: Extract<EmailSection, { type: "paragraphs" }>): string {
  const paddingTop = section.paddingTop ?? 24;
  return `<tr>
              <td
                style="
                  padding: ${paddingTop}px 40px 0 40px;
                  font-family:
                    ${EMAIL_FONTS.body};
                  font-size: 16px;
                  line-height: 1.6;
                  color: ${EMAIL_COLOURS.ink};
                "
              >
                ${section.html}
              </td>
            </tr>`;
}

function panelBlock(html: string): string {
  return `<tr>
              <td style="padding: 24px 40px 0 40px">
                <table
                  role="presentation"
                  border="0"
                  cellpadding="0"
                  cellspacing="0"
                  width="100%"
                  style="background-color: ${EMAIL_COLOURS.panel}; border: 1px solid ${EMAIL_COLOURS.border}; border-radius: 14px"
                >
                  <tr>
                    <td
                      style="
                        padding: 16px 18px;
                        font-family:
                          ${EMAIL_FONTS.body};
                        font-size: 15px;
                        line-height: 1.55;
                        color: ${EMAIL_COLOURS.quietInk};
                      "
                    >
                      ${html}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`;
}

function gifBlock(section: Extract<EmailSection, { type: "gif" }>): string {
  const width = section.width ?? 480;
  return `<tr>
              <td style="padding: 24px 40px 0 40px">
                <a href="${section.href}" style="text-decoration: none">
                  <img
                    src="${section.src}"
                    width="${width}"
                    alt="${section.alt}"
                    style="display: block; width: 100%; max-width: ${width}px; height: auto; border: 0"
                  />
                </a>
              </td>
            </tr>`;
}

function buttonBlock(section: Extract<EmailSection, { type: "button" }>): string {
  const note =
    section.noteHtml === undefined
      ? ""
      : `\n                <p
                  style="
                    margin: 12px 0 0 0;
                    font-family:
                      ${EMAIL_FONTS.body};
                    font-size: 12px;
                    line-height: 1.5;
                    color: ${EMAIL_COLOURS.quietInk};
                  "
                >
                  ${section.noteHtml}
                </p>`;
  const subNote =
    section.subNoteHtml === undefined
      ? ""
      : `\n                <p
                  style="
                    margin: 14px 0 0 0;
                    font-family:
                      ${EMAIL_FONTS.body};
                    font-size: 14px;
                    line-height: 1.5;
                    color: ${EMAIL_COLOURS.trialNote};
                  "
                >
                  ${section.subNoteHtml}
                </p>`;
  return `<tr>
              <td align="center" style="padding: 28px 40px 0 40px">
                <table role="presentation" border="0" cellpadding="0" cellspacing="0">
                  <tr>
                    <td
                      align="center"
                      bgcolor="${EMAIL_COLOURS.leaf}"
                      style="background-color: ${EMAIL_COLOURS.leaf}; border-radius: 999px"
                    >
                      <a
                        href="${section.href}"
                        style="
                          display: inline-block;
                          padding: 16px 34px;
                          font-family:
                            ${EMAIL_FONTS.body};
                          font-size: 16px;
                          font-weight: 700;
                          color: ${EMAIL_COLOURS.buttonText};
                          text-decoration: none;
                          border-radius: 999px;
                        "
                        >${section.label}</a
                      >
                    </td>
                  </tr>
                </table>${note}${subNote}
              </td>
            </tr>`;
}

function signOffBlock(section: Extract<EmailSection, { type: "signoff" }>): string {
  const paddingTop = section.paddingTop ?? 24;
  const paras = section.lines
    .map((line, index) => {
      const margin = index === section.lines.length - 1 ? "0" : "0 0 4px 0";
      return `<p style="margin: ${margin}">${line}</p>`;
    })
    .join("\n\n                ");
  return `<tr>
              <td
                style="
                  padding: ${paddingTop}px 40px 0 40px;
                  font-family:
                    ${EMAIL_FONTS.body};
                  font-size: 16px;
                  line-height: 1.6;
                  color: ${EMAIL_COLOURS.ink};
                "
              >
                ${paras}
              </td>
            </tr>`;
}

function sectionBlock(section: EmailSection): string {
  if (section.type === "paragraphs") return paragraphBlock(section);
  if (section.type === "panel") return panelBlock(section.html);
  if (section.type === "gif") return gifBlock(section);
  if (section.type === "button") return buttonBlock(section);
  if (section.type === "signoff") return signOffBlock(section);
  return section.html;
}

function footerBlock(content: string): string {
  return `<tr>
              <td style="padding: 28px 40px 40px 40px">
                <table
                  role="presentation"
                  border="0"
                  cellpadding="0"
                  cellspacing="0"
                  width="100%"
                  style="border-top: 1px solid ${EMAIL_COLOURS.border}"
                >
                  <tr>
                    <td
                      style="
                        padding-top: 18px;
                        font-family:
                          ${EMAIL_FONTS.body};
                        font-size: 12px;
                        line-height: 1.6;
                        color: ${EMAIL_COLOURS.quietInk};
                      "
                    >
                      ${content}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`;
}

export function renderEmail({
  title,
  preview,
  comment,
  headlineHtml,
  sections,
  footerNoteHtml,
  footerHtml,
}: RenderEmailInput): string {
  const rows = sections.map(sectionBlock).join("\n\n            ");
  const headComment = comment === undefined ? "" : `\n    <!--\n      ${comment}\n    -->`;
  const headline =
    headlineHtml === undefined
      ? ""
      : `

                <!-- Headline -->
                <p
                  style="
                    margin: 28px 0 0 0;
                    font-family: ${EMAIL_FONTS.display};
                    font-size: 34px;
                    line-height: 1.05;
                    font-weight: 700;
                    letter-spacing: -0.02em;
                    color: ${EMAIL_COLOURS.ink};
                  "
                >
                  ${headlineHtml}
                </p>`;
  const footerContent =
    footerHtml ?? `${footerNoteHtml ?? FOOTER_REASON}<br />\n                      ${UNSUBSCRIBE}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light only" />
    <meta name="supported-color-schemes" content="light only" />
    <title>${title}</title>${headComment}
  </head>
  <body style="margin: 0; padding: 0; background-color: ${EMAIL_COLOURS.page}">
    <!-- Preheader: shown in the inbox next to the subject, hidden in the body. -->
    <div
      style="
        display: none;
        max-height: 0;
        max-width: 0;
        overflow: hidden;
        opacity: 0;
        font-size: 1px;
        line-height: 1px;
        color: ${EMAIL_COLOURS.page};
      "
    >
      ${preview}
      ${PREHEADER_PADDING}
    </div>

    <table
      role="presentation"
      border="0"
      cellpadding="0"
      cellspacing="0"
      width="100%"
      style="background-color: ${EMAIL_COLOURS.page}"
    >
      <tr>
        <td align="center" style="padding: 32px 16px">
          <table
            role="presentation"
            border="0"
            cellpadding="0"
            cellspacing="0"
            style="
              width: 100%;
              max-width: 600px;
              background-color: ${EMAIL_COLOURS.card};
              border: 1px solid ${EMAIL_COLOURS.border};
              border-radius: 20px;
            "
          >
            <tr>
              <td style="padding: 40px 40px 8px 40px">
                <!-- Brand row -->
                <table role="presentation" border="0" cellpadding="0" cellspacing="0">
                  <tr>
                    <td width="40" valign="middle">
                      <img
                        src="https://tracknutri.app/icons/icon-192.png"
                        width="40"
                        height="40"
                        alt="NutriTrack"
                        style="display: block; width: 40px; height: 40px; border-radius: 10px"
                      />
                    </td>
                    <td valign="middle" style="padding-left: 12px">
                      <span
                        style="
                          font-family: ${EMAIL_FONTS.display};
                          font-size: 19px;
                          font-weight: 700;
                          letter-spacing: -0.01em;
                          color: ${EMAIL_COLOURS.ink};
                        "
                        >NutriTrack</span
                      >
                    </td>
                  </tr>
                </table>${headline}
              </td>
            </tr>

            ${rows}

            ${footerBlock(footerContent)}
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;
}
