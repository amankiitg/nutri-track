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
import { buildInviteMime } from "./invite-message";

export interface InviteRequest {
  email: string;
  firstName: string;
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
  senderAddress: string;
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

  const alreadyInvited = await deps.store.hasAllowedEmail(email);
  const mime = await buildInviteMime({ firstName, invitedEmail: email }, deps.senderAddress);
  const draftId = await deps.gmail.createDraft(mime);
  await deps.store.addAllowedEmail(email);

  return { email, firstName, draftId, alreadyInvited };
}
