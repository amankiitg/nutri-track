/**
 * The admin page's data, and the pure logic behind what it shows.
 *
 * Three rules this file exists to keep:
 *
 *   - **Addresses are normalised the same way the lookup is.** `20260911130100` made
 *     `lower(trim(email))` the matching rule and the database now applies it on the way
 *     in, so an address that cannot be matched cannot be stored. This repeats the rule
 *     for the same reason the database enforces it: an invite that looks added and never
 *     matches is worse than no invite at all.
 *   - **Nothing here assumes it is the only thing guarding the data.** Every read and
 *     write is authorised by RLS, and these wrappers would return nothing for a
 *     non-admin even if the route let one in. The route is a convenience; the policies
 *     are the control.
 *   - **No price.** Tokens are counted and shown; converting them to money is the
 *     reader's business, because a rate card in here would be wrong the first time
 *     Google changed it.
 */
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { parseMealUrl } from "@/lib/capture";
import { DAILY_ANALYSIS_LIMIT } from "@shared/meal-parse";

/** The one place the normalisation rule is written in the browser. */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * Whether an address is worth offering to the server.
 *
 * Deliberately loose. The question this answers is "is there an @ with something either
 * side", because the real check is delivery, which this app cannot do yet. A stricter
 * pattern here would reject valid addresses and stop nothing.
 */
export function isPlausibleEmail(input: string): boolean {
  const email = normalizeEmail(input);
  const at = email.indexOf("@");
  return at > 0 && at < email.length - 1 && !email.includes(" ") && email.includes(".");
}

/**
 * Whether this account is an admin.
 *
 * A failure reads as "not an admin", which is the safe direction: the admin page is
 * hidden and the policies behind it refuse anyway, so the worst case is a route that is
 * merely absent rather than one that is merely hidden.
 */
export async function fetchIsAdmin(): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_admin");
  if (error) return false;
  return data === true;
}

const inviteRow = z.object({
  email: z.string(),
  added_by: z.string().nullable(),
  created_at: z.string(),
  signed_up_at: z.string().nullable(),
  user_id: z.string().nullable(),
  is_admin: z.boolean(),
});

export interface Invite {
  email: string;
  addedBy: string | null;
  createdAt: string;
  signedUpAt: string | null;
  userId: string | null;
  isAdmin: boolean;
}

export async function fetchInvites(): Promise<Invite[]> {
  const { data, error } = await supabase.rpc("admin_invites");
  if (error) throw new Error(readableAdminError(error.message));
  const rows = z.array(inviteRow).safeParse(data);
  if (!rows.success) throw new Error("The invite list came back in an unexpected shape.");
  return rows.data.map((row) => ({
    email: row.email,
    addedBy: row.added_by,
    createdAt: row.created_at,
    signedUpAt: row.signed_up_at,
    userId: row.user_id,
    isAdmin: row.is_admin,
  }));
}

const spendRow = z.object({
  user_id: z.string().nullable(),
  email: z.string(),
  timezone: z.string(),
  calls_today: z.number(),
  resets_today: z.string(),
  calls_month: z.number(),
  tokens_month: z.number(),
  calls_total: z.number(),
  tokens_total: z.number(),
  last_call_at: z.string().nullable(),
  is_trial: z.boolean().default(false),
});

export interface UserSpend {
  userId: string | null;
  email: string;
  timeZone: string;
  callsToday: number;
  resetsToday: string;
  callsMonth: number;
  tokensMonth: number;
  callsTotal: number;
  tokensTotal: number;
  lastCallAt: string | null;
  isTrial: boolean;
}

export async function fetchSpend(): Promise<UserSpend[]> {
  const { data, error } = await supabase.rpc("admin_spend");
  if (error) throw new Error(readableAdminError(error.message));
  const rows = z.array(spendRow).safeParse(data);
  if (!rows.success) throw new Error("The spend figures came back in an unexpected shape.");
  return rows.data.map((row) => ({
    userId: row.user_id,
    email: row.email,
    timeZone: row.timezone,
    callsToday: row.calls_today,
    resetsToday: row.resets_today,
    callsMonth: row.calls_month,
    tokensMonth: row.tokens_month,
    callsTotal: row.calls_total,
    tokensTotal: row.tokens_total,
    lastCallAt: row.last_call_at,
    isTrial: row.is_trial,
  }));
}

const trialStatsRow = z.object({
  scans_today: z.number(),
  budget: z.number(),
  user_count: z.number(),
});

export interface TrialStats {
  scansToday: number;
  budget: number;
  userCount: number;
}

