/**
 * The invite, as the single source.
 *
 * Two things read it: the local tool in `tools/invite`, which renders `docs/invite-email.html`
 * with `npm run preview`, and the parse-meal service, which builds the draft the admin page asks
 * for. One copy on purpose: two copies of an email drift, and the copy that drifts is the one you
 * send.
 *
 * It lives in `shared/` because both the service and the tool import it, and it stays free of
 * browser and Node APIs for the same reason `shared/meal-parse.ts` does.
 *
 * The HTML is table layout with every style inline because Gmail discards `<style>` blocks and
 * `@media` queries when markup is pasted into its composer. The palette is the app's own,
 * converted from the oklch tokens in `src/styles.css` to hex, because no mail client
 * understands oklch: cream `#f0ece4`, card `#fffdf9`, ink `#192217`, quiet ink `#5e6657`, leaf
 * green `#195c2e`, border `#e2ded2`. `--secondary` (pale green) and `--accent` (apricot) are
 * deliberately unused: the pale green belonged to a row of feature chips that read as a
 * product page rather than a note from a friend.
 */

import { renderEmail } from "./email-layout";

export const SENDER_NAME = "Aman";

/**
 * Matches the email's opening, because a subject that describes the app would undo the first
 * sentence of the body. Easy to change in the draft before sending.
 */
export const SUBJECT = "What a month of tracking my food changed";

export interface InviteRecipient {
  /** Their first name, for the greeting. */
  firstName: string;
  /** The address on `allowed_emails`. This is the one the invite is tied to. */
  invitedEmail: string;
}

/**
 * The trial offer, under the button, and where it goes.
 *
 * One plain link for everybody. It used to be this person's own `/t/<token>`, signed by the
 * service when the draft was made, and the line was left out entirely when the server had no
 * signing key — so whether an invite offered a trial depended on configuration. `/try` needs no
 * token, so both emails always carry the same sentence and the same link, and the older `/t/`
 * links already in inboxes keep opening because that route is still live.
 */
export const TRIAL_URL = "https://tracknutri.app/try";

/** The sentence itself: linked in the HTML part, written out under the URL in the text part. */
export const TRIAL_LINE = "Not ready to sign up? Try a few meals first";

function trialLineText(): string {
  return `\n${TRIAL_LINE}:\n${TRIAL_URL}\n`;
}

/**
 * What `npm run preview` renders into the committed file, so it stays generic.
 *
 * These are the only two placeholders: whoever uses the preview by hand fills them in. The
 * tool substitutes real values and never writes this file.
 */
export const PREVIEW: InviteRecipient = {
  firstName: "{{First name}}",
  invitedEmail: "{{invited email}}",
};

/**
 * The From header the service composes invites with.
 *
 * A verified Send-as alias on the Gmail account rather than the account's own address: the draft is
 * created in one mailbox and sent as the app, so the reader sees NutriTrack and not somebody's
 * personal address. Gmail only honours a From it recognises, and an unverified alias is silently
 * rewritten to the account address, which is why this is stated here rather than derived from
 * configuration: the alias existing in the account's Send-as list is the premise it rests on.
 *
 * The mailbox the draft lands in is still `INVITE_SENDER_ADDRESS`, and it may be a different
 * address: where a draft lives and who it is from are two separate things to Gmail.
 */
export const INVITE_FROM = { name: "NutriTrack", address: "invites@tracknutri.app" } as const;

/**
 * Escaping for the two values a person controls: the name they typed and the address they typed.
 *
 * Both end up inside an HTML body, and an address is a string anybody can make up. Without this, a
 * name of `<script>` or a stray `<` in an address is markup in somebody's inbox, and a `&` in an
 * address is an entity waiting to be interpreted. The five replacements are the whole of what a text
 * node needs.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A value for a header or a link: no line breaks, and no quotes that could close the name.
 *
 * A header is line-based, so a name containing a newline is how a second header gets added. The
 * quotes matter for the same reason one line later: `"Name" <address>` is the format, and a quote in
 * the name ends the field early.
 */
function headerText(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/"/g, "")
    .trim();
}

/**
 * The message fields both transports hand to their composer.
 *
 * The content is assembled here so that the local tool and the service cannot disagree about
 * what an invite says: they differ only in how they post it, IMAP append versus the Gmail API.
 */
export function inviteMessageFields(recipient: InviteRecipient): {
  from: { name: string; address: string };
  to: { name: string; address: string };
  subject: string;
  text: string;
  html: string;
} {
  return {
    from: { ...INVITE_FROM },
    to: { name: headerText(recipient.firstName), address: headerText(recipient.invitedEmail) },
    subject: SUBJECT,
    text: renderInviteText(recipient),
    html: renderInviteHtml(recipient),
  };
}

