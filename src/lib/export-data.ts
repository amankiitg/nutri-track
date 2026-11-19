/**
 * "Export my data": the meals CSV, the daily totals CSV, and a zip of both.
 *
 * Everything here except `fetchExportData` is pure, so the parts that are easy to get wrong — the
 * CSV quoting, the day boundaries, the zip bytes — are testable without a browser or a database.
 * The fetch runs with the caller's own session and an explicit `user_id` filter on top of RLS: a
 * bug in one of the two should not be enough to hand somebody else's meals to a zip file.
 */
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { displayRounded, type UnitSystem } from "@/lib/units";

/** The three ranges the picker offers. `days` is null for everything there is. */
export const EXPORT_RANGES = [
  { id: "7", label: "Last 7 days", days: 7 },
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "all", label: "All time", days: null },
] as const;

export type ExportRangeId = (typeof EXPORT_RANGES)[number]["id"];

export const DEFAULT_EXPORT_RANGE: ExportRangeId = "30";

/**
 * What the picker offers to write. One file at a time; the name is this base plus the dates the
 * file covers, so two exports of different weeks do not arrive as the same filename.
 */
export const EXPORT_CONTENTS = [
  {
    id: "meals",
    label: "Meals",
    base: "meals",
    empty: "No meals are logged in that range.",
  },
  {
    id: "totals",
    label: "Daily totals",
    base: "daily-totals",
    empty: "No meals are logged in that range.",
  },
  {
    id: "weights",
    label: "Weights",
    base: "weights",
    empty: "No weigh-ins are logged in that range.",
  },
] as const;

export type ExportContentId = (typeof EXPORT_CONTENTS)[number]["id"];

export const DEFAULT_EXPORT_CONTENT: ExportContentId = "meals";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The first day of a range, inclusive, as YYYY-MM-DD, or null for all time.
 *
 * "Last 7 days" is today and the six before it: the day in progress counts, which is what a
 * person means when they say the last week. The arithmetic is done at noon so a DST change
 * cannot move the result onto the wrong day.
 */
export function exportRangeStart(range: ExportRangeId, today: string): string | null {
  const days = EXPORT_RANGES.find((option) => option.id === range)?.days ?? null;
  if (days === null) return null;
  const at = new Date(`${today}T12:00:00`);
  if (Number.isNaN(at.getTime())) return null;
  at.setDate(at.getDate() - (days - 1));
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export interface ExportedMeal {
  id: string;
  local_date: string;
  eaten_at: string;
  meal_type: string;
}

export interface ExportedItem {
  meal_id: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  grams: number | null;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number | null;
}

export interface ExportRow {
  date: string;
  time: string;
  meal: string;
  item: string;
  portion: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  /** Null when the analyser gave no fibre for this item. Blank in the CSV, not zero. */
  fibre: number | null;
}

export interface DailyTotal {
  date: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  /** Null when no item that day had a fibre figure: unknown, which is not the same as zero. */
  fibre: number | null;
}

const timeFormat = new Map<string, Intl.DateTimeFormat>();

/** The clock time of an instant, in the profile's zone. One formatter per zone, reused. */
function clockTime(iso: string, timeZone: string): string {
  let format = timeFormat.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    timeFormat.set(timeZone, format);
  }
  return format.format(new Date(iso));
}

/** How the portion reads: what they typed (2 tbsp), or the grams the analyser weighed. */
export function portionLabel(item: Pick<ExportedItem, "quantity" | "unit" | "grams">): string {
  const unit = item.unit?.trim() ?? "";
  if (item.quantity !== null && unit !== "") return `${item.quantity} ${unit}`;
  if (item.grams !== null) return `${Math.round(item.grams)} g`;
  // Nothing typed and nothing weighed: the cell is empty rather than carrying a dash, which is
  // what every other empty value in the app does and what a spreadsheet reads as blank.
  return "";
}

/**
 * One row per item, in the order the day happened.
 *
 * An item with no fibre figure is blank, not zero. The case the old coalesce hid: a food the
 * analyser could not put a fibre number on was exported as 0 g, which reads as "no fibre" and is a
 * different claim from "not known". Blank is the honest cell, and a day with no known figures is
 * blank too (see `dailyTotals`).
 */
export function buildExportRows(
  meals: readonly ExportedMeal[],
  items: readonly ExportedItem[],
  timeZone: string,
): ExportRow[] {
  const byId = new Map(meals.map((meal) => [meal.id, meal]));
  const rows: ExportRow[] = [];
  for (const item of items) {
    const meal = byId.get(item.meal_id);
    // An item whose meal is not in the export is not this export's row: it would carry a date
    // and a time that belong to a meal the range excluded.
    if (meal === undefined) continue;
    rows.push({
      date: meal.local_date,
      time: clockTime(meal.eaten_at, timeZone),
      meal: meal.meal_type,
      item: item.name,
      portion: portionLabel(item),
      kcal: item.calories,
      protein: item.protein_g,
      carbs: item.carbs_g,
      fat: item.fat_g,
      fibre: item.fiber_g,
    });
  }
  return rows.sort((a, b) =>
    a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date),
  );
}

