/**
 * The export, where the mistakes live: quoting, day boundaries, sums, and the zip bytes.
 *
 * The queries are exercised against a fake client that records what was asked for, because "only
 * my rows" is a property of the request as well as of the policy: the user id is in the filter,
 * and a test that did not look at the filter would not notice it going missing.
 */
import { describe, expect, it, vi } from "vitest";

const { fromMock, calls } = vi.hoisted(() => {
  type Recorded = { table: string; select: string; filters: [string, unknown][] };
  const calls: Recorded[] = [];
  const tables: Record<string, unknown[]> = {};
  function builder(table: string) {
    const recorded: Recorded = { table, select: "", filters: [] };
    const chain: Record<string, unknown> = {};
    const pass = (name: string) => (columnOrValue: string, value?: unknown) => {
      if (name === "select") recorded.select = columnOrValue;
      else recorded.filters.push([name === "order" ? `order:${columnOrValue}` : name, value]);
      return chain;
    };
    for (const name of ["select", "eq", "is", "lte", "gte", "in", "order"])
      chain[name] = pass(name);
    chain["then"] = (resolve: (value: { data: unknown[]; error: null }) => void) => {
      calls.push(recorded);
      resolve({ data: tables[table] ?? [], error: null });
    };
    return chain;
  }
  const fromMock = vi.fn((table: string) => builder(table));
  return { fromMock, calls, tables } as unknown as {
    fromMock: (table: string) => unknown;
    calls: { table: string; select: string; filters: [string, unknown][] }[];
    tables: Record<string, unknown[]>;
  };
});

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: fromMock } }));

import {
  buildExportRows,
  dailyTotals,
  escapeCsv,
  exportRangeStart,
  fetchExportData,
  mealsCsv,
  totalsCsv,
  zipStore,
  type ExportedItem,
  type ExportedMeal,
} from "./export-data";

const MEAL: ExportedMeal = {
  id: "m1",
  local_date: "2026-11-18",
  eaten_at: "2026-11-18T23:30:00Z",
  meal_type: "dinner",
};

const ITEM: ExportedItem = {
  meal_id: "m1",
  name: "Porridge",
  quantity: 2,
  unit: "tbsp",
  grams: null,
  calories: 210.5,
  protein_g: 8,
  carbs_g: 30,
  fat_g: 5.5,
  fiber_g: 4,
};

describe("escapeCsv", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(escapeCsv("Porridge, with honey")).toBe(String.raw`"Porridge, with honey"`);
    expect(escapeCsv('He said "hi"')).toBe(String.raw`"He said ""hi"""`);
    expect(escapeCsv("two\nlines")).toBe(String.raw`"two
lines"`);
  });

  it("disarms a formula without touching numbers", () => {
    expect(escapeCsv('=HYPERLINK("http://x")').startsWith(String.raw`"'=`)).toBe(true);
    expect(escapeCsv("+1 banana")).toBe("'+1 banana");
    expect(escapeCsv("@here")).toBe("'@here");
    // A number is written as it is: an apostrophe would turn -3 into text.
    expect(escapeCsv(-3)).toBe("-3");
    expect(escapeCsv(0)).toBe("0");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeCsv("Greek yogurt")).toBe("Greek yogurt");
    expect(escapeCsv("2 tbsp")).toBe("2 tbsp");
  });
});

describe("exportRangeStart", () => {
  it("counts today as part of a last-N-days range", () => {
    expect(exportRangeStart("7", "2026-11-19")).toBe("2026-11-13");
    expect(exportRangeStart("30", "2026-11-19")).toBe("2026-10-21");
  });

  it("has no start for all time, and no date for a day that is not one", () => {
    expect(exportRangeStart("all", "2026-11-19")).toBeNull();
    expect(exportRangeStart("7", "")).toBeNull();
  });

  it("crosses a year boundary without arithmetic of its own", () => {
    expect(exportRangeStart("7", "2027-01-02")).toBe("2026-12-27");
  });
});

describe("buildExportRows", () => {
  it("prints the time on the profile clock, and the portion as it was said", () => {
    const rows = buildExportRows([MEAL], [ITEM], "America/New_York");

    // 23:30 UTC is 18:30 in New York, on the same day.
    expect(rows).toEqual([
      {
        date: "2026-11-18",
        time: "18:30",
        meal: "dinner",
        item: "Porridge",
        portion: "2 tbsp",
        kcal: 210.5,
        protein: 8,
        carbs: 30,
        fat: 5.5,
        fibre: 4,
      },
    ]);
  });

  it("falls back to grams when no portion was typed, and to zero when fibre is unknown", () => {
    const rows = buildExportRows(
      [MEAL],
      [{ ...ITEM, quantity: null, unit: null, grams: 150.4, fiber_g: null }],
      "UTC",
    );
    expect(rows[0]?.portion).toBe("150 g");
    expect(rows[0]?.fibre).toBe(0);
  });

  it("drops an item whose meal is outside the export", () => {
    const rows = buildExportRows([MEAL], [{ ...ITEM, meal_id: "elsewhere" }], "UTC");
    expect(rows).toEqual([]);
  });

  it("orders the week by day and then by clock", () => {
    const later: ExportedMeal = {
      ...MEAL,
      id: "m2",
      local_date: "2026-11-19",
      eaten_at: "2026-11-19T12:00:00Z",
    };
    const rows = buildExportRows([later, MEAL], [{ ...ITEM, meal_id: "m2" }, ITEM], "UTC");
    expect(rows.map((row) => row.date)).toEqual(["2026-11-18", "2026-11-19"]);
  });
});

