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

/** The three ranges the picker offers. `days` is null for everything there is. */
export const EXPORT_RANGES = [
  { id: "7", label: "Last 7 days", days: 7 },
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "all", label: "All time", days: null },
] as const;

export type ExportRangeId = (typeof EXPORT_RANGES)[number]["id"];

export const DEFAULT_EXPORT_RANGE: ExportRangeId = "30";

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
  fibre: number;
}

export interface DailyTotal {
  date: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fibre: number;
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
 * An item with no fibre is zero rather than blank: the column is a number everywhere else in the
 * app, and a blank cell in a spreadsheet column of numbers is a gap somebody has to explain.
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
      fibre: item.fiber_g ?? 0,
    });
  }
  return rows.sort((a, b) =>
    a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date),
  );
}

/** The per-day line, summed from the item rows so the two files cannot disagree. */
export function dailyTotals(rows: readonly ExportRow[]): DailyTotal[] {
  const byDay = new Map<string, DailyTotal>();
  for (const row of rows) {
    const day = byDay.get(row.date) ?? {
      date: row.date,
      kcal: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      fibre: 0,
    };
    day.kcal += row.kcal;
    day.protein += row.protein;
    day.carbs += row.carbs;
    day.fat += row.fat;
    day.fibre += row.fibre;
    byDay.set(row.date, day);
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** One decimal, without a trailing .0 — a spreadsheet reads both as numbers. */
function numberText(value: number): string {
  const rounded = Math.round(value * 10) / 10;
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
export function escapeCsv(value: string | number): string {
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

function csvLines(header: readonly string[], rows: readonly (string | number)[][]): string {
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
/* The zip: two text files, stored rather than deflated.                       */
/* -------------------------------------------------------------------------- */

/**
 * A store-only zip.
 *
 * Two CSVs of text compress to a fraction of their size with deflate, but deflate is ~20kb of
 * code for a file that is already small: a year of meals is a few hundred kilobytes, which the
 * share sheet and a download both handle without noticing. Storing them keeps this to the 60
 * lines below instead of a dependency, which is the trade the brief asked for.
 *
 * The timestamp is fixed rather than `new Date()`: the same data exports to the same bytes, so a
 * test can assert the archive instead of describing it.
 */
export interface ZipEntry {
  name: string;
  text: string;
}

// 19 November 2026, 00:00, in the FAT epoch encoding.
const DOS_DATE = ((2026 - 1980) << 9) | (11 << 5) | 19;
const DOS_TIME = 0;

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[i] = value >>> 0;
    }
  }
  const table = crcTable;
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

class ByteWriter {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  u16(value: number): void {
    this.push(Uint8Array.of(value & 0xff, (value >>> 8) & 0xff));
  }

  u32(value: number): void {
    this.push(
      Uint8Array.of(
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff,
      ),
    );
  }

  get size(): number {
    return this.length;
  }

  finish(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

export function zipStore(entries: readonly ZipEntry[]): Uint8Array<ArrayBuffer> {
  const writer = new ByteWriter();
  const directory: { name: Uint8Array; crc: number; size: number; offset: number }[] = [];

  for (const entry of entries) {
    const name = utf8(entry.name);
    const data = utf8(entry.text);
    const crc = crc32(data);
    const offset = writer.size;

    writer.u32(0x04034b50);
    writer.u16(20);
    // 0x0800: the name is UTF-8, so a non-ASCII filename is not mojibake in the archive.
    writer.u16(0x0800);
    writer.u16(0);
    writer.u16(DOS_TIME);
    writer.u16(DOS_DATE);
    writer.u32(crc);
    writer.u32(data.length);
    writer.u32(data.length);
    writer.u16(name.length);
    writer.u16(0);
    writer.push(name);
    writer.push(data);

    directory.push({ name, crc, size: data.length, offset });
  }

  const directoryStart = writer.size;
  for (const entry of directory) {
    writer.u32(0x02014b50);
    writer.u16(20);
    writer.u16(20);
    writer.u16(0x0800);
    writer.u16(0);
    writer.u16(DOS_TIME);
    writer.u16(DOS_DATE);
    writer.u32(entry.crc);
    writer.u32(entry.size);
    writer.u32(entry.size);
    writer.u16(entry.name.length);
    writer.u16(0);
    writer.u16(0);
    writer.u16(0);
    writer.u16(0);
    writer.u32(0);
    writer.u32(entry.offset);
    writer.push(entry.name);
  }
  const directorySize = writer.size - directoryStart;

  writer.u32(0x06054b50);
  writer.u16(0);
  writer.u16(0);
  writer.u16(entries.length);
  writer.u16(entries.length);
  writer.u32(directorySize);
  writer.u32(directoryStart);
  writer.u16(0);

  return writer.finish();
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

  return { meals, items };
}
