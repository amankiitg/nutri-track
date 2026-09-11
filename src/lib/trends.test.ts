import { describe, expect, it } from "vitest";
import {
  bucketFor,
  bucketTick,
  clampEnd,
  containsToday,
  isEmptyPeriod,
  macroShares,
  periodFor,
  periodLabel,
  shiftPeriod,
  type Period,
  type PeriodTotals,
} from "./trends";

const TODAY = "2026-09-11"; // a Friday

describe("periodFor", () => {
  it("gives the Monday-to-Sunday week containing the date", () => {
    // 2026-09-11 is a Friday, so the week runs 07-13.
    expect(periodFor("week", TODAY)).toEqual({ start: "2026-09-07", end: "2026-09-13" });
  });

  it("puts a Sunday in the week that began six days earlier, not the next one", () => {
    // The classic off-by-one: with a Sunday-start convention this would be 13-19.
    expect(periodFor("week", "2026-09-13")).toEqual({ start: "2026-09-07", end: "2026-09-13" });
    expect(periodFor("week", "2026-09-14")).toEqual({ start: "2026-09-14", end: "2026-09-20" });
  });

  it("gives the whole calendar month, including days still to come", () => {
    expect(periodFor("month", TODAY)).toEqual({ start: "2026-09-01", end: "2026-09-30" });
  });

  it("gives the whole calendar year", () => {
    expect(periodFor("year", TODAY)).toEqual({ start: "2026-01-01", end: "2026-12-31" });
  });

  it("handles February in a leap year", () => {
    expect(periodFor("month", "2028-02-10")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    expect(periodFor("month", "2026-02-10")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
  });
});

describe("shiftPeriod", () => {
  it("steps a week at a time from the period's own start", () => {
    // Shifting the *anchor* back a week would give Friday 2026-09-04, which is still the
    // week 08-31..09-06 — navigation that looks like it works and never moves.
    const period = periodFor("week", TODAY);
    expect(shiftPeriod("week", period, -1)).toEqual({ start: "2026-08-31", end: "2026-09-06" });
    expect(shiftPeriod("week", period, 1)).toEqual({ start: "2026-09-14", end: "2026-09-20" });
  });

  it("steps a month at a time without drifting off the first", () => {
    const period = periodFor("month", TODAY);
    expect(shiftPeriod("month", period, -1)).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(shiftPeriod("month", period, 1)).toEqual({ start: "2026-10-01", end: "2026-10-31" });
  });

  it("steps across a year boundary", () => {
    const period = periodFor("month", "2026-01-15");
    expect(shiftPeriod("month", period, -1)).toEqual({ start: "2025-12-01", end: "2025-12-31" });
  });

  it("steps a year at a time", () => {
    const period = periodFor("year", TODAY);
    expect(shiftPeriod("year", period, -1)).toEqual({ start: "2025-01-01", end: "2025-12-31" });
  });

  it("round-trips: forward then back is where it started", () => {
    for (const granularity of ["week", "month", "year"] as const) {
      const period = periodFor(granularity, TODAY);
      expect(shiftPeriod(granularity, shiftPeriod(granularity, period, -1), 1)).toEqual(period);
    }
  });

  it("survives a month whose length differs, going both ways", () => {
    const march = periodFor("month", "2026-03-31");
    expect(shiftPeriod("month", march, -1)).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(shiftPeriod("month", march, 1)).toEqual({ start: "2026-04-01", end: "2026-04-30" });
  });
});

describe("periodLabel", () => {
  it("names a week inside one month without repeating the month", () => {
    expect(periodLabel("week", { start: "2026-09-07", end: "2026-09-13" })).toBe("7–13 Sept 2026");
  });

  it("names both months for a week that straddles one", () => {
    expect(periodLabel("week", { start: "2026-08-31", end: "2026-09-06" })).toBe(
      "31 Aug – 6 Sept 2026",
    );
  });

  it("names both years for a week that straddles one", () => {
    expect(periodLabel("week", { start: "2025-12-29", end: "2026-01-04" })).toBe(
      "29 Dec 2025 – 4 Jan 2026",
    );
  });

  it("names a month and a year", () => {
    expect(periodLabel("month", { start: "2026-09-01", end: "2026-09-30" })).toBe("September 2026");
    expect(periodLabel("year", { start: "2026-01-01", end: "2026-12-31" })).toBe("2026");
  });
});

describe("clampEnd", () => {
  it("stops the range at today rather than asking for the future", () => {
    // Unclamped, the rest of September would come back as a zero row per day and drag
    // every average in the period towards zero.
    expect(clampEnd(periodFor("month", TODAY), TODAY)).toEqual({
      start: "2026-09-01",
      end: "2026-09-11",
    });
  });

  it("leaves a period that is entirely in the past alone", () => {
    const past: Period = { start: "2026-08-01", end: "2026-08-31" };
    expect(clampEnd(past, TODAY)).toEqual(past);
  });

  it("leaves a period that ends today exactly alone", () => {
    const past: Period = { start: "2026-09-05", end: TODAY };
    expect(clampEnd(past, TODAY)).toEqual(past);
  });
});

describe("containsToday", () => {
  it("knows which period is the current one", () => {
    expect(containsToday(periodFor("week", TODAY), TODAY)).toBe(true);
    expect(containsToday(periodFor("week", "2026-08-10"), TODAY)).toBe(false);
  });

  it("counts the boundary days as inside", () => {
    expect(containsToday({ start: TODAY, end: TODAY }, TODAY)).toBe(true);
  });
});

describe("isEmptyPeriod", () => {
  const totals = (over: Partial<PeriodTotals> = {}): PeriodTotals => ({
    days_logged: 0,
    days_judged: 0,
    days_on_track: 0,
    adherence_pct: null,
    avg_calories: null,
    avg_target_calories: null,
    avg_protein_g: null,
    avg_target_protein_g: null,
    avg_carbs_g: null,
    avg_fat_g: null,
    protein_kcal: null,
    carbs_kcal: null,
    fat_kcal: null,
    total_meals: 0,
    ...over,
  });

  const bucket = (mealCount: number) => ({
    bucket_start: "2026-09-11",
    bucket_end: "2026-09-11",
    bucket_days: 1,
    days_logged: mealCount > 0 ? 1 : 0,
    meal_count: mealCount,
    calories: 0,
    protein_kcal: 0,
    carbs_kcal: 0,
    fat_kcal: 0,
    target_calories: null,
    avg_calories: null,
    avg_target_calories: null,
    avg_protein_g: null,
    avg_carbs_g: null,
    avg_fat_g: null,
    status: null,
  });

  const emptyPeriod = (over: Partial<Parameters<typeof isEmptyPeriod>[0]> = {}) => ({
    start: "2026-09-01",
    end: "2026-09-11",
    bucket: "day",
    window_days: 11,
    buckets: [bucket(0)],
    totals: totals(),
    ...over,
  });

  it("is empty with no meals anywhere in the period", () => {
    expect(isEmptyPeriod(emptyPeriod())).toBe(true);
  });

  it("is not empty once a single bucket has a meal", () => {
    expect(
      isEmptyPeriod(
        emptyPeriod({
          buckets: [bucket(0), bucket(1)],
          totals: totals({ days_logged: 1, total_meals: 1 }),
        }),
      ),
    ).toBe(false);
  });
});

describe("bucketFor", () => {
  it("buckets a year by week and the shorter views by day", () => {
    // A year of daily bars is 254 of them; a year of weekly bars is ~37.
    expect(bucketFor("year")).toBe("week");
    expect(bucketFor("month")).toBe("day");
    expect(bucketFor("week")).toBe("day");
  });
});

describe("bucketTick", () => {
  it("uses a bare day number for a day bucket", () => {
    expect(bucketTick("2026-09-11", "day")).toBe("11");
  });

  it("carries the month for a week bucket", () => {
    // Weekly ticks reading "07", "14", "21" repeat and say nothing about which month
    // they belong to, which is the problem the bucketing exists to solve.
    expect(bucketTick("2026-09-07", "week")).toBe("7 Sept");
    expect(bucketTick("2026-10-05", "week")).toBe("5 Oct");
  });

  it("returns the input unchanged if it is not a date", () => {
    expect(bucketTick("nonsense", "week")).toBe("nonsense");
  });
});

describe("macroShares", () => {
  const totals = (over: Partial<PeriodTotals>): PeriodTotals => ({
    days_logged: 3,
    days_judged: 3,
    days_on_track: 2,
    adherence_pct: 67,
    avg_calories: 1533,
    avg_target_calories: 1879,
    avg_protein_g: 81.7,
    avg_target_protein_g: 117.3,
    avg_carbs_g: 156.7,
    avg_fat_g: 53.3,
    protein_kcal: 327,
    carbs_kcal: 627,
    fat_kcal: 480,
    total_meals: 4,
    ...over,
  });

  it("splits the ring by energy, not by weight", () => {
    // The real figures from a verified run: 327 + 627 + 480 = 1434 kcal.
    const shares = macroShares(totals({}));
    expect(shares).not.toBeNull();
    expect(shares?.map((s) => s.kcal)).toEqual([327, 627, 480]);
    expect(shares?.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 10);
    expect(shares?.[1]?.share).toBeCloseTo(627 / 1434, 10);
  });

  it("refuses to draw an empty ring", () => {
    // Three zero slices render as nothing at all, which looks like a failure rather than
    // an honest "no data".
    expect(macroShares(totals({ protein_kcal: 0, carbs_kcal: 0, fat_kcal: 0 }))).toBeNull();
    expect(
      macroShares(totals({ protein_kcal: null, carbs_kcal: null, fat_kcal: null })),
    ).toBeNull();
  });

  it("keeps the order protein, carbs, fat so the colours stay put", () => {
    expect(macroShares(totals({}))?.map((s) => s.key)).toEqual(["protein", "carbs", "fat"]);
  });
});