/** The HTML part. `multipart/alternative` carries this alongside the plain text below. */
export function renderInviteHtml({ firstName, invitedEmail }: InviteRecipient): string {
  return renderEmail({
    title: "You're invited to NutriTrack",
    preview:
      "A month of tracking my food, and what changed. Your invite is tied to the address this\n      landed in.",
    comment:
      'Generated by tools/invite. Do not edit by hand: edit shared/invite-email.ts and run "npm run invite:preview" from the repo root.',
    headlineHtml: `A month in, here&apos;s <em style="color: #195c2e">what changed</em>.`,
    sections: [
      {
        type: "paragraphs",
        html: `<p style="margin: 0 0 16px 0">Hi ${escapeHtml(firstName)},</p>

                <p style="margin: 0 0 16px 0">
                  I've been tracking what I eat for over a month now, and it has quietly changed how
                  I eat.
                </p>

                <p style="margin: 0 0 16px 0">
                  I'm steadily closing in on my target weight. My protein is up, the evening grazing
                  is mostly gone, and I feel noticeably better. Even moving around feels easier.
                </p>

                <p style="margin: 0">
                  I built NutriTrack to do the tracking. You photograph your plate, it reads what's
                  on it, you fix what it got wrong, and it tells you one thing: whether you're on
                  pace. Saying or typing a meal works too, if a photo is awkward.
                </p>`,
      },
      {
        type: "panel",
        html: `Your invite is tied to
                      <strong style="color: #192217">${escapeHtml(invitedEmail)}</strong>. Sign in with Google
                      using that address, or create an account with it.`,
      },
      {
        type: "button",
        label: "Open NutriTrack",
        href: "https://tracknutri.app",
        noteHtml: `or paste this in: <span style="color: #195c2e">tracknutri.app</span>`,
        subNoteHtml: `<a href="${TRIAL_URL}" style="color: #195c2e; text-decoration: underline"
                    >${TRIAL_LINE}</a
                  >`,
      },
      {
        type: "paragraphs",
        paddingTop: 26,
        html: `<p style="margin: 0 0 16px 0">
                  One honest thing: the numbers come from a photo, so they're estimates, and
                  portions of calorie-dense foods are the roughest part. A bowl of hummus can be out
                  by more than you'd guess. Nothing saves until you've checked it, which is what
                  that screen is for.
                </p>

                <p style="margin: 0">
                  On an iPhone, add it to your home screen and it behaves like an app. That part is
                  Safari only: open tracknutri.app in Safari, tap Share, then Add to Home Screen.
                  And if something breaks or reads wrong, reply to this. I want to know.
                </p>`,
      },
      { type: "signoff", lines: [SENDER_NAME] },
    ],
    footerHtml: `<a
                        href="https://tracknutri.app"
                        style="color: #195c2e; text-decoration: underline"
                        >tracknutri.app</a
                      >`,
  });
}

/**
 * The plain-text part.
 *
 * Not derived from the HTML: stripping tags produces a worse read than writing it out, and the
 * instruction about which address to sign in with has to survive the fallback, because that is
 * the part people get wrong. Kept beside the HTML so both are edited together.
 */
export function renderInviteText({ firstName, invitedEmail }: InviteRecipient): string {
  return `Hi ${firstName},

I've been tracking what I eat for over a month now, and it has quietly changed how I eat.

I'm steadily closing in on my target weight. My protein is up, the evening grazing
is mostly gone, and I feel noticeably better. Even moving around feels easier.

I built NutriTrack to do the tracking. You photograph your plate, it reads what's on it, you
fix what it got wrong, and it tells you one thing: whether you're on pace. Saying or typing a
meal works too, if a photo is awkward.

Your invite is tied to ${invitedEmail}. Sign in with Google using that address, or create an
account with it.

https://tracknutri.app
${trialLineText()}
One honest thing: the numbers come from a photo, so they're estimates, and portions of
calorie-dense foods are the roughest part. A bowl of hummus can be out by more than you'd
guess. Nothing saves until you've checked it, which is what that screen is for.

On an iPhone, add it to your home screen and it behaves like an app. That part is Safari only:
open tracknutri.app in Safari, tap Share, then Add to Home Screen. And if something breaks or
reads wrong, reply to this. I want to know.

${SENDER_NAME}
`;
}

/* -------------------------------------------------------------------------- */
/* The approval: what somebody gets when the admin lets them in.               */
/* -------------------------------------------------------------------------- */

/**
 * The subject of the approval. Unlike the invite's, this one says what it is: by the time it lands
 * the person has already asked, and "you're in" is the whole message.
 */
export const APPROVED_SUBJECT = "You're in: welcome to NutriTrack";

/**
 * The greeting, which is the one place this email can be personal without a human writing it.
 *
 * A blank name is common (the Google path only has one if the profile does), so it becomes "there"
 * rather than an empty space before the comma.
 */
