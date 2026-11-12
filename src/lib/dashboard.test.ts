import { describe, expect, it } from "vitest";
import {
  formatTimeInZone,
  macroFraction,
  mealTypeLabel,
  quantityLabel,
  ringGeometry,
  sortTimeline,
  targetZone,
  verdictHasNumbers,
  verdictSentence,
  verdictWindowLabel,
  weekdayName,
  weightDelta,
  weightLogRow,
  type TimelineItem,
  type TimelineMeal,
  type WeekVerdict,
} from "./dashboard";

describe("targetZone", () => {
  // One rule for the calorie ring and every macro bar, so "over" means the same thing on the
  // whole screen. 110% is the same boundary `calorie_status` calls "over" in the database, which
  // is the rule the verdict line has used all along.
  it("is under while the target is not reached", () => {
    expect(targetZone(47, 48)).toBe("under");
    expect(targetZone(48, 48)).toBe("under");
  });

  it("warns once the target is passed, and reddens only past 110%", () => {
    expect(targetZone(49, 48)).toBe("near");
    expect(targetZone(52, 48)).toBe("near"); // 108%
    expect(targetZone(53, 48)).toBe("over"); // 110.4%
    expect(targetZone(80, 48)).toBe("over"); // the fat day from the report, 167%
  });

  it("has no opinion without a target, rather than calling it under", () => {
    expect(targetZone(0, null)).toBeNull();
    expect(targetZone(500, 0)).toBeNull();
  });
});

const verdict = (over: Partial<WeekVerdict> = {}): WeekVerdict => ({
  window_days: 7,
  window_start: "2026-10-31",
  window_end: "2026-11-06",
  days_logged: 0,
  days_judged: 0,
  days_on_track: 0,
  avg_calories: null,
  avg_target_calories: null,
  avg_protein_g: null,
  avg_target_protein_g: null,
  avg_fiber_g: null,
  avg_target_fiber_g: null,
  verdict: "no_data",
  ...over,
});

describe("ringGeometry", () => {
  it("reports how far round the ring goes", () => {
    expect(ringGeometry(818, 1636).fraction).toBeCloseTo(0.5);
  });

  it("clamps a day past the target to a full ring rather than overflowing it", () => {
    // The ring is a shape, not a bar chart: a fraction above 1 would draw back over
    // the start of the circle and read as "barely started".
    expect(ringGeometry(2000, 1636).fraction).toBe(1);
  });

  it("separates the overage from the remainder", () => {
    const over = ringGeometry(2000, 1636);
    expect(over.over).toBe(364);
    expect(over.remaining).toBe(-364);
  });

  it("has no opinion without a target", () => {
    expect(ringGeometry(500, null)).toEqual({ fraction: 0, over: 0, remaining: null });
  });

  it("treats a zero target as no target rather than dividing by it", () => {
    expect(ringGeometry(500, 0)).toEqual({ fraction: 0, over: 0, remaining: null });
  });

  it("handles a day with nothing eaten", () => {
    expect(ringGeometry(0, 1636)).toEqual({ fraction: 0, over: 0, remaining: 1636 });
  });
});

describe("macroFraction", () => {
  it("is the proportion of the target", () => {
    expect(macroFraction(56, 112)).toBeCloseTo(0.5);
  });

  it("does not overflow the bar", () => {
    expect(macroFraction(200, 112)).toBe(1);
  });

  it("is null without a target, so the bar can be drawn as unknown", () => {
    expect(macroFraction(56, null)).toBeNull();
    expect(macroFraction(56, 0)).toBeNull();
  });
});

describe("weekdayName", () => {
  // The bug this guards against: `new Date("2026-09-11")` is UTC midnight, which in
  // New York is still the 10th, so a naive formatter labels today "Thu". These dates
  // are asserted against their UTC weekdays, which is what the calendar says.
  it.each([
    ["2026-09-11", "Fri"],
    ["2026-09-07", "Mon"],
    ["2026-01-01", "Thu"],
    ["2025-12-31", "Wed"],
    ["2026-02-28", "Sat"],
  ])("calls %s %s", (date, expected) => {
    expect(weekdayName(date)).toBe(expected);
  });

  it("returns nothing for a value that is not a date", () => {
    expect(weekdayName("")).toBe("");
    expect(weekdayName("today")).toBe("");
    expect(weekdayName("2026-9-1")).toBe("");
  });
});