/** The admin Trial card: today's scans, the budget, and how many mailboxes tried. */
export async function fetchTrialStats(): Promise<TrialStats> {
  // The function is new in this migration, so the generated client types do not know
  // it yet. Cast rather than hand-edit the generated types; the next regeneration
  // picks it up. The budget comes from the database's trial_settings, not an argument,
  // so the card cannot drift from the number the enforcing function reads.
  const rpc = supabase.rpc as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
  const { data, error } = await rpc("admin_trial_stats", {});
  if (error) throw new Error(readableAdminError(error.message));
  const parsed = trialStatsRow.safeParse(data);
  if (!parsed.success) throw new Error("The trial figures came back in an unexpected shape.");
  return {
    scansToday: parsed.data.scans_today,
    budget: parsed.data.budget,
    userCount: parsed.data.user_count,
  };
}

/** Adds an address to the list. Returns the normalised form that was stored. */
export async function addInvite(email: string, addedBy: string): Promise<string> {
  const normalized = normalizeEmail(email);
  const { error } = await supabase
    .from("allowed_emails")
    // Normalised here as well as in the trigger: this way the caller and the row agree,
    // and a mismatch would be a bug in this file rather than a silent bad row.
    .insert({ email: normalized, added_by: addedBy });
  if (error) throw new Error(readableAdminError(error.message));
  return normalized;
}

/**
 * Invites someone: the service drafts the email and adds the address, in one request.
 *
 * Deliberately not two calls from here. Two calls can half-succeed, and the half that grants
 * access is the one that must not happen without the other: an address on the list that was
 * never emailed can sign in, and nobody finds out. The order the service uses means a failure
 * leaves the invite ungranted instead.
 *
 * The response is validated rather than trusted, like anything else that crosses a network.
 */
const draftedInviteSchema = z.object({
  email: z.string(),
  firstName: z.string(),
  draftId: z.string(),
  alreadyInvited: z.boolean(),
});

export type DraftedInvite = z.infer<typeof draftedInviteSchema>;

/** The service's own message, which is written for a phone. */
function inviteFailure(body: unknown, status: number): string {
  const parsed = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
  if (parsed.success) return parsed.data.error.message;
  if (status === 401) return "Your session has expired. Sign in again.";
  return "The server could not create the invite. Try again.";
}

export async function draftInvite(email: string, firstName: string): Promise<DraftedInvite> {
  return postInvite({ email, firstName, kind: "invite" });
}

/**
 * Drafts the approval for somebody who asked to join and has already been let in.
 *
 * A separate call from `draftInvite` rather than a flag at every call site: the two go to the same
 * route and differ in one word, and a boolean that means "the other email" is the kind of parameter
 * that gets passed wrongly at midnight. The server writes nothing to the invite list on this path.
 */
export async function draftApproved(email: string, firstName: string): Promise<DraftedInvite> {
  return postInvite({ email, firstName, kind: "approved" });
}

async function postInvite(body: {
  email: string;
  firstName: string;
  kind: "invite" | "approved";
}): Promise<DraftedInvite> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token === undefined || token === "") {
    throw new Error("Your session has expired. Sign in again.");
  }

  const url = new URL("invite", parseMealUrl()).toString();

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Could not reach the server. Check your connection and try again.");
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(inviteFailure(payload, response.status));

  const parsed = draftedInviteSchema.safeParse(payload);
  if (!parsed.success) throw new Error("The server sent something unexpected. Try again.");
  return parsed.data;
}

export async function removeInvite(email: string): Promise<void> {
  const { error } = await supabase
    .from("allowed_emails")
    .delete()
    .eq("email", normalizeEmail(email));
  if (error) throw new Error(readableAdminError(error.message));
}

const requestRow = z.object({
  id: z.string(),
  email: z.string(),
  requested_at: z.string(),
  status: z.string(),
  handled_at: z.string().nullable(),
  // Added with the email form's request, so an older row simply has no name.
  first_name: z.string().nullable(),
  from_trial: z.boolean().default(false),
});

export interface InviteRequest {
  id: string;
  email: string;
  requestedAt: string;
  status: string;
  handledAt: string | null;
  /** What to greet them by in the approval draft. Null when nobody gave one. */
  firstName: string | null;
  /** True when the request came from the trial's 0-scans wall. */
  fromTrial: boolean;
}

export async function fetchInviteRequests(): Promise<InviteRequest[]> {
  const { data, error } = await supabase
    .from("invite_requests")
    .select("id, email, requested_at, status, handled_at, first_name, from_trial")
    .order("requested_at", { ascending: false });
  if (error) throw new Error(readableAdminError(error.message));

  const rows = z.array(requestRow).safeParse(data);
  if (!rows.success) throw new Error("The requests came back in an unexpected shape.");
  return rows.data.map((row) => ({
    id: row.id,
    email: row.email,
    requestedAt: row.requested_at,
    status: row.status,
    handledAt: row.handled_at,
    firstName: row.first_name,
    fromTrial: row.from_trial,
  }));
}

/** Approves a request, putting the address on the list in the same transaction. */
export async function approveRequest(id: string): Promise<string> {
  const { data, error } = await supabase.rpc("admin_approve_request", { p_request: id });
  if (error) throw new Error(readableAdminError(error.message));
  return typeof data === "string" ? data : "";
}

