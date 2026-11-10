/**
 * The daily meal-analysis budget, and how Settings says it.
 *
 * The *count* comes from `llm_call_budget()` (migration `20260911200000`), which counts the caller's
 * model calls since midnight *in their profile's timezone* — the same boundary the service enforces.
 * Counting it here instead would mean the number on screen and the number the service acts on were
 * computed by two different clocks, and the only visible symptom of that disagreement is being
 * refused when the screen says there is plenty left.
 *
 * The *limit* comes from `GET /analysis-limit` on the service, which is the thing that enforces it.
 * A constant compiled into the browser would be a promise the service could stop keeping the moment
 * `DAILY_ANALYSIS_LIMIT` changed on the server, and the failure would look like a bug in the count.
 * `shared/meal-parse.ts` still holds the default, and it is the fallback for when the service cannot
 * be reached at all — a screen that says nothing is worse than one that names the default.
 *
 * What is here is presentation: the wording, and the arithmetic that stops a stale read from claiming
 * more than the limit.
 */
import { z } from "zod";
import { DAILY_ANALYSIS_LIMIT } from "@shared/meal-parse";
import { supabase } from "@/integrations/supabase/client";
import { parseMealUrl } from "@/lib/capture";

/** One row of `llm_call_budget()`. PostgREST returns `int` as a JSON number. */
const budgetRow = z.object({
  used: z.number(),
  resets_at: z.string(),
});

export interface CallBudget {
  /** Model calls already made today. */
  used: number;
  limit: number;
  /** Never negative, and never more than `limit`. */
  remaining: number;
  /** ISO instant of the next local midnight, in the profile's zone. */
  resetsAt: string;
}

/**
 * Clamped at both ends on purpose.
 *
 * The read is a snapshot: it can be a shade stale, and it can be taken while another
 * tab is spending the same budget. Reporting "-3 left" would be a worse lie than
 * reporting zero, and so would reporting more than the limit exists.
 */
export function budgetFrom(
  used: number,
  resetsAt: string,
  limit: number = DAILY_ANALYSIS_LIMIT,
): CallBudget {
  const bounded = Math.max(0, Math.min(Math.round(used), limit));
  return { used: bounded, limit, remaining: limit - bounded, resetsAt };
}

/** What the service says each kind of account is allowed today. */
export interface AnalysisLimits {
  /** An ordinary account. */
  daily: number;
  /** An admin account. */
  admin: number;
  /** Which of the two the caller is. */
  mine: number;
}

const limitsSchema = z.object({ daily: z.number(), admin: z.number(), limit: z.number() });

/**
 * Asks the service what it enforces, so the screen cannot print a different number.
 *
 * A failure throws rather than guessing: `fetchCallBudget` decides what to do about it, because only
 * it knows whether it can still show a count.
 */
export async function fetchAnalysisLimits(): Promise<AnalysisLimits> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token === undefined || token === "") throw new Error("Sign in again to read the limit.");

  const response = await fetch(new URL("analysis-limit", parseMealUrl()).toString(), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("Could not read the daily limit.");

  const parsed = limitsSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("The daily limit came back in an unexpected shape.");
  return { daily: parsed.data.daily, admin: parsed.data.admin, mine: parsed.data.limit };
}

export async function fetchCallBudget(): Promise<CallBudget> {
  // In parallel: the count is a database read and the limit is a service call, and neither waits for
  // the other. A failed limit falls back to the shared default so the count still appears.
  const [row, limits] = await Promise.all([
    supabase.rpc("llm_call_budget").then(({ data, error }) => {
      if (error) throw new Error(`Could not read today's analyses: ${error.message}`);
      const parsed = budgetRow.safeParse(Array.isArray(data) ? data[0] : null);
      if (!parsed.success) throw new Error("The analyses count came back in an unexpected shape.");
      return parsed.data;
    }),
    fetchAnalysisLimits().catch(() => null),
  ]);

  return budgetFrom(row.used, row.resets_at, limits?.mine ?? DAILY_ANALYSIS_LIMIT);
}

/** Midnight in the profile's zone, as a clock time: the budget resets at local 00:00. */
export function resetClock(resetsAt: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(resetsAt));
}

export interface BudgetPresentation {
  /** The number to show large: what is left. */
  remaining: number;
  /** What that number is out of. */
  scale: string;
  /** When it comes back. */
  reset: string;
  /**
   * Set only when there is none left. The point of the screen is to answer "can I log
   * this now", and when the answer is no it has to come with the way around it.
   */
  exhausted: string | null;
}

/**
 * The whole card, as words.
 *
 * "Analyses" rather than "calls" throughout, because a call is not a thing the user
 * made. The one place the two diverge is stated in `countsNote` rather than hidden:
 * the service counts model calls, so a meal the reader had to re-read costs two, and
 * someone who has logged forty meals and sees fifty used deserves to know why.
 */
export function presentBudget(budget: CallBudget, timeZone: string): BudgetPresentation {
  return {
    remaining: budget.remaining,
    scale: `of ${budget.limit} left today`,
    reset: `Resets at midnight, ${resetClock(budget.resetsAt, timeZone)} in ${timeZone}.`,
    exhausted:
      budget.remaining === 0
        ? `You've used today's ${budget.limit} analyses. You can still add meals by typing the numbers yourself, and the count resets at midnight in your time zone.`
        : null,
  };
}

/** Why the number is not simply "meals logged". Shown under the count. */
export const countsNote =
  "A meal that the reader has to try twice costs two, so this can run down faster than meals pile up.";