describe("formatTimeInZone", () => {
  it("uses the profile's zone, not the device's", () => {
    // 04:30 UTC is 00:30 in New York and 14:30 in Auckland: the same instant, three
    // different days in the third case. The app resolves days in the profile's zone
    // everywhere else, so the timeline must agree with the totals above it.
    const iso = "2026-09-11T04:30:00.000Z";
    expect(formatTimeInZone(iso, "America/New_York")).toBe("00:30");
    expect(formatTimeInZone(iso, "Pacific/Auckland")).toBe("16:30");
    expect(formatTimeInZone(iso, "UTC")).toBe("04:30");
  });

  it("returns nothing for an unparseable timestamp", () => {
    expect(formatTimeInZone("not a time", "UTC")).toBe("");
  });
});

describe("verdictSentence", () => {
  it("says plainly when nothing has been logged", () => {
    expect(verdictSentence(verdict())).toBe("Nothing logged in the last 7 days yet.");
  });

  it("distinguishes no target from no data", () => {
    const sentence = verdictSentence(verdict({ verdict: "no_target", days_logged: 4 }));
    expect(sentence).toContain("4 days logged");
    expect(sentence).toContain("no target");
  });

  it("refuses to call one comparable day a trend", () => {
    // This is the state the real database produced first: four days of food, one of
    // them with a target, and an average of 800 kcal that looked like a verdict.
    const sentence = verdictSentence(
      verdict({ verdict: "too_few_days", days_logged: 4, days_judged: 1 }),
    );
    expect(sentence).toContain("Only 1 of the last 7 days has both meals and a target");
    expect(sentence).not.toContain("Averaging");
  });

  it("agrees the verb with the count, not with the window", () => {
    // Seen on screen: "Only 1 of the last 7 day has". The noun counts the window and
    // stays plural; only the verb follows the number judged.
    expect(verdictSentence(verdict({ verdict: "too_few_days", days_judged: 2 }))).toContain(
      "Only 2 of the last 7 days have both meals and a target",
    );
  });

  it("reports both averages when there is a verdict to report", () => {
    const sentence = verdictSentence(
      verdict({
        verdict: "under",
        days_logged: 5,
        days_judged: 5,
        avg_calories: 1450,
        avg_target_calories: 1636,
      }),
    );
    expect(sentence).toBe(
      "Averaging 1,450 kcal over 5 of the last 7 days, against 1,636. Under target.",
    );
  });

  it("counts only the days that were judged when some days are missing", () => {
    // The case from the request: three days of food and a target in the window. The row's
    // `window_end` is yesterday, so today's part-day cannot be in these numbers; the subtitle
    // above the sentence already says the window is not counting today.
    const sentence = verdictSentence(
      verdict({
        verdict: "under",
        days_logged: 3,
        days_judged: 3,
        avg_calories: 1690,
        avg_target_calories: 1771,
      }),
    );
    expect(sentence).toContain("over 3 of the last 7 days");
    expect(sentence).not.toContain("a day");
    expect(sentence).not.toContain("over 4 of");
  });

  it("keeps the count when some days were not judged, whatever the verdict", () => {
    expect(
      verdictSentence(
        verdict({
          verdict: "over",
          days_logged: 4,
          days_judged: 4,
          avg_calories: 2000,
          avg_target_calories: 1771,
        }),
      ),
    ).toContain("over 4 of the last 7 days");
  });

  it('says "a day" instead of the count when every day was judged', () => {
    const sentence = verdictSentence(
      verdict({
        verdict: "on_track",
        days_logged: 7,
        days_judged: 7,
        avg_calories: 1768,
        avg_target_calories: 1717,
      }),
    );
    expect(sentence).toBe("Averaging 1,768 kcal a day, against 1,717. On target.");
    expect(sentence).not.toContain("of the last 7 days");
  });

  it("names the days it counted, so the window is not an article of faith", () => {
    expect(verdictWindowLabel(verdict())).toBe("31 Oct – 6 Nov");
    // A single day on both ends, and a year boundary, formatted without slipping a day.
    expect(
      verdictWindowLabel(verdict({ window_start: "2026-12-31", window_end: "2026-12-31" })),
    ).toBe("31 Dec – 31 Dec");
    expect(verdictWindowLabel(verdict({ window_start: "nope", window_end: "2026-11-06" }))).toBe(
      "",
    );
  });

  it("says on target when it is on target", () => {
    const sentence = verdictSentence(
      verdict({
        verdict: "on_track",
        days_logged: 7,
        days_judged: 7,
        avg_calories: 1600,
        avg_target_calories: 1636,
      }),
    );
    expect(sentence).toContain("On target.");
  });

  it("says over target when it is over", () => {
    const sentence = verdictSentence(
      verdict({
        verdict: "over",
        days_logged: 6,
        days_judged: 6,
        avg_calories: 2100,
        avg_target_calories: 1636,
      }),
    );
    expect(sentence).toContain("Over target.");
  });

  it("covers every state with a non-empty sentence", () => {
    for (const state of [
      "no_data",
      "no_target",
      "too_few_days",
      "under",
      "over",
      "on_track",
    ] as const) {
      const sentence = verdictSentence(verdict({ verdict: state, days_logged: 4, days_judged: 4 }));
      expect(sentence.length).toBeGreaterThan(0);
      expect(sentence.endsWith(".")).toBe(true);
    }
  });

  it("knows which verdicts have numbers behind them", () => {
    expect(verdictHasNumbers("on_track")).toBe(true);
    expect(verdictHasNumbers("under")).toBe(true);
    expect(verdictHasNumbers("over")).toBe(true);
    expect(verdictHasNumbers("no_data")).toBe(false);
    expect(verdictHasNumbers("no_target")).toBe(false);
    expect(verdictHasNumbers("too_few_days")).toBe(false);
  });
});

