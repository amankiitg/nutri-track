/**
 * When to suggest keeping the target instead of continuing to chase it.
 *
 * The notice used to fire off the latest weigh-in, which is a single noisy estimate: one
 * low morning after a salty dinner was enough to say "you're at your target weight". The
 * number that decides it is now the trailing 7-day average that `target_refresh_needed`
 * already computes for the target refresh, and the average is printed in the notice so
 * the claim can be checked against the scale.
 *
 * Three rules, all here so the screen only renders a decision:
 *
 *  - Fewer than three weigh-ins in the week is not a trend, so there is nothing to say.
 *  - A target counts as reached when the average is within the tolerance or has already
 *    crossed it, in the goal's own direction: for "lose" the average must be at or below
 *    the target plus the tolerance, and for "gain" at or above it minus the tolerance. A
 *    target on the wrong side is the settings form's error, not this screen's notice.
 *  - A dismissal silences it for a week, unless the average has crossed the target in
 *    that time. Crossing is what the person is waiting for, so it is allowed to interrupt.
 */
import type { Goal } from "./targets";

/**
 * How near the average has to be to count as arrived: 1 lb, stored in kg.
 *
 * Stated by the brief rather than measured. 1 lb is 0.4536 kg and 0.5 kg is 1.10 lb; the
 * rounder kilogram figure is what the app stores and compares, so the constant is 0.5.
 */
export const MAINTAIN_TOLERANCE_KG = 0.5;

/** One weigh-in is noise. Three in a week is the smallest window that is a trend. */
export const MIN_MAINTAIN_READINGS = 3;

/** How long a dismissal lasts, unless the average crosses the target first. */
export const MAINTAIN_QUIET_DAYS = 7;

/** A dismissed suggestion, remembered per account on this device. */
export interface MaintainDismissal {
  /** The target it was dismissed against. A new target is a new question. */
  targetKg: number;
  /** The 7-day average on the day it was dismissed, which decides "crossed since". */
  averageKg: number;
  /** YYYY-MM-DD in the profile's zone, the same day spine every other date uses. */
  dismissedOn: string;
}

export interface MaintainSuggestion {
  averageKg: number;
  /**
   * True when the average is past the target rather than beside it, so the notice can say
   * "past" instead of "at". The two are the same decision; only the sentence differs.
   */
  crossed: boolean;
}

export const MAINTAIN_DISMISS_KEY_PREFIX = "nutritrack.maintain-dismissed";

function keyFor(userId: string): string {
  return `${MAINTAIN_DISMISS_KEY_PREFIX}.${userId}`;
}

function isDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Whole days between two YYYY-MM-DD strings, read in UTC so a DST change cannot skew it. */
function daysBetween(from: string, to: string): number | null {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from);
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(to);
  if (!a || !b) return null;
  const start = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const end = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  return Math.round((end - start) / 86_400_000);
}

/** Whether the average has reached the target from the direction the goal is walking. */
function hasReached(goal: Goal, averageKg: number, targetKg: number): boolean {
  return goal === "lose" ? averageKg <= targetKg : averageKg >= targetKg;
}

export function maintainSuggestion(input: {
  goal: Goal | null;
  averageKg: number | null;
  readings: number;
  targetKg: number | null;
  dismissed: MaintainDismissal | null;
  today: string;
}): MaintainSuggestion | null {
  const { goal, averageKg, readings, targetKg, dismissed, today } = input;
  if (goal !== "lose" && goal !== "gain") return null;
  if (averageKg === null || targetKg === null) return null;
  if (!Number.isFinite(averageKg) || !Number.isFinite(targetKg)) return null;
  if (readings < MIN_MAINTAIN_READINGS) return null;

  const reached = hasReached(goal, averageKg, targetKg);
  // Rounded to the stored precision before comparing, so an average of 70.5 against 70
  // is inside the tolerance rather than 0.5000000001 outside it.
  const gap = Math.abs(Math.round((averageKg - targetKg) * 100) / 100);
  const within = gap <= MAINTAIN_TOLERANCE_KG;
  if (!reached && !within) return null;

  if (dismissed !== null && dismissed.targetKg === targetKg) {
    const days = daysBetween(dismissed.dismissedOn, today);
    // Only an approach that has since arrived is an interruption. A dismissal made while
    // the average was already past the target stays quiet for its week.
    const crossedSince = !hasReached(goal, dismissed.averageKg, targetKg) && reached;
    if (days !== null && days < MAINTAIN_QUIET_DAYS && !crossedSince) return null;
  }

  return { averageKg, crossed: reached && !within };
}

/** The dismissal stored for this account, if it is a shape we recognise. */
export function readMaintainDismissal(
  userId: string,
  storage: Storage | null = typeof window === "undefined" ? null : window.localStorage,
): MaintainDismissal | null {
  if (storage === null || userId === "") return null;
  try {
    const raw = storage.getItem(keyFor(userId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const targetKg = record["targetKg"];
    const averageKg = record["averageKg"];
    const dismissedOn = record["dismissedOn"];
    if (typeof targetKg !== "number" || !Number.isFinite(targetKg)) return null;
    if (typeof averageKg !== "number" || !Number.isFinite(averageKg)) return null;
    if (!isDay(dismissedOn)) return null;
    return { targetKg, averageKg, dismissedOn };
  } catch {
    // A storage that refuses to be read is the same as one with nothing in it.
    return null;
  }
}

export function saveMaintainDismissal(
  userId: string,
  dismissal: MaintainDismissal,
  storage: Storage | null = typeof window === "undefined" ? null : window.localStorage,
): void {
  if (storage === null || userId === "") return;
  try {
    storage.setItem(keyFor(userId), JSON.stringify(dismissal));
  } catch {
    // Private browsing can refuse the write. The notice would come back on the next
    // load, which is worse than remembering it but better than breaking the screen.
  }
}
