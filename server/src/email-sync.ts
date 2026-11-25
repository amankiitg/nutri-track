/**
 * Keeping the Resend audience in step with who can use NutriTrack.
 *
 * Two halves, and they are separate on purpose:
 *
 *   - `canonicalEmail` and `dedupeByCanonical` are pure. The database already dedupes
 *     by public.email_canonical() and pages in canonical order, so the pass here is
 *     defensive: a page boundary, a replica, or a future reader that forgets the rule
 *     must not turn one Gmail inbox into three contacts. The SQL function is the
 *     authority; this is the same rule and the tests for the two are next to each
 *     other so a change to one is visible against the other.
 *   - `syncAudience` walks the pages and upserts one contact at a time. A single
 *     refused contact is logged and counted, not thrown: one malformed address can
 *     be fixed by hand, while a run that stops on it leaves the list half synced and
 *     says nothing about which half.
 *
 * Nothing here reads rows as any user. The store calls a secret-gated function with
 * the server's own secret, and the only thing that leaves is a contact's address,
 * first name and preference. No meal, weight, target or photo is in this path, and
 * the service-role key is not available to it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ApiError } from "./errors";
import { log as writeLog, type LogFields } from "./log";
import type { ContactInput, ResendContactsClient } from "./resend-contacts";

/** The service's sentence when the database read fails. */
export const EMAIL_SYNC_FAILURE_MESSAGE = "Could not read the mailing list. Try again.";

/**
 * Rows per request. PostgREST returns at most 1000, and the function caps there
 * too; 500 keeps a response comfortable on a small instance.
 */
export const EMAIL_SYNC_PAGE_SIZE = 500;

/**
 * A ceiling on the loop, not an estimate of the list. One hundred pages is fifty
 * thousand contacts, which is two orders of magnitude past this app; the bound is
 * here so a function that kept answering full pages could not spin forever.
 * Chosen, not measured.
 */
const MAX_PAGES = 100;

export interface EmailSyncRow {
  email: string;
  canonical: string;
  firstName: string | null;
  productEmails: boolean;
}

export interface EmailSyncCounts {
  eligible: number;
  excluded: number;
  unsubscribed: number;
}

/**
 * What one run did, in numbers that can tell three cases apart.
 *
 * The single "contacts" counter this replaces could not: a run that found everything already in
 * step and a run that read no rows both reported zero, and on 25 Nov the card said 0 synced next to
 * roughly fifty contacts that were already in Resend.
 *
 * Every checked row lands in exactly one of added, alreadyUpToDate, namesUpdated or failed.
 */
export interface EmailSyncResult {
  /** Rows the run walked. Zero here means the list itself was empty, which is a bug, not an idle run. */
  checked: number;
  /** Contacts Resend did not have before this run. */
  added: number;
  /**
   * Contacts in step at the end of the run with nothing left to write, which counts both a contact
   * that was already in step and one this run had to turn off: by the time the run ends there is no
   * difference between them, and neither is work a reader needs to see.
   */
  alreadyUpToDate: number;
  /** Contacts whose first name this run filled in. */
  namesUpdated: number;
  /** Contacts Resend refused, plus the first refusal's sentence for the card. */
  failed: number;
  firstError: string | null;
  /** Totals over the list, not over the run. */
  excluded: number;
  unsubscribed: number;
}

/**
 * The same rule as public.email_canonical(): lowercase and trim, fold the Gmail
 * domain, and on Gmail drop dots and everything from the first plus. Other domains
 * keep their local part exactly as typed, because a dot there is the person's.
 */
export function canonicalEmail(email: string): string {
  const full = email.trim().toLowerCase();
  const at = full.lastIndexOf("@");
  if (at === -1) return full;

  const local = full.slice(0, at);
  const domain = full.slice(at + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    const withoutTag = local.split("+")[0] ?? "";
    return withoutTag.replace(/\./g, "") + "@gmail.com";
  }
  return full;
}

/**
 * One row per inbox, keeping the first. Input order is the database's canonical
 * order, so the first is also the deterministic choice.
 */
export function dedupeByCanonical(rows: readonly EmailSyncRow[]): EmailSyncRow[] {
  const seen = new Set<string>();
  const kept: EmailSyncRow[] = [];
  for (const row of rows) {
    const canonical = canonicalEmail(row.canonical === "" ? row.email : row.canonical);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    kept.push(row.canonical === canonical ? row : { ...row, canonical });
  }
  return kept;
}

const pageRow = z.object({
  email: z.string(),
  canonical: z.string(),
  first_name: z.string().nullable(),
  product_emails: z.boolean(),
});

const countsShape = z.object({
  eligible: z.number().int(),
  excluded: z.number().int(),
  unsubscribed: z.number().int(),
});

export interface EmailSyncStore {
  page(after: string | null, limit: number): Promise<EmailSyncRow[]>;
  counts(): Promise<EmailSyncCounts>;
  record(state: {
    checked: number;
    added: number;
    already: number;
    names: number;
    failed: number;
    excluded: number;
    unsubscribed: number;
    firstError: string | null;
  }): Promise<void>;
}

/**
 * The store over PostgREST, as anon, with the secret the functions compare against
 * Vault. The secret may be absent, and then every call is refused by the database
 * rather than running ungated; the routes check for it first so a missing secret is
 * a sentence rather than an upstream error.
 */
