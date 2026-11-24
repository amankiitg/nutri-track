/**
 * The admin page's one mailing list line, and the button beside it.
 *
 * The numbers come from the database's own state row, not from this tab's memory, so the last run
 * shows up here without a reload inventing anything. The sync itself is the service's: this file
 * only reports what it answered, including the sentence it refused with.
 */
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { parseMealUrl } from "@/lib/capture";

const summaryShape = z.object({
  last_sync_at: z.string().nullable(),
  contacts: z.number(),
  excluded: z.number(),
  unsubscribed: z.number(),
});

export interface MailingListState {
  lastSyncAt: string | null;
  contacts: number;
  excluded: number;
  unsubscribed: number;
}

export async function fetchMailingList(): Promise<MailingListState> {
  const { data, error } = await supabase.rpc("admin_email_sync_summary");
  if (error) throw new Error(error.message);
  const parsed = summaryShape.safeParse(data);
  if (!parsed.success)
    throw new Error("The mailing list figures came back in an unexpected shape.");
  return {
    lastSyncAt: parsed.data.last_sync_at,
    contacts: parsed.data.contacts,
    excluded: parsed.data.excluded,
    unsubscribed: parsed.data.unsubscribed,
  };
}

const syncShape = z.object({
  contacts: z.number(),
  failed: z.number(),
  excluded: z.number(),
  unsubscribed: z.number(),
});

export interface MailingListSyncResult {
  contacts: number;
  failed: number;
  excluded: number;
  unsubscribed: number;
}

export async function syncMailingList(): Promise<MailingListSyncResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token === undefined || token === "") throw new Error("Sign in again to sync the list.");

  const response = await fetch(new URL("contacts/sync", parseMealUrl()).toString(), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? (body as { error?: { message?: unknown } }).error?.message
        : undefined;
    throw new Error(typeof message === "string" ? message : "Could not sync the mailing list.");
  }

  const parsed = syncShape.safeParse(body);
  if (!parsed.success) throw new Error("The sync answered in an unexpected shape.");
  return parsed.data;
}

/**
 * One line, in the order the numbers are useful: when, then who, then who is out.
 *
 * "Never synced" is its own sentence rather than a date of 1970 or a dash, because
 * the useful fact about a list nobody has synced is that nobody has.
 */
export function mailingListSummary(state: MailingListState): string {
  const when =
    state.lastSyncAt === null
      ? "Never synced"
      : "Last synced " +
        new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(
          new Date(state.lastSyncAt),
        );
  return (
    when +
    ". " +
    state.contacts +
    " synced, " +
    state.excluded +
    " excluded, " +
    state.unsubscribed +
    " unsubscribed."
  );
}

/** What a finished run did, for the toast beside the button. */
export function syncResultLine(result: MailingListSyncResult): string {
  const base = `${result.contacts} synced, ${result.excluded} excluded, ${result.unsubscribed} unsubscribed.`;
  return result.failed === 0 ? base : base + " " + result.failed + " refused; see the service log.";
}
