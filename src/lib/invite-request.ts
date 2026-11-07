/**
 * The invite request sent from the create-account screen's refusal panel.
 *
 * A mailto, not a write. That screen is reached from the sign-up form, where nobody is signed in:
 * the row `recordInviteRequest` writes takes its address from the caller's token, and there is no
 * token yet. So the request leaves as mail, from the person's own mailbox, to the one address
 * below, and the app records nothing.
 */

/**
 * Where a request goes.
 *
 * **This mailbox has to exist.** Nothing in the app can check that it does, so this constant is
 * the single place to change if the address ever moves, and the one value a deployment has to get
 * right for the button to be worth pressing.
 */
export const INVITE_REQUEST_ADDRESS = "invites@tracknutri.app";

/** The subject line, which is what the mailbox is searched by. */
const SUBJECT = "NutriTrack invite request";

/**
 * What the person's mail app opens with: addressed, subject filled in, and already asking.
 *
 * The address they typed goes in the body rather than in the recipient, because the recipient is
 * the product. Both parts are percent-encoded: a `+` in an address is a legal character and a
 * leading space is a message that arrives mangled.
 */
export function inviteRequestMailto(email: string): string {
  const typed = email.trim();
  const body = typed === "" ? "Please send me an invite to NutriTrack." : `Please invite ${typed}`;
  return `mailto:${INVITE_REQUEST_ADDRESS}?subject=${encodeURIComponent(SUBJECT)}&body=${encodeURIComponent(body)}`;
}
