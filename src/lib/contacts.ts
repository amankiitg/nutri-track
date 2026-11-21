/**
 * The Settings switch, and the two fire-and-forget calls that follow it.
 *
 * The switch is a preference stored on the profile. That row is the source of truth:
 * the nightly sync reads it, so a failed call here does not lose the choice. The
 * Resend calls are mirrors of it, and the one after a profile save is best effort by
 * design, because the thing the person actually did was save a profile.
 */
import { supabase } from "@/integrations/supabase/client";
import { parseMealUrl } from "@/lib/capture";

/**
 * POSTs to the parse-meal service with the session's own token.
 *
 * Returns false rather than throwing when there is no session or the service cannot
 * be reached: every caller here is doing something else as its real job.
 */
async function postContact(path: string): Promise<boolean> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token === undefined || token === "") return false;

  try {
    const response = await fetch(new URL(path, parseMealUrl()).toString(), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * After a profile is saved: put this person on the mailing list.
 *
 * Not awaited anywhere. The service answers ok even when Resend refuses, and a
 * failure on the way is the same as no call: the nightly sync will see the profile.
 */
export async function notifyContactJoin(): Promise<void> {
  await postContact("contacts/join");
}

/**
 * Turns product mail off in Resend after the profile row says so.
 *
 * Called only when the switch goes off. There is deliberately no call for turning it
 * back on: Resend can hold an unsubscribe this app never saw, and the sync never
 * writes `unsubscribed: false`.
 */
export async function unsubscribeContactFromProductMail(): Promise<void> {
  await postContact("contacts/unsubscribe");
}

/**
 * Records the switch on the caller's own profile, then mirrors it to Resend.
 *
 * The database write is the one that can fail visibly: if it does, the switch goes
 * back and the person is told. A failed Resend call is not shown, because the profile
 * is what the next sync reads and it will make the contact right then.
 */
export async function saveProductEmailChoice(userId: string, enabled: boolean): Promise<void> {
  const { error } = await supabase
    .from("profiles")
    .update({ product_emails: enabled })
    .eq("user_id", userId);
  if (error) throw error;
  if (!enabled) await unsubscribeContactFromProductMail();
}