describe("mealTypeLabel", () => {
  it("capitalises the types the database stores", () => {
    expect(mealTypeLabel("breakfast")).toBe("Breakfast");
    expect(mealTypeLabel("snack")).toBe("Snack");
  });

  it("falls back to the raw value rather than showing nothing", () => {
    expect(mealTypeLabel("second breakfast")).toBe("second breakfast");
  });
});

const item = (over: Partial<TimelineItem> = {}): TimelineItem => ({
  id: "i1",
  name: "Hummus",
  quantity: null,
  unit: null,
  grams: null,
  calories: 90,
  protein_g: 3.8,
  carbs_g: 7.1,
  fat_g: 5.5,
  fiber_g: null,
  confidence: 0.8,
  user_edited: false,
  ...over,
});

const meal = (over: Partial<TimelineMeal> = {}): TimelineMeal => ({
  id: "m1",
  eaten_at: "2026-11-06T20:08:00Z",
  meal_type: "dinner",
  source: "photo",
  notes: null,
  photo_count: 1,
  calories: 420,
  protein_g: 30,
  carbs_g: 40,
  fat_g: 12,
  fiber_g: 5,
  item_count: 0,
  items: [],
  ...over,
});

describe("sortTimeline", () => {
  it("orders meals by when they were eaten, whatever order they arrived in", () => {
    const morning = meal({ id: "m-morning", eaten_at: "2026-11-06T08:00:00Z" });
    const evening = meal({ id: "m-evening", eaten_at: "2026-11-06T20:08:00Z" });

    expect(sortTimeline([evening, morning]).map((entry) => entry.id)).toEqual([
      "m-morning",
      "m-evening",
    ]);
  });

  it("breaks a tie with created_at, so two meals at one time keep the order they were logged", () => {
    // The same clock time is exactly when a list starts moving on its own.
    const first = meal({ id: "m-first", created_at: "2026-11-06T20:09:00Z" });
    const second = meal({ id: "m-second", created_at: "2026-11-06T20:10:00Z" });

    expect(sortTimeline([second, first]).map((entry) => entry.id)).toEqual(["m-first", "m-second"]);
  });

  it("falls back to the id when there is no created_at, which today's payload does not carry", () => {
    const later = meal({ id: "m-b" });
    const earlier = meal({ id: "m-a" });

    // Not the order it arrived in: the same two rows come back the same way every load.
    expect(sortTimeline([later, earlier]).map((entry) => entry.id)).toEqual(["m-a", "m-b"]);
  });

  it("orders items that share a created_at by id, so a meal does not shuffle inside itself", () => {
    const shared = "2026-11-06T20:08:05Z";
    const dinner = meal({
      items: [
        item({ id: "i-c", name: "Kombucha", created_at: shared }),
        item({ id: "i-a", name: "Bhel puri", created_at: shared }),
        item({ id: "i-b", name: "Arugula", created_at: shared }),
      ],
    });

    expect(sortTimeline([dinner])[0]?.items.map((entry) => entry.id)).toEqual([
      "i-a",
      "i-b",
      "i-c",
    ]);
  });

  it("keeps an item logged earlier ahead of one logged later in the same meal", () => {
    const dinner = meal({
      items: [
        item({ id: "i-later", created_at: "2026-11-06T20:09:00Z" }),
        item({ id: "i-earlier", created_at: "2026-11-06T20:08:30Z" }),
      ],
    });

    expect(sortTimeline([dinner])[0]?.items.map((entry) => entry.id)).toEqual([
      "i-earlier",
      "i-later",
    ]);
  });

  it("does not mutate what it was given", () => {
    const input = [meal({ id: "m-b" }), meal({ id: "m-a" })];

    sortTimeline(input);

    expect(input.map((entry) => entry.id)).toEqual(["m-b", "m-a"]);
  });
});

