/**
 * The two duplicate queries, loading a meal that already exists, and writing an edit back to one.
 *
 * Kept apart from `duplicates.ts` so the matching rules stay pure and testable while
 * the queries stay thin.
 *
 * Both queries are bounded by time before they are bounded by anything else: a window
 * of ninety minutes for a meal, a day for a photo. That keeps the comparison set small
 * enough to do in the browser, which matters because the fuzzy match is a ratio over
 * pairs of strings and there is no way to express it as an index lookup.
 *
 * `fetchMealForEdit` and `updateMeal` are the two halves of one flow and live together for that
 * reason: the fields the loader has to select are decided by what the writer has to send, and
 * splitting them across files is how those two lists drift.
 */
import { supabase } from "@/integrations/supabase/client";
import { PHOTO_WINDOW_HOURS, SIMILAR_WINDOW_MINUTES, type CandidateMeal } from "./duplicates";
import {
  toUpdateMealArgs,
  type JsonValue,
  type UpdateMealInput,
  type UpdateMealResult,
} from "./review";

/** The columns every candidate meal needs, in one place so the two queries agree. */
const MEAL_COLUMNS = "id, eaten_at, meal_type, source, photo_paths, photo_hashes";

interface MealRow {
  id: string;
  eaten_at: string;
  meal_type: string;
  source: string;
  photo_paths: string[] | null;
  photo_hashes: string[] | null;
}

/** Item names for a set of meals, grouped by meal id. */
async function itemNamesByMeal(mealIds: readonly string[]): Promise<Map<string, string[]>> {
  const grouped = new Map<string, string[]>();
  if (mealIds.length === 0) return grouped;

  const { data, error } = await supabase
    .from("meal_items")
    .select("meal_id, name")
    .in("meal_id", [...mealIds]);
  if (error) throw new Error(`Could not read recent items: ${error.message}`);

  for (const row of data ?? []) {
    const list = grouped.get(row.meal_id) ?? [];
    list.push(row.name);
    grouped.set(row.meal_id, list);
  }
  return grouped;
}

function toCandidate(row: MealRow, itemNames: string[]): CandidateMeal {
  return {
    id: row.id,
    eatenAt: row.eaten_at,
    mealType: row.meal_type,
    source: row.source,
    itemNames,
    photoHashes: row.photo_hashes ?? [],
  };
}

/**
 * Meals eaten within ninety minutes of this capture, with their item names.
 *
 * The window is measured against the capture's own eaten-at, not against now: logging
 * yesterday's dinner today would otherwise compare against the wrong meals.
 */
