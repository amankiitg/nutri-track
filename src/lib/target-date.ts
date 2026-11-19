/**
 * When the target weight will be reached, and how to say it.
 *
 * One function, two screens. Settings prints a sentence under the pace options and the Trends
 * weight chart draws a dotted line at the target with the same date on its label; when those were
 * computed in two places they disagreed, and a date is exactly the kind of number a reader checks
 * against the other screen.
 *
 * What it projects from is the caller's decision, and the only thing the two screens differ on:
 * Settings passes the trailing 7-day average (one low morning after a salty dinner is a reading,
 * not a position), while onboarding passes the weight the person typed, because a new user has
 * no week to average. Everything after that — the arithmetic, the tolerance, the wording, the
 * date format — is the same code, so the two sentences cannot drift apart.
 */
import { MAINTAIN_TOLERANCE_KG } from "./maintain-suggestion";
import { projectedTargetDate, type Goal } from "./targets";
import { formatPace, formatWeight, type UnitSystem } from "./units";

export interface ReachTarget {
  /** The day the average is projected to meet the target. Null when it is already there. */
  date: Date | null;
  /** The average is at the target, within the same tolerance the notice uses, or past it. */
  atTarget: boolean;
}

export interface ReachInput {
  goal: Goal | null;
  /**
   * The weight to project from, in kilograms.
   *
   * Settings passes the trailing 7-day average, because one reading is noise. Onboarding passes
   * the weight the person just typed: a new user has no week to average, and the number they
   * gave is the only position there is. Null means neither, and the line is not shown.
   */
  basisKg: number | null;
  targetKg: number | null;
  paceKgPerWeek: number | null;
  /** The profile's own day, as YYYY-MM-DD. Never the device's. */
  today: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Noon on the profile's day, as a local Date.
 *
 * Noon rather than midnight because the day arithmetic adds whole days to it: a DST change moves
 * midnight by an hour and can land back on the previous day, and noon is as far from that edge as
 * a day gets.
 */
function noonOf(day: string): Date | null {
  if (!DAY.test(day)) return null;
  const at = new Date(`${day}T12:00:00`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The projection, or null when the question does not apply.
 *
 * Null for maintain (there is nowhere to arrive), for a missing average or target, and for a pace
 * that is not a speed. `atTarget` answers the case where the walk is over, which is not the same
 * as having nothing to say.
 */
export function reachTarget(input: ReachInput): ReachTarget | null {
  const { goal, basisKg, targetKg, paceKgPerWeek, today } = input;
  if (goal !== "lose" && goal !== "gain") return null;
  if (basisKg === null || targetKg === null) return null;
  if (!Number.isFinite(basisKg) || !Number.isFinite(targetKg)) return null;
  if (paceKgPerWeek === null || !Number.isFinite(paceKgPerWeek) || paceKgPerWeek <= 0) return null;

  // The same rule, and the same tolerance, as `maintainSuggestion`: the two say different things
  // about one moment, so they have to agree about when that moment is.
  const passed = goal === "lose" ? basisKg <= targetKg : basisKg >= targetKg;
  const gap = Math.abs(Math.round((basisKg - targetKg) * 100) / 100);
  if (passed || gap <= MAINTAIN_TOLERANCE_KG) return { date: null, atTarget: true };

  const from = noonOf(today);
  if (from === null) return null;
  const date = projectedTargetDate(basisKg, targetKg, paceKgPerWeek, from);
  return date === null ? null : { date, atTarget: false };
}

/**
 * "29 Nov", the day and the month with no year.
 *
 * A projection months out is still this year or the next one, and the year is the one digit that
 * makes the line longer without making it clearer. `en-GB` gives day then month, which is the
 * order every other date in the app that is not a full date already uses.
 */
export function formatReachDate(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** The Settings sentence, or null when there is no line to show. */
export function reachTargetSentence(input: ReachInput & { units: UnitSystem }): string | null {
  const reach = reachTarget(input);
  if (reach === null) return null;
  if (reach.atTarget) return "You're at your target.";
  if (reach.date === null || input.targetKg === null || input.paceKgPerWeek === null) return null;
  const target = formatWeight(input.targetKg, input.units);
  const pace = formatPace(input.paceKgPerWeek, input.units);
  return `You'll reach ${target} around ${formatReachDate(reach.date)} at ${pace}.`;
}

/**
 * The label on the Trends target line.
 *
 * Printed even when there is no date — a target is still a target when there is nothing to project
 * from, and the line is the useful part. The date is the same string the sentence carries.
 */
export function reachTargetLabel(input: ReachInput & { units: UnitSystem }): string | null {
  if (input.targetKg === null) return null;
  const target = `Target ${formatWeight(input.targetKg, input.units)}`;
  const reach = reachTarget(input);
  if (reach === null) return target;
  if (reach.atTarget) return `${target} · at target`;
  if (reach.date === null) return target;
  return `${target} · ${formatReachDate(reach.date)}`;
}