describe("weightLogRow", () => {
  const base = { userId: "u1", date: "2026-09-11", weightKg: 71.5 };

  it("always carries the weight and the day", () => {
    expect(weightLogRow(base)).toMatchObject({
      user_id: "u1",
      logged_on: "2026-09-11",
      weight_kg: 71.5,
      source: "manual",
    });
  });

  it("includes the waist when one was measured", () => {
    expect(weightLogRow({ ...base, waistCm: 80 })).toHaveProperty("waist_cm", 80);
  });

  it("omits the waist entirely when none was measured", () => {
    // The difference that matters: an upsert writes only the columns it is given, so an
    // absent key leaves an earlier measurement for the day intact, while an explicit
    // null erases it. Recording weight alone must not delete this morning's waist.
    const row = weightLogRow(base);
    expect(Object.hasOwn(row, "waist_cm")).toBe(false);
    expect(row.waist_cm).toBeUndefined();
  });

  it("treats an explicit undefined as not measured rather than as zero", () => {
    // Zero is not a waist, and the column's check constraint would reject it, which is
    // the right outcome — but only if we never send it.
    const row = weightLogRow({ ...base, waistCm: undefined });
    expect(Object.hasOwn(row, "waist_cm")).toBe(false);
  });
});

describe("weightDelta", () => {
  const entry = (loggedOn: string, kg: number) => ({
    logged_on: loggedOn,
    weight_kg: kg,
    waist_cm: null,
  });

  it("reports the change since the previous weigh-in", () => {
    expect(weightDelta([entry("2026-09-11", 71.5), entry("2026-09-10", 71.1)])).toBe(0.4);
    expect(weightDelta([entry("2026-09-11", 70.6), entry("2026-09-10", 71.1)])).toBe(-0.5);
  });

  it("says nothing when there is only one weigh-in", () => {
    expect(weightDelta([entry("2026-09-11", 71.5)])).toBeNull();
    expect(weightDelta([])).toBeNull();
  });

  it("says nothing when the change rounds away", () => {
    expect(weightDelta([entry("2026-09-11", 71.52), entry("2026-09-10", 71.5)])).toBeNull();
  });
});

describe("quantityLabel", () => {
  it("prefers what the parse recorded over the grams it guessed", () => {
    expect(quantityLabel(item({ quantity: 3, unit: "tbsp", grams: 50 }))).toBe("3 tbsp");
  });

  it("falls back to grams when there is no quantity", () => {
    expect(quantityLabel(item({ grams: 120.4 }))).toBe("120 g");
  });

  it("handles a count with no unit", () => {
    expect(quantityLabel(item({ quantity: 4 }))).toBe("4");
  });

  it("has nothing to say about an item with neither", () => {
    expect(quantityLabel(item())).toBeNull();
  });
});