export function createEmailSyncStore(
  client: SupabaseClient,
  serverSecret: string | undefined,
): EmailSyncStore {
  function fail(operation: string): never {
    // The operation is enough for the log. No address, no secret, no row.
    writeLog("error", "email sync store call failed", { operation });
    throw new ApiError(502, "upstream_error", EMAIL_SYNC_FAILURE_MESSAGE);
  }

  return {
    async page(after, limit) {
      const { data, error } = await client.rpc("email_sync_page", {
        p_secret: serverSecret,
        p_after: after,
        p_limit: limit,
      });
      if (error) fail("email_sync_page");

      const parsed = z.array(pageRow).safeParse(data ?? []);
      if (!parsed.success) fail("email_sync_page shape");
      return parsed.data.map((row) => ({
        email: row.email,
        canonical: row.canonical,
        firstName: row.first_name,
        productEmails: row.product_emails,
      }));
    },

    async counts() {
      const { data, error } = await client.rpc("email_sync_counts", {
        p_secret: serverSecret,
      });
      if (error) fail("email_sync_counts");

      const parsed = countsShape.safeParse(data);
      if (!parsed.success) fail("email_sync_counts shape");
      return parsed.data;
    },

    async record(state) {
      const { error } = await client.rpc("email_sync_record", {
        p_secret: serverSecret,
        p_checked: state.checked,
        p_added: state.added,
        p_already: state.already,
        p_names: state.names,
        p_failed: state.failed,
        p_excluded: state.excluded,
        p_unsubscribed: state.unsubscribed,
        p_first_error: state.firstError,
      });
      if (error) fail("email_sync_record");
    },
  };
}

export type EmailSyncLog = (
  level: "info" | "warn" | "error",
  message: string,
  fields?: LogFields,
) => void;

export interface SyncAudienceDeps {
  store: EmailSyncStore;
  contacts: ResendContactsClient;
  log?: EmailSyncLog;
  /** A test seam; production uses the module's page size. */
  pageSize?: number;
}

/**
 * One full sync. Neither the addresses nor the count of a person's data is logged:
 * the run logs totals only.
 */
export async function syncAudience(deps: SyncAudienceDeps): Promise<EmailSyncResult> {
  const log: EmailSyncLog = deps.log ?? writeLog;
  const pageSize = deps.pageSize ?? EMAIL_SYNC_PAGE_SIZE;

  const counts = await deps.store.counts();

  let after: string | null = null;
  let checked = 0;
  let added = 0;
  let already = 0;
  let names = 0;
  let failed = 0;
  let firstError: string | null = null;
  let pages = 0;
  const seen = new Set<string>();

  for (; pages < MAX_PAGES; pages += 1) {
    const raw = await deps.store.page(after, pageSize);
    if (raw.length === 0) break;

    for (const row of dedupeByCanonical(raw)) {
      if (seen.has(row.canonical)) continue;
      seen.add(row.canonical);

      const contact: ContactInput = {
        email: row.email,
        firstName: row.firstName,
        productEmails: row.productEmails,
      };
      checked += 1;
      try {
        // The outcome is what makes these counters mean anything: "created" is a
        // contact this run added, "unchanged" is one that was already in step, and
        // the difference between them is the whole question the old single number
        // could not answer.
        const outcome = await deps.contacts.upsert(contact);
        if (outcome === "created") added += 1;
        else if (outcome === "named") names += 1;
        else already += 1;
      } catch (error) {
        // The address is not logged, and neither is the error's own body. One
        // failure is a contact to look at by hand; it is not a reason to abandon
        // the rest of the list, but the first sentence is kept for the card so the
        // refusal can be read without opening the Render log.
        failed += 1;
        if (firstError === null) {
          firstError = error instanceof Error ? error.message : "contact upsert failed";
        }
        log("warn", "contact upsert failed", {});
      }
    }

    const last = raw[raw.length - 1];
    if (last === undefined || last.canonical === after) break;
    after = last.canonical;
    if (raw.length < pageSize) break;
  }

  // The state row is an observation. Failing to write it must not fail a run that
  // already updated the audience, so this is the one call whose error is swallowed.
  try {
    await deps.store.record({
      checked,
      added,
      already,
      names,
      failed,
      excluded: counts.excluded,
      unsubscribed: counts.unsubscribed,
      firstError,
    });
  } catch {
    log("warn", "mailing list state not recorded", {});
  }

  // The 25 Nov run recorded 0 accepted with 5 excluded and no failure count at all, and nothing in
  // the log said which of the two histories it had been. A run that walked rows and refused every
  // one of them now says so at the level a dashboard shows.
  if (checked > 0 && added + already + names === 0) {
    log("error", "mailing list sync refused every contact", { checked, failed });
  }

  log("info", "mailing list synced", { checked, added, already, names, failed });

  return {
    checked,
    added,
    alreadyUpToDate: already,
    namesUpdated: names,
    failed,
    firstError,
    excluded: counts.excluded,
    unsubscribed: counts.unsubscribed,
  };
}

/**
 * One person, outside a full run: after an invite, or after a profile is saved.
 *
 * It returns nothing and throws nothing of its own. The callers are a request whose
 * job is something else, so the only correct behaviour on a failure is a log line.
 */
export async function upsertOneContact(
  contacts: ResendContactsClient,
  contact: ContactInput,
  log: EmailSyncLog = writeLog,
): Promise<boolean> {
  try {
    await contacts.upsert(contact);
    return true;
  } catch {
    log("warn", "contact upsert failed", {});
    return false;
  }
}