function approvedGreeting(firstName: string): string {
  const name = firstName.trim();
  return name === "" ? "there" : name;
}

/** The message fields for the approval, in the same shape as the invite's. */
export function approvedMessageFields(recipient: InviteRecipient): {
  from: { name: string; address: string };
  to: { name: string; address: string };
  subject: string;
  text: string;
  html: string;
} {
  return {
    from: { ...INVITE_FROM },
    to: { name: headerText(recipient.firstName), address: headerText(recipient.invitedEmail) },
    subject: APPROVED_SUBJECT,
    text: renderApprovedText(recipient),
    html: renderApprovedHtml(recipient),
  };
}

/**
 * The HTML part of the approval.
 *
 * The same frame as the invite: cream page, 600px card, the brand row, Fraunces headline, Manrope
 * body, the leaf-green pill, and the rule above the close. Kept as its own template rather than
 * bolted onto the invite's three-branch function, because the two say different things and a shared
 * function with a flag in it is how the wrong variant gets sent. **The frame is duplicated on
 * purpose; if the look changes, it changes here too.**
 */
export function renderApprovedHtml({ firstName, invitedEmail }: InviteRecipient): string {
  /**
   * Where the button goes: the sign-in page, carrying the address.
   *
   * The address makes the page continue by itself, so the person lands on the form their account
   * needs rather than on an empty field they have to retype. Percent-encoded because an address is
   * not a URL: a `+` in a tag is a space to a query parser, and an `&` would start a new parameter.
   */
  const signInUrl = `https://tracknutri.app/auth?email=${encodeURIComponent(invitedEmail)}`;
  return renderEmail({
    title: "You're in: welcome to NutriTrack",
    preview: `Your invite is approved. Sign in at tracknutri.app with ${escapeHtml(invitedEmail)}.`,
    headlineHtml: `You're <em style="color: #195c2e">in</em>.`,
    sections: [
      {
        type: "paragraphs",
        html: `<p style="margin: 0 0 16px 0">Hi ${escapeHtml(approvedGreeting(firstName))},</p>

                <p style="margin: 0 0 16px 0">
                  Thanks for asking to join NutriTrack. You're in.
                </p>

                <p style="margin: 0">
                  Sign in with ${escapeHtml(invitedEmail)}: use Continue with Google if it's a Google
                  account, or set a password when you sign in.
                </p>`,
      },
      {
        type: "button",
        label: "Open NutriTrack",
        href: signInUrl,
        noteHtml: `or paste this in: <span style="color: #195c2e">tracknutri.app</span>`,
        subNoteHtml: `<a href="${TRIAL_URL}" style="color: #195c2e; text-decoration: underline"
                    >${TRIAL_LINE}</a
                  >`,
      },
      {
        type: "paragraphs",
        paddingTop: 26,
        html: `<p style="margin: 0 0 16px 0">
                  One honest thing: the numbers come from a photo, so they're estimates, and
                  portions of calorie-dense foods are the roughest part. A bowl of hummus can be out
                  by more than you'd guess. Nothing saves until you've checked it, which is what
                  that screen is for.
                </p>

                <p style="margin: 0">
                  On an iPhone, add it to your home screen and it behaves like an app. That part is
                  Safari only: open tracknutri.app in Safari, tap Share, then Add to Home Screen.
                  And if something breaks or reads wrong, reply to this. I want to know.
                </p>`,
      },
      { type: "signoff", lines: [SENDER_NAME] },
    ],
    footerHtml: `<a
                        href="https://tracknutri.app"
                        style="color: #195c2e; text-decoration: underline"
                        >tracknutri.app</a
                      >`,
  });
}

export function renderApprovedText({ firstName, invitedEmail }: InviteRecipient): string {
  // The same link as the button above, built the same way. A plain-text reader gets one too: a
  // message whose only link exists in the part the reader cannot render is a message with no link.
  const signInUrl = `https://tracknutri.app/auth?email=${encodeURIComponent(invitedEmail)}`;
  return `Hi ${approvedGreeting(firstName)},

Thanks for asking to join NutriTrack. You're in.

Sign in with ${invitedEmail}: use Continue with Google if it's a Google account, or set a
password when you sign in.

${signInUrl}
${trialLineText()}
One honest thing: the numbers come from a photo, so they're estimates, and portions of
calorie-dense foods are the roughest part. A bowl of hummus can be out by more than you'd
guess. Nothing saves until you've checked it, which is what that screen is for.

On an iPhone, add it to your home screen and it behaves like an app. That part is Safari only:
open tracknutri.app in Safari, tap Share, then Add to Home Screen. And if something breaks or
reads wrong, reply to this. I want to know.

${SENDER_NAME}
`;
}
