/**
 * The reached-target decision, fetched and decided in one place.
 *
 * Today and Settings used to answer the same question with different inputs: Settings compared
 * the profile's stored weight with the target, so 167.2 lb against a 165 lb target showed a
 * notice that Today, reading a week of weigh-ins, correctly hid. Both screens now call this
 * hook, so the window is fetched under one key and the rule is the one in
 * `maintainSuggestion` — the hook decides nothing itself.
 *
 * `dismissed` stays the caller's: Today honours the "Not now" it stored, Settings ignores it
 * because that is the screen where a goal is changed. Ignoring a dismissal can only show the
 * notice sooner, never later, so the two screens still agree whenever they have the same weight
 * history and no dismissal has been made.
 */
import { useQuery } from "@tanstack/react-query";
import {
  maintainSuggestion,
  type MaintainDismissal,
  type MaintainSuggestion,
} from "@/lib/maintain-suggestion";
import { fetchWeightWindow } from "@/lib/profile";
import type { Goal } from "@/lib/targets";

export interface WeightWindow {
  /** The trailing 7-day average in kilograms, or null when nothing was weighed. */
  averageKg: number | null;
  /** How many weigh-ins that average is over. Fewer than three is not a trend. */
  readings: number;
}

/**
 * The trailing 7-day average, fetched once for every reader of it.
 *
 * The reached-target notice and the arrival date are two answers about the same average, and a
 * screen that showed both would have fetched it twice if they each held their own query. The
 * key shares the `weights` prefix, so logging a weigh-in refetches this without a second
 * invalidation to remember.
 */
export function useWeightWindow(input: { userId: string; today: string }): WeightWindow {
  const { userId, today } = input;
  const window = useQuery({
    queryKey: ["weights", userId, today, "7d"],
    queryFn: () => fetchWeightWindow(today),
    enabled: userId !== "",
  });
  return { averageKg: window.data?.averageKg ?? null, readings: window.data?.readings ?? 0 };
}

export function useMaintainSuggestion(input: {
  userId: string;
  today: string;
  goal: Goal | null;
  targetKg: number | null;
  dismissed: MaintainDismissal | null;
}): MaintainSuggestion | null {
  const { userId, today, goal, targetKg, dismissed } = input;
  const window = useWeightWindow({ userId, today });

  return maintainSuggestion({
    goal,
    averageKg: window.averageKg,
    readings: window.readings,
    targetKg,
    dismissed,
    today,
  });
}
