/**
 * The invite as an RFC 5322 message.
 *
 * The content comes from `shared/invite-email.ts`, which is the only copy of the body — the same
 * file the local tool renders `docs/invite-email.html` from. Composed with MailComposer rather
 * than assembled by hand, because the transfer encoding, the line lengths and the boundary
 * bookkeeping are all easy to get subtly wrong, and a body that arrives with `=C3=A9` showing in
 * it is worse than a plain one.
 */
import MailComposer from "nodemailer/lib/mail-composer";
import { inviteMessageFields, type InviteRecipient } from "../../shared/invite-email";

export async function buildInviteMime(
  recipient: InviteRecipient,
  senderAddress: string,
): Promise<Buffer> {
  const composer = new MailComposer(inviteMessageFields(recipient, senderAddress));
  return composer.compile().build();
}