/**
 * The per-day line, summed from the item rows so the two files cannot disagree.
 *
 * Fibre is added up only where it is known: an item with no figure is not a zero, so a day whose
 * items all lack fibre comes out blank rather than as 0 g, and a day with one known 4 g and one
 * unknown is 4 g. Calories and the other macros are always present (their columns are not null),
 * so they stay plain numbers.
 */
export function dailyTotals(rows: readonly ExportRow[]): DailyTotal[] {
  const byDay = new Map<string, DailyTotal>();
  for (const row of rows) {
    const day = byDay.get(row.date) ?? {
      date: row.date,
      kcal: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      fibre: null as number | null,
    };
    day.kcal += row.kcal;
    day.protein += row.protein;
    day.carbs += row.carbs;
    day.fat += row.fat;
    if (row.fibre !== null) day.fibre = (day.fibre ?? 0) + row.fibre;
    byDay.set(row.date, day);
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * A number as a cell a spreadsheet reads as a number.
 *
 * Two decimals at most, and no trailing zero: one is what kcal and the macros carry, two is what a
 * kilogram weighs to (the column is numeric(5,2)), and rounding here also clears the 0.30000000004
 * that adding floats leaves behind.
 */
function numberText(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isFinite(rounded) ? String(rounded) : "0";
}

/**
 * A CSV field a spreadsheet cannot misinterpret.
 *
 * Numbers are written as they are; only text is guarded, because a leading apostrophe on `-3`
 * would turn a number into a string. Text starting with = + - @ is prefixed with an apostrophe,
 * which is how a spreadsheet is told to treat the cell as text: an item called `=HYPERLINK(...)`
 * is a food, not a formula.
 */
export function escapeCsv(value: string | number | null): string {
  // Null is a cell with nothing in it: not zero, and not the word "null".
  if (value === null) return "";
  if (typeof value === "number") return numberText(value);
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

const MEALS_HEADER = [
  "date",
  "time",
  "meal",
  "item",
  "portion",
  "kcal",
  "protein",
  "carbs",
  "fat",
  "fibre",
];
const TOTALS_HEADER = ["date", "kcal", "protein", "carbs", "fat", "fibre"];

function csvLines(header: readonly string[], rows: readonly (string | number | null)[][]): string {
  const lines = [header.join(","), ...rows.map((row) => row.map(escapeCsv).join(","))];
  // A trailing newline: some tools treat a final line without one as truncated.
  return `${lines.join("\n")}\n`;
}

/** The meals and items file, header only when the range holds nothing. */
export function mealsCsv(rows: readonly ExportRow[]): string {
  return csvLines(
    MEALS_HEADER,
    rows.map((row) => [
      row.date,
      row.time,
      row.meal,
      row.item,
      row.portion,
      row.kcal,
      row.protein,
      row.carbs,
      row.fat,
      row.fibre,
    ]),
  );
}

export function totalsCsv(totals: readonly DailyTotal[]): string {
  return csvLines(
    TOTALS_HEADER,
    totals.map((day) => [day.date, day.kcal, day.protein, day.carbs, day.fat, day.fibre]),
  );
}

/* -------------------------------------------------------------------------- */
/* Reading it back, with the caller's own session.                            */
/* -------------------------------------------------------------------------- */

const numberish = z.union([z.number(), z.string()]).transform((value) => Number(value));
const numberishOrNull = z
  .union([z.number(), z.string(), z.null()])
  .transform((value) => (value === null ? null : Number(value)));

const mealRow = z.object({
  id: z.string(),
  local_date: z.string(),
  eaten_at: z.string(),
  meal_type: z.string(),
});

const itemRow = z.object({
  meal_id: z.string(),
  name: z.string(),
  quantity: numberishOrNull,
  unit: z.string().nullable(),
  grams: numberishOrNull,
  calories: numberish,
  protein_g: numberish,
  carbs_g: numberish,
  fat_g: numberish,
  fiber_g: numberishOrNull,
});

// How many meal ids one in (...) may carry. Chosen, not measured: a hundred uuids is ~3.8kb.
const ID_CHUNK = 100;

export interface ExportData {
  meals: ExportedMeal[];
  items: ExportedItem[];
  weights: ExportedWeight[];
}

/**
 * Every meal and item in a date range, for this user.
 *
 * The `user_id` filter is explicit as well as being what RLS enforces: this function is the one
 * place that decides whose data a file contains, and one of the two guards being wrong should not
 * be enough. Soft-deleted meals are excluded, because they are not part of the record the person
 * kept.
 *
 * `from` null means all time, which is a different query rather than a very old date: there is no
 * range to scan, so the planner uses the index on the user instead.
 */
export async function fetchExportData(input: {
  userId: string;
  from: string | null;
  to: string;
}): Promise<ExportData> {
  let query = supabase
    .from("meals")
    .select("id, local_date, eaten_at, meal_type")
    .eq("user_id", input.userId)
    .is("deleted_at", null)
    .lte("local_date", input.to);
  if (input.from !== null) query = query.gte("local_date", input.from);

  const mealResult = await query.order("local_date").order("eaten_at");
  if (mealResult.error) throw mealResult.error;

  const meals = z.array(mealRow).parse(mealResult.data ?? []);
  const items: ExportedItem[] = [];

  for (let at = 0; at < meals.length; at += ID_CHUNK) {
    const ids = meals.slice(at, at + ID_CHUNK).map((meal) => meal.id);
    const itemResult = await supabase
      .from("meal_items")
      .select("meal_id, name, quantity, unit, grams, calories, protein_g, carbs_g, fat_g, fiber_g")
      .in("meal_id", ids);
    if (itemResult.error) throw itemResult.error;
    items.push(...z.array(itemRow).parse(itemResult.data ?? []));
  }

  // Weigh-ins are their own table and their own range: a day with a weigh-in and no meals is
  // still part of the record, which is why the empty check looks at both.
  let weightQuery = supabase
    .from("weight_log")
    .select("logged_on, weight_kg, waist_cm")
    .eq("user_id", input.userId)
    .lte("logged_on", input.to);
  if (input.from !== null) weightQuery = weightQuery.gte("logged_on", input.from);
  const weightResult = await weightQuery.order("logged_on");
  if (weightResult.error) throw weightResult.error;
  const weights = z.array(weightRow).parse(weightResult.data ?? []);

  return { meals, items, weights };
}

/* -------------------------------------------------------------------------- */
/* Weights                                                                     */
/* -------------------------------------------------------------------------- */

export interface ExportedWeight {
  logged_on: string;
  weight_kg: number;
  waist_cm: number | null;
}

const weightRow = z.object({
  logged_on: z.string(),
  weight_kg: numberish,
  waist_cm: numberishOrNull,
});

/**
 * The header names the unit the numbers are in.
 *
 * A column of 174.6 lb written as text cannot be added up, so the unit goes in the header once
 * rather than in every cell.
 */
export function weightHeader(units: UnitSystem): readonly string[] {
  return [
    "date",
    units === "imperial" ? "weight_lb" : "weight_kg",
    units === "imperial" ? "waist_in" : "waist_cm",
  ];
}

/**
 * One row per weigh-in, at the weight card's own precision.
 *
 * `displayRounded` is the card's formatter: it converts once and rounds once, to one decimal of
 * pounds and two of kilograms, which is what the stored column supports. Reusing it rather than a
 * formatter of this file's own means a weigh-in reads the same in the export as on the screen. A
 * waist that was not measured is blank, not zero.
 */
export function weightsCsv(weights: readonly ExportedWeight[], units: UnitSystem): string {
  return csvLines(
    weightHeader(units),
    weights.map((entry) => [
      entry.logged_on,
      displayRounded(entry.weight_kg, units, "mass"),
      entry.waist_cm === null ? null : displayRounded(entry.waist_cm, units, "length"),
    ]),
  );
}

/**
 * The dates a file's name carries.
 *
 * A chosen range is what the person asked for, so the name states it. All time has no asked-for
 * start, so the name uses the first and last dates actually in the file: a name that claimed
 * today would claim a day the file may not contain.
 */
function fileDates(dates: readonly string[], from: string | null, to: string): string {
  if (from !== null) return `${from}_to_${to}`;
  const sorted = [...dates].sort();
  return `${sorted[0] ?? to}_to_${sorted[sorted.length - 1] ?? to}`;
}

/**
 * The chosen file's name and text, or null when that file would hold nothing but a header.
 *
 * "Nothing to export" is per choice: a range of weigh-ins and no meals still exports the
 * weights, and says so rather than handing over an empty file. The decision lives here rather
 * than in the control because it is the same decision for every caller, and it is the one a
 * test can pin.
 */
export function exportFileContent(input: {
  content: ExportContentId;
  data: ExportData;
  units: UnitSystem;
  timeZone: string;
  /** The range that was asked for: null means all time. */
  from: string | null;
  to: string;
}): { name: string; text: string } | null {
  if (input.content === "weights") {
    if (input.data.weights.length === 0) return null;
    const dates = input.data.weights.map((entry) => entry.logged_on);
    const span = fileDates(dates, input.from, input.to);
    return { name: `weights_${span}.csv`, text: weightsCsv(input.data.weights, input.units) };
  }
  const rows = buildExportRows(input.data.meals, input.data.items, input.timeZone);
  if (rows.length === 0) return null;
  const span = fileDates(
    rows.map((row) => row.date),
    input.from,
    input.to,
  );
  if (input.content === "totals") {
    return { name: `daily-totals_${span}.csv`, text: totalsCsv(dailyTotals(rows)) };
  }
  return { name: `meals_${span}.csv`, text: mealsCsv(rows) };
}
