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
import { MAX_LLM_CALLS_PER_DAY } from "@shared/meal-parse";

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
  user_id: z.string(),
  email: z.string(),
  timezone: z.string(),
  calls_today: z.number(),
  resets_today: z.string(),
  calls_month: z.number(),
  tokens_month: z.number(),
  calls_total: z.number(),
  tokens_total: z.number(),
  last_call_at: z.string().nullable(),
});

export interface UserSpend {
  userId: string;
  email: string;
  timeZone: string;
  callsToday: number;
  resetsToday: string;
  callsMonth: number;
  tokensMonth: number;
  callsTotal: number;
  tokensTotal: number;
  lastCallAt: string | null;
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
  }));
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
});

export interface InviteRequest {
  id: string;
  email: string;
  requestedAt: string;
  status: string;
  handledAt: string | null;
}

export async function fetchInviteRequests(): Promise<InviteRequest[]> {
  const { data, error } = await supabase
    .from("invite_requests")
    .select("id, email, requested_at, status, handled_at")
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
  }));
}

/** Approves a request, putting the address on the list in the same transaction. */
export async function approveRequest(id: string): Promise<string> {
  const { data, error } = await supabase.rpc("admin_approve_request", { p_request: id });
  if (error) throw new Error(readableAdminError(error.message));
  return typeof data === "string" ? data : "";
}

/**
 * Records that someone signed in and was not on the list.
 *
 * The only write in this app that an uninvited person can cause, so it is written to be
 * safe by construction rather than by being careful:
 *
 *   - The body carries **no email**. The address comes from the column default, which is
 *     the `email` claim of the caller's signed JWT, and the insert policy checks the
 *     stored value against that same claim. So there is no address for this request to
 *     aim at even if the caller tampers with the body.
 *   - It is a plain insert, and the database skips it if the address has asked before.
 *     So a repeat is not an error and there is nothing to retry in a loop.
 *   - It **never throws**. Asking twice, being offline, or being refused by a burst guard
 *     must not stop the person seeing the screen that tells them what to do. A failure
 *     here is a missed notification, not a broken app.
 *
 * The alternative — a `security definer` function that inserts on the caller's behalf —
 * was rejected: it would hand an uninvited person a definer-rights primitive to protect a
 * row that RLS already protects far more cheaply.
 */
export async function recordInviteRequest(): Promise<boolean> {
  try {
    const { error } = await supabase.from("invite_requests").insert({});
    if (error) {
      console.warn("could not record the invite request", error.message);
      return false;
    }
    return true;
  } catch (caught) {
    console.warn("could not record the invite request", caught);
    return false;
  }
}

/** Whether the caller's own request is already on record, for the gate screen. */
export async function fetchOwnRequest(): Promise<InviteRequest | null> {
  const { data, error } = await supabase
    .from("invite_requests")
    .select("id, email, requested_at, status, handled_at")
    .limit(1)
    .maybeSingle();
  if (error) return null;
  const row = requestRow.safeParse(data);
  if (!row.success) return null;
  return {
    id: row.data.id,
    email: row.data.email,
    requestedAt: row.data.requested_at,
    status: row.data.status,
    handledAt: row.data.handled_at,
  };
}

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
  /** "11 of 60 today", or "limit reached". */
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

export function presentSpend(spend: UserSpend): SpendPresentation {
  const remaining = Math.max(0, MAX_LLM_CALLS_PER_DAY - spend.callsToday);
  const exhausted = remaining === 0;
  return {
    today: exhausted
      ? `All ${MAX_LLM_CALLS_PER_DAY} used today`
      : `${remaining} of ${MAX_LLM_CALLS_PER_DAY} left today`,
    todayFraction: Math.min(1, spend.callsToday / MAX_LLM_CALLS_PER_DAY),
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
  if (request.status === "approved") return { label: "Approved", tone: "joined" };
  if (request.status === "declined") return { label: "Declined", tone: "silent" };
  return { label: "Waiting", tone: "waiting" };
}

/** Pending first, then newest first: the order they are worked through. */
export function sortRequests(requests: readonly InviteRequest[]): InviteRequest[] {
  const rank = (request: InviteRequest): number => (request.status === "pending" ? 0 : 1);
  return [...requests].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return b.requestedAt.localeCompare(a.requestedAt);
  });
}

export function pendingCount(requests: readonly InviteRequest[]): number {
  return requests.filter((request) => request.status === "pending").length;
}
