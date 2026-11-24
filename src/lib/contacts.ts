/**
 * The Settings switch, and the one call that follows it.
 *
 * The switch is a preference stored on the profile. That row is the source of truth: the manual
 * sync from the admin page reads it, so a failed call here does not lose the choice. The call to
 * Resend mirrors it, and turning the switch off is the only reason this file talks to the
 * service: there is no call that puts somebody on the list, because the list is built by the sync.
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
