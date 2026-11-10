/**
 * Asking to get in, from a screen where nobody is signed in.
 *
 * Three things live here, and they answer different questions.
 *
 * `authEntryState` asks the database which form an address deserves, because the five cases are not
 * guessable from the browser: an address that is not invited must not learn whether it has an
 * account, and only the database can tell an account that has never had a password from one that
 * has. `requestInvite` records the request itself, so it lands in the list the admin page reads
 * instead of in somebody's inbox. The mailto is the fallback for when either of those cannot run at
 * all: a rate limit, a dropped connection, a project that has not had the migration applied.
 */
import { supabase } from "@/integrations/supabase/client";

/**
 * Where a request goes if the button cannot send it.
 *
 * **This mailbox has to exist.** Nothing in the app can check that it does, so this constant is the
 * single place to change if the address ever moves, and the one value a deployment has to get right
 * for the fallback to be worth offering.
 */
export const INVITE_REQUEST_ADDRESS = "invites@tracknutri.app";

/** The subject line, which is what the mailbox is searched by. */
const SUBJECT = "NutriTrack invite request";

/**
 * What the person's mail app opens with: addressed, subject filled in, and already asking.
 *
 * The address they typed goes in the body rather than in the recipient, because the recipient is the
 * product. Both parts are percent-encoded: a `+` in an address is a legal character and a leading
 * space is a message that arrives mangled.
 */
export function inviteRequestMailto(email: string): string {
  const typed = email.trim();
  const body = typed === "" ? "Please send me an invite to NutriTrack." : `Please invite ${typed}`;
  return `mailto:${INVITE_REQUEST_ADDRESS}?subject=${encodeURIComponent(SUBJECT)}&body=${encodeURIComponent(body)}`;
}

/**
 * The five answers the database gives about an address.
 *
 * `busy` is the throttle talking, and it is deliberately not folded into `not_invited`: one of them
 * means "ask for an invite" and the other means "come back in a minute", and telling a person with
 * an invite to ask for one is the worse of the two mistakes.
 *
 * `google_only` is an account that has never had a password. A password box in front of it is a dead
 * end, and the only door that works is the one that says so.
 */
export type AuthEntryState = "not_invited" | "invited_new" | "has_account" | "google_only" | "busy";

const ENTRY_STATES: readonly AuthEntryState[] = [
  "not_invited",
  "invited_new",
  "has_account",
  "google_only",
  "busy",
];

/**
 * Which form to show for this address, or null when the question could not be answered.
 *
 * A failure is deliberately not folded into `not_invited`. The panel offers a mailbox and a request
 * button, which is right for a stranger and wrong for somebody whose invite exists but whose
 * connection dropped: they would be told to ask for something they already have.
 */
export async function authEntryState(email: string): Promise<AuthEntryState | null> {
  try {
    const { data, error } = await supabase.rpc("auth_entry_state", { p_email: email });
    if (error) return null;
    const state = typeof data === "string" ? data.trim() : "";
    return (ENTRY_STATES as readonly string[]).includes(state) ? (state as AuthEntryState) : null;
  } catch {
    return null;
  }
}

/**
 * The five answers `request_invite` gives, and the screen each one draws.
 *
 * `requested` covers a declined request on purpose: the database writes nothing and the person is
 * told what everybody else is told, because the decision belongs to the admin rather than to the
 * screen.
 */
export type InviteResult =
  "requested" | "already_pending" | "already_invited" | "invalid" | "rate_limited";

const INVITE_RESULTS: readonly InviteResult[] = [
  "requested",
  "already_pending",
  "already_invited",
  "invalid",
  "rate_limited",
];

export interface RequestInviteOptions {
  firstName?: string;
  /**
   * True when the app is asking on the person's behalf - the sign-in gate after a refused Google
   * sign-in - rather than a person typing their address and pressing a button. The database uses it
   * to refuse to put a revoked invitation back in the queue.
   */
  auto?: boolean;
  /** The hidden field nobody can see. A value here means a bot filled the form. */
  honeypot?: string;
  /** True when the request comes from the trial's 0-scans wall. */
  fromTrial?: boolean;
}

/**
 * Records the request, and says what the database did with it.
 *
 * `null` means the call itself failed: no connection, or a project without the migration. The screen
 * treats it exactly like `rate_limited`, because from the person's side those are the same thing -
 * nothing was recorded, and the mailbox is the way through.
 */
export async function requestInvite(
  email: string,
  options: RequestInviteOptions = {},
): Promise<InviteResult | null> {
  const firstName = (options.firstName ?? "").trim();
  const honeypot = options.honeypot ?? "";
  try {
    // The optional arguments are omitted rather than sent as null: the function's own defaults are the
    // same, and an omitted key is what the generated types describe.
    const { data, error } = await supabase.rpc("request_invite", {
      p_email: email,
      ...(firstName === "" ? {} : { p_first_name: firstName }),
      p_auto: options.auto === true,
      p_from_trial: options.fromTrial === true,
      ...(honeypot === "" ? {} : { p_honeypot: "filled" }),
    });
    if (error) return null;
    const result = typeof data === "string" ? data.trim() : "";
    return (INVITE_RESULTS as readonly string[]).includes(result) ? (result as InviteResult) : null;
  } catch {
    return null;
  }
}