describe("dailyTotals", () => {
  it("adds up to the item rows, per day", () => {
    const second: ExportedItem = {
      ...ITEM,
      name: "Banana",
      calories: 100,
      protein_g: 1,
      carbs_g: 22,
      fat_g: 0.2,
      fiber_g: 3,
    };
    const rows = buildExportRows([MEAL], [ITEM, second], "UTC");
    const totals = dailyTotals(rows);

    expect(totals).toHaveLength(1);
    expect(totals[0]?.kcal).toBeCloseTo(310.5, 6);
    expect(totals[0]?.protein).toBeCloseTo(9, 6);
    expect(totals[0]?.carbs).toBeCloseTo(52, 6);
    expect(totals[0]?.fat).toBeCloseTo(5.7, 6);
    expect(totals[0]?.fibre).toBeCloseTo(7, 6);
  });

  it("has nothing to say about a range with no rows", () => {
    expect(dailyTotals([])).toEqual([]);
  });
});

describe("the CSV files", () => {
  it("are headers alone when the range is empty", () => {
    expect(mealsCsv([])).toBe("date,time,meal,item,portion,kcal,protein,carbs,fat,fibre\n");
    expect(totalsCsv([])).toBe("date,kcal,protein,carbs,fat,fibre\n");
  });

  it("carry one line per item and one per day", () => {
    const rows = buildExportRows([MEAL], [ITEM], "UTC");
    expect(mealsCsv(rows).split("\n")).toHaveLength(3);
    expect(mealsCsv(rows).split("\n")[1]).toBe(
      "2026-11-18,23:30,dinner,Porridge,2 tbsp,210.5,8,30,5.5,4",
    );
    expect(totalsCsv(dailyTotals(rows)).split("\n")[1]).toBe("2026-11-18,210.5,8,30,5.5,4");
  });

  it("quote an item name that would break the columns", () => {
    const rows = buildExportRows([MEAL], [{ ...ITEM, name: 'Porridge, "honey"' }], "UTC");
    expect(mealsCsv(rows)).toContain(String.raw`"Porridge, ""honey"""`);
  });
});

describe("the zip", () => {
  const bytes = zipStore([
    { name: "meals.csv", text: "date,time\n2026-11-18,23:30\n" },
    { name: "daily-totals.csv", text: "date,kcal\n2026-11-18,210.5\n" },
  ]);

  it("is a zip: local header, end of central directory, both names", () => {
    const start = String.fromCharCode(...bytes.slice(0, 4));
    expect(start).toBe("PK" + String.fromCharCode(3, 4));
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("meals.csv");
    expect(text).toContain("daily-totals.csv");
    expect(text).toContain("2026-11-18,23:30");
    // 0x06054b50 at the end, with two entries recorded (offset 10 is the entry count).
    const eocd = bytes.length - 22;
    expect(bytes[eocd]).toBe(0x50);
    expect(bytes[eocd + 1]).toBe(0x4b);
    expect(bytes[eocd + 2]).toBe(0x05);
    expect(bytes[eocd + 3]).toBe(0x06);
    expect(bytes[eocd + 10]! | (bytes[eocd + 11]! << 8)).toBe(2);
  });

  it("is byte-identical for the same input", () => {
    const again = zipStore([
      { name: "meals.csv", text: "date,time\n2026-11-18,23:30\n" },
      { name: "daily-totals.csv", text: "date,kcal\n2026-11-18,210.5\n" },
    ]);
    expect(Array.from(again)).toEqual(Array.from(bytes));
  });
});

describe("fetchExportData", () => {
  it("asks for this user's meals in the range, and nothing else", async () => {
    calls.length = 0;
    await fetchExportData({ userId: "user-1", from: "2026-11-13", to: "2026-11-19" });

    const meals = calls.find((call) => call.table === "meals");
    expect(meals?.filters).toContainEqual(["eq", "user-1"]);
    expect(meals?.filters).toContainEqual(["gte", "2026-11-13"]);
    expect(meals?.filters).toContainEqual(["lte", "2026-11-19"]);
    expect(meals?.filters).toContainEqual(["is", null]);
  });

  it("drops the lower bound for all time rather than inventing an early date", async () => {
    calls.length = 0;
    await fetchExportData({ userId: "user-1", from: null, to: "2026-11-19" });

    const meals = calls.find((call) => call.table === "meals");
    expect(meals?.filters.some(([name]) => name === "gte")).toBe(false);
  });
});
