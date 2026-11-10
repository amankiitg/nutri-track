/**
 * Invite someone: draft the email, then add the address.
 *
 * One action, and the order is deliberate. **The draft is created first and the address is added
 * second**, so a failure in either place leaves the invite not granted. The reverse order would
 * grant access and then fail to tell anyone: an address on the list that was never emailed can
 * sign in, and nobody finds out. Fail closed, not open.
 *
 * Retrying is safe. The insert is idempotent, so a second attempt adds no second row; the worst
 * case is a second draft, which is visible in Gmail and harmless.
 */
import type { CallerStore, IssuedTrialLink } from "./caller-store";
import type { GmailDraftClient } from "./gmail";
import { buildApprovedMime, buildInviteMime } from "./invite-message";
import { log } from "./log";

export interface InviteRequest {
  email: string;
  firstName: string;
  /** Which email to draft. `approved` is somebody who asked and is already on the list. */
  kind?: "invite" | "approved";
}

export interface InviteOutcome {
  /** The normalised address that went on the list, which is the one the invite is tied to. */
  email: string;
  firstName: string;
  draftId: string;
  /** True when the address was already on the list, so the caller can say so. */
  alreadyInvited: boolean;
  /** True when the draft carries a personal trial link and the admin page records it as sent. */
  trialLinkSent: boolean;
}

export interface InviteDeps {
  store: Pick<
    CallerStore,
    "hasAllowedEmail" | "addAllowedEmail" | "issueTrialLink" | "markTrialLinkSent"
  >;
  gmail: GmailDraftClient;
  /**
   * Turns an issued link into its URL by signing the token. Null when the trial is not
   * configured on the server, and the email then goes without the trial line.
   */
  signTrialLink: ((issued: IssuedTrialLink) => string) | null;
}

/**
 * The person's trial link for the email, or null.
 *
 * Never a reason to fail the invite: an invite without the trial line is still an invite, and
 * the outcome says the line is missing so the admin page can say so too.
 */
async function trialLinkFor(
  email: string,
  firstName: string,
  deps: InviteDeps,
): Promise<{ url: string; email: string } | null> {
  if (deps.signTrialLink === null) return null;
  try {
    const issued = await deps.store.issueTrialLink(email, firstName === "" ? null : firstName);
    return { url: deps.signTrialLink(issued), email: issued.email };
  } catch {
    log("error", "trial link not issued for an invite", {});
    return null;
  }
}

/** Recorded only once the draft exists, so "Trial link sent" never names an email nobody has. */
async function markSent(trial: { email: string } | null, deps: InviteDeps): Promise<boolean> {
  if (trial === null) return false;
  try {
    await deps.store.markTrialLinkSent(trial.email);
    return true;
  } catch {
    log("error", "trial link not marked as sent", {});
    return false;
  }
}

/**
 * The address as `allowed_emails` stores it.
 *
 * `lower(trim(...))` is not decoration: the table's own trigger and the `is_email_allowed` check
 * both compare on the normalised form, so an invite stored any other way is an invite that looks
 * added and can never match.
 */
function normaliseAddress(email: string): string {
  return email.trim().toLowerCase();
}

export async function invite(request: InviteRequest, deps: InviteDeps): Promise<InviteOutcome> {
  const email = normaliseAddress(request.email);
  const firstName = request.firstName.trim();

  /**
   * The approval: draft only, and no write to the list.
   *
   * The admin approves through `admin_approve_request`, which adds the address and marks the
   * request inside one transaction. Writing the list again here would be a second way to grant
   * access, and the point of having one is that the other cannot disagree with it. Ordering is the
   * reverse of an invite on purpose: the person is already in, so a failed draft takes nothing
   * away and the admin can retry it.
   */
  if (request.kind === "approved") {
    const trial = await trialLinkFor(email, firstName, deps);
    const mime = await buildApprovedMime({
      firstName,
      invitedEmail: email,
      trialUrl: trial?.url ?? null,
    });
    const draftId = await deps.gmail.createDraft(mime);
    const trialLinkSent = await markSent(trial, deps);
    return { email, firstName, draftId, alreadyInvited: true, trialLinkSent };
  }

  const alreadyInvited = await deps.store.hasAllowedEmail(email);
  // The From is the app's verified alias (see `INVITE_FROM`), not the mailbox the draft sits in.
  const trial = await trialLinkFor(email, firstName, deps);
  const mime = await buildInviteMime({
    firstName,
    invitedEmail: email,
    trialUrl: trial?.url ?? null,
  });
  const draftId = await deps.gmail.createDraft(mime);
  await deps.store.addAllowedEmail(email);
  const trialLinkSent = await markSent(trial, deps);

  return { email, firstName, draftId, alreadyInvited, trialLinkSent };
}
