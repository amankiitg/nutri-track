/**
 * The mailing list engine, without a network or a database.
 *
 * The store and the contacts client are both fakes, so the assertions are about the
 * decisions rather than about HTTP: one inbox is one contact, a refused contact does
 * not stop the run, and the numbers recorded are the numbers that happened.
 */
import { describe, expect, it, vi } from "vitest";
import {
  canonicalEmail,
  dedupeByCanonical,
  syncAudience,
  upsertOneContact,
  type EmailSyncRow,
  type EmailSyncStore,
} from "../src/email-sync";
import type { ContactInput, ContactOutcome, ResendContactsClient } from "../src/resend-contacts";

function row(canonical: string, overrides: Partial<EmailSyncRow> = {}): EmailSyncRow {
  return {
    email: canonical,
    canonical,
    firstName: null,
    productEmails: true,
    ...overrides,
  };
}

/**
 * A contacts client that answers with a chosen outcome, because the sync's counters are read off
 * that answer: a fake that always said "unchanged" would make added and names unreachable and the
 * test would pass over the bug it exists to catch.
 */
function fakeContacts(
  throwsFor: readonly string[] = [],
  outcomeFor: Partial<Record<string, ContactOutcome>> = {},
): {
  contacts: ResendContactsClient;
  upserted: ContactInput[];
} {
  const upserted: ContactInput[] = [];
  return {
    upserted,
    contacts: {
      async upsert(contact) {
        if (throwsFor.includes(contact.email)) throw new Error("refused");
        upserted.push(contact);
        return outcomeFor[contact.email] ?? "unchanged";
      },
    },
  };
}

function fakeStore(options: {
  pages: EmailSyncRow[][];
  counts?: { eligible: number; excluded: number; unsubscribed: number };
  recordThrows?: boolean;
  pageThrows?: boolean;
}): {
  store: EmailSyncStore;
  pagesAsked: Array<{ after: string | null; limit: number }>;
  recorded: unknown[];
} {
  const pagesAsked: Array<{ after: string | null; limit: number }> = [];
  const recorded: unknown[] = [];
  let index = 0;
  return {
    pagesAsked,
    recorded,
    store: {
      async page(after, limit) {
        pagesAsked.push({ after, limit });
        if (options.pageThrows === true) throw new Error("database is down");
        const page = options.pages[index] ?? [];
        index += 1;
        return page;
      },
      async counts() {
        return options.counts ?? { eligible: 0, excluded: 0, unsubscribed: 0 };
      },
      async record(state) {
        if (options.recordThrows === true) throw new Error("state is down");
        recorded.push(state);
      },
    },
  };
}

describe("canonicalEmail", () => {
  it("folds the Gmail spellings the invite gate folds", () => {
    expect(canonicalEmail("Aman.Kesarwani+notes@GoogleMail.com")).toBe("amankesarwani@gmail.com");
    expect(canonicalEmail(" a.b+tag@gmail.com ")).toBe("ab@gmail.com");
    expect(canonicalEmail("invitedfriend@gmail.com")).toBe("invitedfriend@gmail.com");
  });

  it("leaves another domain's local part alone", () => {
    expect(canonicalEmail("A.B+tag@Example.test")).toBe("a.b+tag@example.test");
  });

  it("lowercases something that is not an address rather than dropping it", () => {
    expect(canonicalEmail(" Not-An-Address ")).toBe("not-an-address");
  });
});

