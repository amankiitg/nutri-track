/**
 * Day boundaries in the user's own zone.
 *
 * The app already fixed one bug where the device zone and the profile zone
 * disagreed about which day it was, so the service asks Postgres for the profile's
 * timezone and does its date arithmetic in that zone. Everything here is pure and
 * takes an explicit timeZone, so it can be tested at instants that straddle a
 * boundary.
 *
 * Only Intl is used — no date library.
 */

/** The wall-clock offset of `timeZone` at `instant`, in milliseconds. */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(instant);
  const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  // ICU emits "GMT", "GMT+13:00", "GMT-04:00" and occasionally "GMT+5:30".
  const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(name);
  const sign = match?.[1];
  if (sign === undefined) return 0;
  const hours = Number(match?.[2] ?? 0);
  const minutes = Number(match?.[3] ?? 0);
  return (sign === "-" ? -1 : 1) * (hours * 60 + minutes) * 60_000;
}

/** True when ICU recognises the zone. Guards against a bad value in the database. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** Falls back to UTC rather than throwing on a timezone the database should not hold. */
export function safeTimeZone(timeZone: string | null | undefined): string {
  return timeZone && isValidTimeZone(timeZone) ? timeZone : "UTC";
}

interface LocalDate {
  year: number;
  month: number;
  day: number;
}

/** The calendar date it is in `timeZone` at `instant`. */
export function localDateOf(instant: Date, timeZone: string): LocalDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = (type: string): number => {
    const found = parts.find((part) => part.type === type)?.value;
    return found === undefined ? 0 : Number(found);
  };
  return { year: value("year"), month: value("month"), day: value("day") };
}

/**
 * The UTC instant at which the local day containing `offsetDays` from `instant`
 * begins. `Date.UTC` normalises an out-of-range day, so passing `day + 1` on the
 * last of the month is safe.
 *
 * The offset is resolved twice because the one in force at local midnight is not
 * always the one in force now: on a DST changeover they differ by an hour.
 */
function localMidnightUtc(instant: Date, timeZone: string, offsetDays: number): Date {
  const { year, month, day } = localDateOf(instant, timeZone);
  const naive = Date.UTC(year, month - 1, day + offsetDays);
  const firstGuess = new Date(naive - zoneOffsetMs(instant, timeZone));
  return new Date(naive - zoneOffsetMs(firstGuess, timeZone));
}

/** Midnight at the start of the local day containing `instant`. */
export function startOfLocalDay(instant: Date, timeZone: string): Date {
  return localMidnightUtc(instant, timeZone, 0);
}

/** Midnight at the start of the following local day. */
export function nextLocalMidnight(instant: Date, timeZone: string): Date {
  return localMidnightUtc(instant, timeZone, 1);
}

/**
 * Whole seconds until the local day rolls over, for `Retry-After`. Never zero, so
 * a client that retries immediately is not told to try again at once.
 */
export function secondsUntilNextLocalMidnight(instant: Date, timeZone: string): number {
  const seconds = Math.ceil(
    (nextLocalMidnight(instant, timeZone).getTime() - instant.getTime()) / 1000,
  );
  return Math.max(1, seconds);
}