/**
 * Declines a request. It leaves the pending list and is not shown anywhere afterwards.
 *
 * A plain update rather than an RPC, because the policy is the authorisation: the
 * `invite_requests_admin_update` policy allows an admin to write this row and nobody else to write
 * any row, and a function that only wrapped those two columns would not add a check that policy does
 * not already make. The row is kept rather than deleted: a declined request is a record of a decision,
 * and somebody asking again should find it there rather than appear from nowhere.
 */
export async function declineRequest(id: string): Promise<void> {
  const { error } = await supabase
    .from("invite_requests")
    .update({ status: "declined", handled_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(readableAdminError(error.message));
}

/**
 * Records that someone signed in and was not on the list.
 *
 * **Gone, and deliberately not replaced here.** This used to be a plain insert into
 * `invite_requests`, which the insert policy allowed for the signed-in caller's own address. The
 * gate now calls `request_invite` instead (`src/lib/invite-request.ts`), because the same call has to
 * serve the email form's visitor, who has no session at all. Two ways to record one request would
 * drift on the rules that matter - declined stays declined, one row per mailbox, the burst limits -
 * and the one inside the database is the one that cannot be bypassed.
 *
 * The read that used to sit here (`fetchOwnRequest`) went with it: the function's answer already
 * distinguishes "already waiting" from "just recorded", so the gate has nothing left to look up.
 */

/**
 * Supabase's wording, replaced with something that survives being read by a person.
 *
 * The two cases worth naming are the ones the admin can actually do something about: the
 * list already holds the address, and the caller is not an admin after all.
 */
export function readableAdminError(message: string): string {
  if (/duplicate key|already exists/i.test(message)) {
    return "That address is already on the list.";
  }
  if (/admin only|42501|row-level security/i.test(message)) {
    return "That needs an admin account, and this one is not one.";
  }
  return `Could not reach the invite list (${message}).`;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export interface SpendPresentation {
  /** "11 of 20 left today", or "All 20 used today". */
  today: string;
  todayFraction: number;
  exhausted: boolean;
  /** "38 calls · 150,045 tokens this month". */
  month: string;
  /** "1,203 calls · 4,511,002 tokens all time". */
  total: string;
  /** "Never", or "Last used 7 Sept, 14:02". */
  lastUsed: string;
}

/** Thousands separators, because six-digit token counts are unreadable without them. */
export function formatCount(value: number): string {
  return value.toLocaleString("en-GB");
}

export function presentSpend(
  spend: UserSpend,
  limit: number = DAILY_ANALYSIS_LIMIT,
): SpendPresentation {
  const remaining = Math.max(0, limit - spend.callsToday);
  const exhausted = remaining === 0;
  return {
    today: exhausted ? `All ${limit} used today` : `${remaining} of ${limit} left today`,
    todayFraction: Math.min(1, spend.callsToday / limit),
    exhausted,
    month: `${formatCount(spend.callsMonth)} calls · ${formatCount(spend.tokensMonth)} tokens this month`,
    total: `${formatCount(spend.callsTotal)} calls · ${formatCount(spend.tokensTotal)} tokens all time`,
    lastUsed:
      spend.lastCallAt === null
        ? "Never analysed a meal"
        : `Last used ${formatMoment(spend.lastCallAt, spend.timeZone)}`,
  };
}

/** A date and time in the profile's own zone, which is the only zone the app trusts. */
export function formatMoment(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** "Invited 7 Sept" or "Signed up 9 Sept". */
export function formatDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

export interface InviteStatus {
  label: string;
  /** What it means for the admin: do they need to do anything? */
  tone: "joined" | "waiting" | "silent";
}

export function inviteStatus(invite: Invite): InviteStatus {
  if (invite.signedUpAt !== null) {
    return { label: invite.isAdmin ? "Joined · admin" : "Joined", tone: "joined" };
  }
  return { label: "Invited, not arrived", tone: "silent" };
}

export function requestStatus(request: InviteRequest): InviteStatus {
  if (request.status === "revoked") return { label: "Removed", tone: "silent" };
  if (request.status === "approved") return { label: "Approved", tone: "joined" };
  if (request.status === "declined") return { label: "Declined", tone: "silent" };
  return { label: "Waiting", tone: "waiting" };
}

/**
 * The requests still waiting, newest first: what the admin's top card shows and nothing else.
 *
 * An approved or declined row is a decision that has been made, and a list that mixes decisions with
 * work is a list nobody reads in the same way.
 */
export function pendingRequests(requests: readonly InviteRequest[]): InviteRequest[] {
  return requests
    .filter((request) => request.status === "pending")
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

/** The requests whose invitation was taken away, which is where "Approve again" lives. */
export function revokedRequests(requests: readonly InviteRequest[]): InviteRequest[] {
  return requests
    .filter((request) => request.status === "revoked")
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

export function pendingCount(requests: readonly InviteRequest[]): number {
  return requests.filter((request) => request.status === "pending").length;
}
