/**
 * Resend's Contacts API, for the mailing list.
 *
 * One operation: upsert. There is no delete path and there is no way to send an
 * email from this file, on purpose. The list is a copy of who may use the app, and
 * the only thing this client does with it is add a contact or mark one unsubscribed.
 *
 * Three rules decide the body of every write, and all three are the same rule read
 * in three places:
 *
 *   - `unsubscribed: false` is never sent. Not when a contact exists, not when a
 *     profile says product mail is on, not when the person turned it back on in
 *     Settings. Resend remembers an unsubscribe that happened below us, and a sync
 *     that could undo it would make the link at the bottom of an email a lie.
 *   - `unsubscribed: true` is sent when the profile says product mail is off, and
 *     only then.
 *   - `first_name` is written only when the contact has none. A name in Resend may
 *     be one a person typed there, and a profile's display name is not a better
 *     copy of it.
 *
 * The address is never logged. Resend's error body can echo it, so a failure is
 * reported as a status code and nothing else.
 */
import { z } from "zod";

export interface ContactInput {
  email: string;
  /** Empty or null means "leave whatever is there". */
  firstName: string | null;
  /** False means "make sure this contact is unsubscribed". True changes nothing. */
  productEmails: boolean;
}

/**
 * What a write did, named exactly.
 *
 * This used to answer "updated" for both a filled-in first name and a contact turned off, which
 * made the two indistinguishable to a caller reading the return value and left the sync counting
 * them as one number. They are different events and the sync reports them separately.
 */
export type ContactOutcome = "created" | "named" | "unsubscribed" | "unchanged" | "exists";

export interface ResendContactsClient {
  upsert(contact: ContactInput): Promise<ContactOutcome>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A refused call. The message is for the log and carries no address and no key:
 * Resend's own body often repeats the contact it refused, and a log line is the
 * wrong place for an address nobody purges.
 */
export class ResendContactsError extends Error {
  constructor(operation: string, status: number | null) {
    super(
      status === null ? `Resend ${operation} failed` : `Resend ${operation} failed (${status})`,
    );
    this.name = "ResendContactsError";
  }
}

/**
 * A contact as the API returns it.
 *
 * `data` is accepted as a wrapper as well as the direct object because the two
 * shapes have both appeared in Resend's documentation over time, and reading a
 * missing field as empty is harmless here: it can only cause a first_name to be
 * written, never an unsubscribe to be reversed.
 */
const contactSchema = z.object({
  first_name: z.string().nullish(),
  unsubscribed: z.boolean().nullish(),
  data: z
    .object({
      first_name: z.string().nullish(),
      unsubscribed: z.boolean().nullish(),
    })
    .optional(),
});

const REQUEST_TIMEOUT_MS = 10_000;

export function createResendContactsClient(options: {
  apiKey: string;
  audienceId: string;
  fetchImpl?: FetchLike;
}): ResendContactsClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = `https://api.resend.com/audiences/${encodeURIComponent(options.audienceId)}/contacts`;

  function headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: "Bearer " + options.apiKey,
    };
  }

  /** Null when the contact does not exist yet. Anything else that is not ok throws. */
  async function read(email: string): Promise<z.infer<typeof contactSchema> | null> {
    const response = await fetchImpl(`${base}/${encodeURIComponent(email)}`, {
      method: "GET",
      headers: headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new ResendContactsError("contact read", response.status);

    const body: unknown = await response.json().catch(() => null);
    const parsed = contactSchema.safeParse(body);
    if (!parsed.success) throw new ResendContactsError("contact read shape", response.status);
    return parsed.data.data ?? parsed.data;
  }

  async function create(contact: ContactInput): Promise<ContactOutcome> {
    const body: Record<string, unknown> = { email: contact.email };
    if (contact.firstName !== null && contact.firstName.trim() !== "") {
      body["first_name"] = contact.firstName.trim();
    }
    // The only place a new contact can be born unsubscribed. False is never sent.
    if (!contact.productEmails) body["unsubscribed"] = true;

    const response = await fetchImpl(base, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.ok) return "created";
    // "Already exists" is success: a racing run created it, and the update below
    // will reach it on the next sync.
    if (response.status === 409 || response.status === 422) return "exists";
    throw new ResendContactsError("contact create", response.status);
  }

  async function patch(
    email: string,
    body: Record<string, unknown>,
    outcome: Extract<ContactOutcome, "named" | "unsubscribed">,
  ): Promise<ContactOutcome> {
    const response = await fetchImpl(`${base}/${encodeURIComponent(email)}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new ResendContactsError("contact update", response.status);
    return outcome;
  }

  return {
    async upsert(contact) {
      const email = contact.email.trim().toLowerCase();
      const existing = await read(email);
      if (existing === null) return create({ ...contact, email });

      const body: Record<string, unknown> = {};

      // Only a contact with no name gets one. A name already in Resend is not ours
      // to replace, even when the profile's display name differs.
      const hasName = typeof existing.first_name === "string" && existing.first_name.trim() !== "";
      let outcome: Extract<ContactOutcome, "named" | "unsubscribed"> = "unsubscribed";
      if (!hasName && contact.firstName !== null && contact.firstName.trim() !== "") {
        body["first_name"] = contact.firstName.trim();
        outcome = "named";
      }

      // One direction only. `existing.unsubscribed === true` means there is nothing
      // to do, and `productEmails` true means there is nothing to say.
      if (!contact.productEmails && existing.unsubscribed !== true) {
        body["unsubscribed"] = true;
        // A row that both gained a name and lost its subscription is reported as the
        // name, because that is the rarer event and the one worth seeing; the
        // unsubscribe is a consequence of the profile it came from.
      }

      if (Object.keys(body).length === 0) return "unchanged";
      return patch(email, body, outcome);
    },
  };
}