describe("dedupeByCanonical", () => {
  it("turns three spellings of one inbox into one row", () => {
    const rows = dedupeByCanonical([
      row("amankesarwani@gmail.com", { email: "aman.kesarwani@gmail.com" }),
      row("a.mankesarwani@gmail.com", { email: "a.mankesarwani@gmail.com" }),
      row("amankesarwani@googlemail.com", { email: "amankesarwani+tag@googlemail.com" }),
      row("second@two.test"),
    ]);

    expect(rows.map((entry) => entry.canonical)).toEqual([
      "amankesarwani@gmail.com",
      "second@two.test",
    ]);
    expect(rows[0]?.email).toBe("aman.kesarwani@gmail.com");
  });

  it("keeps the first of two rows that differ only by canonical", () => {
    const rows = dedupeByCanonical([
      row("a.b@gmail.com", { email: "a.b@gmail.com", firstName: "First" }),
      row("ab@gmail.com", { email: "ab@gmail.com", firstName: "Second" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.firstName).toBe("First");
  });
});

describe("syncAudience", () => {
  it("walks the pages and upserts every contact once", async () => {
    const first = row("first@one.test");
    const second = row("second@two.test", { productEmails: false });
    const third = row("third@three.test", { firstName: "Third" });
    const { store, pagesAsked, recorded } = fakeStore({
      pages: [[first, second], [third]],
      counts: { eligible: 3, excluded: 2, unsubscribed: 1 },
    });
    // One of each outcome the client can answer with, so the three buckets are all exercised:
    // the first contact is new, the second was only turned off, the third gained a name.
    const { contacts, upserted } = fakeContacts([], {
      "first@one.test": "created",
      "second@two.test": "unsubscribed",
      "third@three.test": "named",
    });

    const result = await syncAudience({ store, contacts, pageSize: 2, log: () => {} });

    expect(result).toEqual({
      checked: 3,
      added: 1,
      alreadyUpToDate: 1,
      namesUpdated: 1,
      failed: 0,
      firstError: null,
      excluded: 2,
      unsubscribed: 1,
    });
    expect(upserted).toEqual([
      { email: "first@one.test", firstName: null, productEmails: true },
      { email: "second@two.test", firstName: null, productEmails: false },
      { email: "third@three.test", firstName: "Third", productEmails: true },
    ]);
    expect(pagesAsked).toEqual([
      { after: null, limit: 2 },
      { after: "second@two.test", limit: 2 },
    ]);
    expect(recorded).toEqual([
      {
        checked: 3,
        added: 1,
        already: 1,
        names: 1,
        failed: 0,
        excluded: 2,
        unsubscribed: 1,
        firstError: null,
      },
    ]);
  });

  it("does not upsert the same inbox twice across a page boundary", async () => {
    const { store } = fakeStore({
      pages: [
        [row("amankesarwani@gmail.com", { email: "aman.kesarwani@gmail.com" })],
        [row("amankesarwani@googlemail.com", { email: "amankesarwani+tag@googlemail.com" })],
      ],
      counts: { eligible: 1, excluded: 0, unsubscribed: 0 },
    });
    const { contacts, upserted } = fakeContacts();

    const result = await syncAudience({ store, contacts, pageSize: 1, log: () => {} });

    expect(result.checked).toBe(1);
    expect(upserted).toHaveLength(1);
  });

  it("counts a refused contact and carries on with the rest", async () => {
    const { store } = fakeStore({
      pages: [[row("bad@one.test"), row("good@two.test")]],
      counts: { eligible: 2, excluded: 0, unsubscribed: 0 },
    });
    const { contacts, upserted } = fakeContacts(["bad@one.test"]);
    const warned: string[] = [];

    const result = await syncAudience({
      store,
      contacts,
      pageSize: 2,
      log: (level, message) => {
        if (level === "warn") warned.push(message);
      },
    });

    expect(result.checked).toBe(2);
    expect(result.added + result.alreadyUpToDate + result.namesUpdated).toBe(1);
    expect(result.failed).toBe(1);
    // The card shows this sentence, so it has to be the refusal and not a shrug.
    expect(result.firstError).toBe("refused");
    expect(upserted).toEqual([{ email: "good@two.test", firstName: null, productEmails: true }]);
    expect(warned).toEqual(["contact upsert failed"]);
  });

  it("says at error level when it walked rows and refused every one", async () => {
    // The 25 Nov run's shape: zero accepted, and nothing in the row or the log to say whether it had
    // read nothing or refused everything. This is the line that now answers that.
    const { store } = fakeStore({
      pages: [[row("bad@one.test"), row("worse@two.test")]],
      counts: { eligible: 2, excluded: 5, unsubscribed: 0 },
    });
    const { contacts } = fakeContacts(["bad@one.test", "worse@two.test"]);
    const errors: string[] = [];

    const result = await syncAudience({
      store,
      contacts,
      pageSize: 2,
      log: (level, message) => {
        if (level === "error") errors.push(message);
      },
    });

    expect(result).toMatchObject({ checked: 2, failed: 2, added: 0, alreadyUpToDate: 0 });
    expect(errors).toEqual(["mailing list sync refused every contact"]);
  });

  it("says nothing at error level for an idle run, because an idle run is not a fault", async () => {
    const { store } = fakeStore({
      pages: [[row("one@one.test")]],
      counts: { eligible: 1, excluded: 0, unsubscribed: 0 },
    });
    const { contacts } = fakeContacts();
    const errors: string[] = [];

    await syncAudience({
      store,
      contacts,
      pageSize: 1,
      log: (level, message) => {
        if (level === "error") errors.push(message);
      },
    });

    expect(errors).toEqual([]);
  });

  it("finishes even when the state row cannot be written", async () => {
    const { store, recorded } = fakeStore({
      pages: [[row("one@one.test")]],
      recordThrows: true,
    });
    const { contacts } = fakeContacts();
    const warned: string[] = [];

    const result = await syncAudience({
      store,
      contacts,
      pageSize: 1,
      log: (level, message) => {
        if (level === "warn") warned.push(message);
      },
    });

    expect(result.checked).toBe(1);
    expect(recorded).toEqual([]);
    expect(warned).toContain("mailing list state not recorded");
  });

  it("fails the run when the list itself cannot be read", async () => {
    const { store } = fakeStore({ pages: [], pageThrows: true });
    const { contacts } = fakeContacts();
    await expect(syncAudience({ store, contacts, pageSize: 2, log: () => {} })).rejects.toThrow(
      "database is down",
    );
  });

  it("stops when a full page's last canonical does not advance", async () => {
    // A store that ignores p_after would otherwise loop forever. The guard is the
    // canonical it last answered with, not a count of attempts.
    const page = [row("other@one.test"), row("same@one.test")];
    const pagesAsked: Array<string | null> = [];
    const store: EmailSyncStore = {
      async page(after) {
        pagesAsked.push(after);
        return page;
      },
      async counts() {
        return { eligible: 2, excluded: 0, unsubscribed: 0 };
      },
      async record() {},
    };
    const { contacts } = fakeContacts();

    await syncAudience({ store, contacts, pageSize: 2, log: () => {} });

    expect(pagesAsked).toEqual([null, "same@one.test"]);
  });
});

describe("upsertOneContact", () => {
  it("reports success and failure without throwing", async () => {
    const ok = fakeContacts();
    const logger = vi.fn();
    await expect(
      upsertOneContact(
        ok.contacts,
        { email: "one@one.test", firstName: null, productEmails: true },
        logger,
      ),
    ).resolves.toBe(true);
    expect(logger).not.toHaveBeenCalled();

    const bad = fakeContacts(["bad@one.test"]);
    await expect(
      upsertOneContact(
        bad.contacts,
        { email: "bad@one.test", firstName: null, productEmails: true },
        logger,
      ),
    ).resolves.toBe(false);
    expect(logger).toHaveBeenCalledWith("warn", "contact upsert failed", {});
  });
});
