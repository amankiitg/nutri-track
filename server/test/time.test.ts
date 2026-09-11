import { describe, expect, it } from "vitest";
import {
  isValidTimeZone,
  localDateOf,
  nextLocalMidnight,
  safeTimeZone,
  secondsUntilNextLocalMidnight,
  startOfLocalDay,
  zoneOffsetMs,
} from "../src/time";

const HOUR = 3_600_000;

describe("zoneOffsetMs", () => {
  it.each([
    ["UTC", 0],
    ["Pacific/Auckland", 13 * HOUR], // NZDT, UTC+13, until early April
    ["America/New_York", -5 * HOUR], // EST, before the 8 March changeover
    ["Asia/Kolkata", 5.5 * HOUR], // half-hour offset, the case that breaks naive parsing
  ])("reports %s as %i ms", (timeZone, expected) => {
    expect(zoneOffsetMs(new Date("2026-03-02T12:00:00Z"), timeZone)).toBe(expected);
  });

  it("tracks a DST changeover", () => {
    // US DST starts 2026-03-08. The offset differs either side of it.
    expect(zoneOffsetMs(new Date("2026-03-08T05:00:00Z"), "America/New_York")).toBe(-5 * HOUR);
    expect(zoneOffsetMs(new Date("2026-03-08T08:00:00Z"), "America/New_York")).toBe(-4 * HOUR);
  });
});

describe("localDateOf", () => {
  it("is the date in the profile's zone, not the server's", () => {
    const instant = new Date("2026-03-01T23:30:00Z");
    expect(localDateOf(instant, "UTC")).toEqual({ year: 2026, month: 3, day: 1 });
    expect(localDateOf(instant, "Pacific/Auckland")).toEqual({ year: 2026, month: 3, day: 2 });
  });
});

describe("startOfLocalDay", () => {
  it("finds UTC midnight", () => {
    expect(startOfLocalDay(new Date("2026-03-02T12:34:56Z"), "UTC").toISOString()).toBe(
      "2026-03-02T00:00:00.000Z",
    );
  });

  it("is 11:00 the previous day in UTC when it is midnight in Auckland", () => {
    expect(
      startOfLocalDay(new Date("2026-03-01T23:30:00Z"), "Pacific/Auckland").toISOString(),
    ).toBe("2026-03-01T11:00:00.000Z");
  });

  it("is 05:00 UTC when it is midnight in New York, which is UTC-5", () => {
    // 02:00Z on 2 March is 21:00 on 1 March in New York, so the local day is the 1st,
    // and it opened at 00:00 EST = 05:00Z.
    expect(
      startOfLocalDay(new Date("2026-03-02T02:00:00Z"), "America/New_York").toISOString(),
    ).toBe("2026-03-01T05:00:00.000Z");
  });

  it("uses the offset in force at midnight, not the one in force now", () => {
    // 2026-03-08 is 23 hours long in New York: midnight was EST, the next midnight is EDT.
    const midDay = new Date("2026-03-08T17:00:00Z");
    expect(startOfLocalDay(midDay, "America/New_York").toISOString()).toBe(
      "2026-03-08T05:00:00.000Z",
    );
    expect(nextLocalMidnight(midDay, "America/New_York").toISOString()).toBe(
      "2026-03-09T04:00:00.000Z",
    );
  });

  it("rolls over a month and a year boundary", () => {
    const newYear = new Date("2026-12-31T20:00:00Z");
    expect(nextLocalMidnight(newYear, "America/New_York").toISOString()).toBe(
      "2027-01-01T05:00:00.000Z",
    );
  });

  it("is idempotent for an instant that is already local midnight", () => {
    const midnight = startOfLocalDay(new Date("2026-03-02T12:00:00Z"), "Pacific/Auckland");
    expect(startOfLocalDay(midnight, "Pacific/Auckland").getTime()).toBe(midnight.getTime());
  });
});

describe("secondsUntilNextLocalMidnight", () => {
  it("counts the remaining seconds of the local day", () => {
    expect(secondsUntilNextLocalMidnight(new Date("2026-03-02T23:00:00Z"), "UTC")).toBe(3600);
  });

  it("never returns zero, even at the last moment of the day", () => {
    expect(
      secondsUntilNextLocalMidnight(new Date("2026-03-02T23:59:59.500Z"), "UTC"),
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("safeTimeZone", () => {
  it("passes through a zone ICU recognises", () => {
    expect(safeTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
  });

  it("falls back to UTC for null, undefined and nonsense", () => {
    expect(safeTimeZone(null)).toBe("UTC");
    expect(safeTimeZone(undefined)).toBe("UTC");
    expect(safeTimeZone("Mars/Olympus_Mons")).toBe("UTC");
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
  });
});
