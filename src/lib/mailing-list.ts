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
  checked: z.number(),
  added: z.number(),
  already: z.number(),
  names: z.number(),
  failed: z.number(),
  excluded: z.number(),
  unsubscribed: z.number(),
  first_error: z.string().nullable(),
});

/**
 * The last run, and the list's own totals.
 *
 * Seven numbers, because the one number this replaced could not be read: "0 synced" was said by a
 * run that had nothing to do and by a run that read nothing at all, and there was no way to tell
 * which had happened. Every checked row is in exactly one of added, already, names and failed.
 */
export interface MailingListState {
  lastSyncAt: string | null;
  checked: number;
  added: number;
  already: number;
  names: number;
  failed: number;
  excluded: number;
  unsubscribed: number;
  firstError: string | null;
}

export async function fetchMailingList(): Promise<MailingListState> {
  const { data, error } = await supabase.rpc("admin_email_sync_summary");
  if (error) throw new Error(error.message);
  const parsed = summaryShape.safeParse(data);
  if (!parsed.success)
    throw new Error("The mailing list figures came back in an unexpected shape.");
  return {
    lastSyncAt: parsed.data.last_sync_at,
    checked: parsed.data.checked,
    added: parsed.data.added,
    already: parsed.data.already,
    names: parsed.data.names,
    failed: parsed.data.failed,
    excluded: parsed.data.excluded,
    unsubscribed: parsed.data.unsubscribed,
    firstError: parsed.data.first_error,
  };
}

const syncShape = z.object({
  checked: z.number(),
  added: z.number(),
  alreadyUpToDate: z.number(),
  namesUpdated: z.number(),
  failed: z.number(),
  firstError: z.string().nullable(),
  excluded: z.number(),
  unsubscribed: z.number(),
});

export interface MailingListSyncResult {
  checked: number;
  added: number;
  alreadyUpToDate: number;
  namesUpdated: number;
  failed: number;
  firstError: string | null;
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

/** "1 name" rather than "1 names", since the counts here are usually small and read as words. */
function plural(count: number, one: string, many: string): string {
  return count + " " + (count === 1 ? one : many);
}

/**
 * One sentence, in the order the questions are asked: when, what the run walked, what it found,
 * who is out, and what was refused.
 *
 * "Never synced" is its own sentence rather than a date of 1970 or a dash, because
 * the useful fact about a list nobody has synced is that nobody has. A run that read nothing
 * says so with a count of zero rather than leaving the reader to guess, which is the whole reason
 * "checked" exists.
 */
export function mailingListSummary(state: MailingListState): string {
  if (state.lastSyncAt === null) return "Never synced.";

  const when =
    "Last synced " +
    new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(state.lastSyncAt),
    );

  const run =
    " " +
    state.checked +
    " checked: " +
    state.added +
    " added, " +
    state.already +
    " already up to date, " +
    plural(state.names, "name", "names") +
    " filled in.";

  const list = " " + state.excluded + " excluded, " + state.unsubscribed + " unsubscribed.";

  const refused =
    state.failed === 0
      ? ""
      : " " +
        plural(state.failed, "contact", "contacts") +
        " refused, first: " +
        (state.firstError ?? "the service did not say why");

  return when + "." + run + list + refused;
}

/** What a finished run did, for the toast beside the button. */
export function syncResultLine(result: MailingListSyncResult): string {
  const base =
    result.checked +
    " checked: " +
    result.added +
    " added, " +
    result.alreadyUpToDate +
    " already up to date, " +
    plural(result.namesUpdated, "name", "names") +
    " filled in. " +
    result.excluded +
    " excluded, " +
    result.unsubscribed +
    " unsubscribed.";
  if (result.failed === 0) return base;
  return (
    base +
    " " +
    plural(result.failed, "contact", "contacts") +
    " refused, first: " +
    (result.firstError ?? "the service did not say why") +
    "."
  );
}
