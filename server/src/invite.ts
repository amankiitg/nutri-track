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
import type { CallerStore } from "./caller-store";
import type { GmailDraftClient } from "./gmail";
import { buildApprovedMime, buildInviteMime } from "./invite-message";

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
}

export interface InviteDeps {
  store: Pick<CallerStore, "hasAllowedEmail" | "addAllowedEmail">;
  gmail: GmailDraftClient;
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
    const mime = await buildApprovedMime({ firstName, invitedEmail: email });
    const draftId = await deps.gmail.createDraft(mime);
    return { email, firstName, draftId, alreadyInvited: true };
  }

  const alreadyInvited = await deps.store.hasAllowedEmail(email);
  // The From is the app's verified alias (see `INVITE_FROM`), not the mailbox the draft sits in.
  const mime = await buildInviteMime({ firstName, invitedEmail: email });
  const draftId = await deps.gmail.createDraft(mime);
  await deps.store.addAllowedEmail(email);

  return { email, firstName, draftId, alreadyInvited };
}