export async function fetchRecentMeals(at: Date): Promise<CandidateMeal[]> {
  const from = new Date(at.getTime() - SIMILAR_WINDOW_MINUTES * 60_000);
  const to = new Date(at.getTime() + SIMILAR_WINDOW_MINUTES * 60_000);

  const { data, error } = await supabase
    .from("meals")
    .select(MEAL_COLUMNS)
    .gte("eaten_at", from.toISOString())
    .lte("eaten_at", to.toISOString())
    // A deleted meal is not a duplicate of anything. Without this the banner went on naming a
    // meal the person had already removed, which is how it was reported. `daily_summaries`,
    // `meals_for_day` and the day backfill all filter the same way, so this makes the duplicate
    // check agree with what the rest of the app treats as gone.
    .is("deleted_at", null)
    .order("eaten_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(`Could not read recent meals: ${error.message}`);

  const rows: MealRow[] = data ?? [];
  const names = await itemNamesByMeal(rows.map((row) => row.id));
  return rows.map((row) => toCandidate(row, names.get(row.id) ?? []));
}

/**
 * A meal from the last day whose photos overlap this capture's.
 *
 * `overlaps` is the array-operator form of `&&`, so it is answered by the GIN index on
 * photo_hashes rather than by scanning. The fingerprints are exact, which is why this
 * runs before the model is called: it can save the whole round trip.
 */
export async function findMealByPhotoHashes(
  hashes: readonly string[],
  at: Date,
): Promise<CandidateMeal | null> {
  const wanted = hashes.filter((hash) => hash !== "");
  if (wanted.length === 0) return null;

  const since = new Date(at.getTime() - PHOTO_WINDOW_HOURS * 3_600_000);
  const { data, error } = await supabase
    .from("meals")
    .select(MEAL_COLUMNS)
    .overlaps("photo_hashes", wanted)
    .gte("eaten_at", since.toISOString())
    // See `fetchRecentMeals`: a meal that was deleted must not match, or the banner reports a
    // meal that is no longer on the record.
    .is("deleted_at", null)
    .order("eaten_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`Could not check for a repeat photo: ${error.message}`);

  const row: MealRow | undefined = data?.[0];
  if (!row) return null;
  const names = await itemNamesByMeal([row.id]);
  return toCandidate(row, names.get(row.id) ?? []);
}

/** One item of an already-saved meal. */
export interface SavedItem {
  name: string;
  quantity: number | null;
  unit: string | null;
  grams: number | null;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number | null;
  sugar_g: number | null;
  sodium_mg: number | null;
  confidence: number | null;
  user_edited: boolean;
}

/** The items of a saved meal, for showing it or copying it. */
export async function fetchMealItems(mealId: string): Promise<SavedItem[]> {
  const { data, error } = await supabase
    .from("meal_items")
    .select(
      "name, quantity, unit, grams, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, confidence, user_edited",
    )
    .eq("meal_id", mealId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Could not read the saved meal: ${error.message}`);

  // numeric columns arrive as strings from PostgREST, so they are coerced here rather
  // than trusted.
  const toNumber = (value: number | string | null): number | null =>
    value === null ? null : Number(value);

  return (data ?? []).map((row) => ({
    name: row.name,
    quantity: toNumber(row.quantity),
    unit: row.unit,
    grams: toNumber(row.grams),
    calories: toNumber(row.calories) ?? 0,
    protein_g: toNumber(row.protein_g) ?? 0,
    carbs_g: toNumber(row.carbs_g) ?? 0,
    fat_g: toNumber(row.fat_g) ?? 0,
    fiber_g: toNumber(row.fiber_g),
    sugar_g: toNumber(row.sugar_g),
    sodium_mg: toNumber(row.sodium_mg),
    confidence: toNumber(row.confidence),
    user_edited: row.user_edited ?? false,
  }));
}

/** One item of a saved meal, as the edit screen needs it. */
export interface EditItemRow {
  /** The `meal_items` row, so the save can update it instead of inserting a new one. */
  id: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  grams: number | null;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number | null;
  sugar_g: number | null;
  sodium_mg: number | null;
  confidence: number | null;
  user_edited: boolean;
  /**
   * What the model returned for this item. Carried with the row; an edit does not rewrite it.
   */
  llm_raw: JsonValue | null;
}

/** A saved meal and its items, for editing rather than creating. */
export interface MealForEdit {
  id: string;
  eaten_at: string;
  meal_type: string;
  source: string;
  notes: string | null;
  photo_paths: string[];
  photo_hashes: string[];
  input_fingerprint: string;
  items: EditItemRow[];
}

/**
 * The meal being edited, with everything the review screen needs to show it.
 *
 * `fetchMealItems` looks like it would do and does not: it selects neither `id` nor `llm_raw`.
 * The id is the load-bearing one — it is what tells the save to update that row rather than insert
 * a new one. The model's raw output is carried so the item on screen is the row it came from and
 * not an approximation of it, but the update does not depend on having it: `update_meal` never
 * writes that column, which is a stronger guarantee than sending the value back would be. An
 * earlier version of this comment claimed the opposite, that the value had to be carried or the
 * update would lose it; that was written before the RPC existed and is not true of it.
 *
 * A soft-deleted meal is not editable, so `deleted_at` is filtered here: an edit is a decision
 * about a meal that is on the record.
 */
export async function fetchMealForEdit(mealId: string): Promise<MealForEdit> {
  const { data: meal, error: mealError } = await supabase
    .from("meals")
    .select("id, eaten_at, meal_type, source, notes, photo_paths, photo_hashes, input_fingerprint")
    .eq("id", mealId)
    .is("deleted_at", null)
    .maybeSingle();
  if (mealError) throw new Error(`Could not read the meal: ${mealError.message}`);
  if (!meal) throw new Error("That meal is not on your record.");

  const { data: items, error: itemsError } = await supabase
    .from("meal_items")
    .select(
      "id, name, quantity, unit, grams, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, confidence, user_edited, llm_raw",
    )
    .eq("meal_id", mealId)
    .order("created_at", { ascending: true });
  if (itemsError) throw new Error(`Could not read the meal's items: ${itemsError.message}`);

  // numeric columns arrive as strings from PostgREST, as they do in `fetchMealItems`.
  const toNumber = (value: number | string | null): number | null =>
    value === null ? null : Number(value);

  return {
    id: meal.id,
    eaten_at: meal.eaten_at,
    meal_type: meal.meal_type,
    source: meal.source,
    notes: meal.notes,
    photo_paths: meal.photo_paths,
    photo_hashes: meal.photo_hashes,
    input_fingerprint: meal.input_fingerprint,
    items: (items ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      quantity: toNumber(row.quantity),
      unit: row.unit,
      grams: toNumber(row.grams),
      calories: toNumber(row.calories) ?? 0,
      protein_g: toNumber(row.protein_g) ?? 0,
      carbs_g: toNumber(row.carbs_g) ?? 0,
      fat_g: toNumber(row.fat_g) ?? 0,
      fiber_g: toNumber(row.fiber_g),
      sugar_g: toNumber(row.sugar_g),
      sodium_mg: toNumber(row.sodium_mg),
      confidence: toNumber(row.confidence),
      user_edited: row.user_edited ?? false,
      llm_raw: (row.llm_raw ?? null) as JsonValue | null,
    })),
  };
}

/**
 * Writes an edit back to a meal that is already on the record.
 *
 * The two ways `update_meal` refuses are turned into sentences here rather than shown as Postgres
 * text, which is the rule `restoreMeal` already follows: the database's words are for a log, and
 * the person holding the phone gets English. `P0002` is the meal not being there — not this
 * user's, gone, or soft-deleted, which are one answer to a person who cannot act on the
 * difference. `22023` is a payload that cannot be honoured: no items at all, or one item named
 * twice.
 *
 * Anything else is rethrown as itself. A genuine failure dressed up as one of these would send
 * someone looking for a meal that is perfectly fine.
 */
export async function updateMeal(
  mealId: string,
  input: UpdateMealInput,
): Promise<UpdateMealResult> {
  const { data, error } = await supabase.rpc("update_meal", toUpdateMealArgs(mealId, input));
  if (error) {
    if (error.code === "P0002") {
      throw new Error("That meal is no longer on your record.");
    }
    if (error.code === "22023") {
      throw new Error("A meal needs at least one item.");
    }
    throw new Error(error.message);
  }

  const result = data as UpdateMealResult | null;
  // Same shape the create path checks for: a reply without the id is a reply that did not write,
  // and saying the change was saved would be the one thing worse than saying it failed.
  if (!result?.meal_id) throw new Error("The change was not saved.");
  return result;
}
