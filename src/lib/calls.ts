/**
 * The daily meal-analysis budget, and how Settings says it.
 *
 * The number comes from `llm_call_budget()` (migration `20260911200000`), which counts
 * the caller's model calls since midnight *in their profile's timezone* — the same
 * boundary the service enforces. Counting it here instead would mean the number on
 * screen and the number the service acts on were computed by two different clocks,
 * and the only visible symptom of that disagreement is being refused when the screen
 * says there is plenty left.
 *
 * The limit itself is not defined here either. It lives in `shared/meal-parse.ts` with
 * the rest of the parse-meal contract, so the service, this screen and the SQL function
 * cannot drift apart.
 *
 * What is here is presentation: the wording, and the arithmetic that stops a stale read
 * from claiming more than the limit.
 */
import { z } from "zod";
import { MAX_LLM_CALLS_PER_DAY } from "@shared/meal-parse";
import { supabase } from "@/integrations/supabase/client";

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
  limit: number = MAX_LLM_CALLS_PER_DAY,
): CallBudget {
  const bounded = Math.max(0, Math.min(Math.round(used), limit));
  return { used: bounded, limit, remaining: limit - bounded, resetsAt };
}

export async function fetchCallBudget(): Promise<CallBudget> {
  const { data, error } = await supabase.rpc("llm_call_budget");
  if (error) throw new Error(`Could not read today's analyses: ${error.message}`);

  const row = budgetRow.safeParse(Array.isArray(data) ? data[0] : null);
  if (!row.success) throw new Error("The analyses count came back in an unexpected shape.");
  return budgetFrom(row.data.used, row.data.resets_at);
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
    reset: `Resets at midnight — ${resetClock(budget.resetsAt, timeZone)} in ${timeZone}.`,
    exhausted:
      budget.remaining === 0
        ? `You have used all ${budget.limit} analyses for today. Meals added by typing still work — it is only the reading of photos and voice notes that is limited.`
        : null,
  };
}

/** Why the number is not simply "meals logged". Shown under the count. */
export const countsNote =
  "A meal that the reader has to try twice costs two, so this can run down faster than meals pile up.";
