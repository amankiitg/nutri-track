/**
 * The review screen's model: the items being edited, the arithmetic that editing
 * does, and the payload `save_meal` is given.
 *
 * All pure functions, so the rules — especially what a grams change does to a number
 * the user typed — are unit tested rather than inferred from clicking around.
 */
import {
  MAX_PHOTOS,
  reviewReasonsFor,
  type MealItemDraft,
  type MealSource,
  type MealType,
} from "@shared/meal-parse";

/**
 * What a jsonb column can hold. Typed rather than left as `unknown` so the payload can
 * be handed to `supabase.rpc` without a blanket cast: the RPC's arguments are `Json`.
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** One item on the review screen: what the model said, plus what the user did to it. */
export interface ReviewItem {
  /** Local to this screen. A stable React key and nothing else. */
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
  confidence: number;
  /** True once a human has changed any field on this item. */
  userEdited: boolean;
  /**
   * The item exactly as the service returned it, before any editing. Saved to
   * `meal_items.llm_raw`, so what the model claimed is still there to compare against
   * what the user accepted. Null for an item added by hand.
   */
  llmRaw: JsonValue | null;
  /**
   * Each nutrient's value **per gram**: the unrounded basis a grams change scales from.
   *
   * Held separately because scaling the displayed values compounds their rounding. Each edit
   * rounds to a tenth and the next edit multiplies that tenth, so the answer depends on the route
   * taken to a grams value rather than on the grams value: measured, ten small increments to
   * 218 g left carbs at 74.7 where one jump to 218 g gave 74.9. From a density the displayed
   * value is computed once from an unrounded basis, so the route stops mattering.
   *
   * Per gram rather than per item, so an explicit nutrient edit survives correctly: typing
   * calories at 300 g is a correction to the food's density, so that becomes the density later
   * grams changes use. Absent, or missing a field, means no basis is known for it and the
   * displayed value is used instead.
   */
  perGram?: Partial<Record<NutrientField, number>>;
}

/** The nutrient fields, in the order the card shows them. */
export const NUTRIENT_FIELDS = [
  "calories",
  "protein_g",
  "carbs_g",
  "fat_g",
  "fiber_g",
  "sugar_g",
  "sodium_mg",
] as const;

export type NutrientField = (typeof NUTRIENT_FIELDS)[number];

export const NUTRIENT_LABELS: Record<NutrientField, string> = {
  calories: "Calories (kcal)",
  protein_g: "Protein (g)",
  carbs_g: "Carbs (g)",
  fat_g: "Fat (g)",
  fiber_g: "Fibre (g)",
  sugar_g: "Sugar (g)",
  sodium_mg: "Sodium (mg)",
};

/** Nullable in the database, so an unknown value stays unknown rather than becoming 0. */
const NULLABLE_NUTRIENTS = new Set<NutrientField>(["fiber_g", "sugar_g", "sodium_mg"]);

/** The nutrients a grams change scales. Name, unit and quantity are not nutrients. */
const SCALED_NUTRIENTS = NUTRIENT_FIELDS;

function roundTo(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Builds a review item from what the service returned. */
export function reviewItemFromDraft(draft: MealItemDraft): ReviewItem {
  const perGram: Partial<Record<NutrientField, number>> = {};
  // No grams means no density to record, and no ratio to apply later either.
  if (draft.grams !== null && draft.grams > 0) {
    for (const field of SCALED_NUTRIENTS) {
      const value = draft[field];
      if (value !== null) perGram[field] = value / draft.grams;
    }
  }

  return {
    id: crypto.randomUUID(),
    name: draft.name,
    quantity: draft.quantity,
    unit: draft.unit,
    grams: draft.grams,
    calories: draft.calories,
    protein_g: draft.protein_g,
    carbs_g: draft.carbs_g,
    fat_g: draft.fat_g,
    fiber_g: draft.fiber_g,
    sugar_g: draft.sugar_g,
    sodium_mg: draft.sodium_mg,
    confidence: draft.confidence,
    userEdited: false,
    perGram,
    // The draft is a plain object that came out of JSON.parse and was then normalised,
    // so it is JSON by construction; the cast is because its interface is named.
    llmRaw: draft as unknown as JsonValue,
  };
}

/**
 * The densities with one field replaced, or dropped when it is no longer known.
 *
 * Used by an explicit edit: the number the user typed becomes the basis at the grams on screen,
 * which is what "this food is denser than the model thought" means.
 */
function withDensity(
  item: ReviewItem,
  field: NutrientField,
  value: number | null,
): Partial<Record<NutrientField, number>> {
  const perGram: Partial<Record<NutrientField, number>> = { ...(item.perGram ?? {}) };
  const grams = item.grams;
  if (value === null || grams === null || grams <= 0) {
    delete perGram[field];
  } else {
    perGram[field] = value / grams;
  }
  return perGram;
}

/** An empty item for the "add item" button. */
export function blankReviewItem(): ReviewItem {
  return {
    id: crypto.randomUUID(),
    name: "",
    quantity: null,
    unit: null,
    grams: null,
    calories: 0,
    protein_g: 0,
    carbs_g: 0,
    fat_g: 0,
    fiber_g: null,
    sugar_g: null,
    sodium_mg: null,
    confidence: 1,
    userEdited: true,
    llmRaw: null,
  };
}

/** What the screen says about where the numbers came from. */
export interface ReviewMeta {
  source: MealSource;
  /** Null when the items were copied from an earlier meal, so no call was made. */
  model: string | null;
  /** How many model calls produced these items. Zero for a copy. */
  attempts: number;
}

/**
 * A review item built from a meal that is already saved, for the "copy that meal
 * instead" path.
 *
 * `llmRaw` is null because these numbers came from the user's own earlier review, not
 * from the model on this capture, and claiming otherwise would put a model's name on
 * numbers it never produced. `userEdited` is true for the same reason: a person
 * checked them.
 */
export function reviewItemFromSaved(saved: {
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
}): ReviewItem {
  return {
    id: crypto.randomUUID(),
    name: saved.name,
    quantity: saved.quantity,
    unit: saved.unit,
    grams: saved.grams,
    calories: saved.calories,
    protein_g: saved.protein_g,
    carbs_g: saved.carbs_g,
    fat_g: saved.fat_g,
    fiber_g: saved.fiber_g,
    sugar_g: saved.sugar_g,
    sodium_mg: saved.sodium_mg,
    confidence: saved.confidence ?? 1,
    userEdited: true,
    llmRaw: null,
  };
}

/**
 * The flags for an item as it stands now.
 *
 * Derived on every render rather than stored. A stored flag would describe the item
 * as the model returned it, so an item the user has just corrected would keep its
 * warning, and a portion scaled over the calorie ceiling would not raise one.
 */
export function flagsFor(item: ReviewItem): { needsReview: boolean; reasons: string[] } {
  const reasons = reviewReasonsFor(item);
  return { needsReview: reasons.length > 0, reasons };
}

/**
 * THE RULE FOR A GRAMS CHANGE.
 *
 * The item's `grams` is the basis: every nutrient is expressed *at that weight*. So a
 * portion change rescales each nutrient by `newGrams / oldGrams`, and the basis moves
 * with it.
 *
 * Editing a nutrient changes the number and NOT the basis. That is the whole of it:
 * if the model said 150 g / 200 kcal, the user set 300 g (400 kcal), then typed 380
 * kcal, the item now means "380 kcal at 300 g" — a correction to the food's density,
 * not to the portion. Changing grams to 450 g therefore gives 380 × 1.5 = 570 kcal.
 *
 * The alternative — freezing a nutrient the moment it is edited — would leave the card
 * describing two different portions at once: 380 kcal next to macros that had scaled
 * to 450 g. The numbers on one card have to describe one plate of food.
 *
 * A grams change with no usable basis on either side (null or zero) rescales nothing,
 * because there is no ratio to apply.
 */
export function rescaleForGrams(item: ReviewItem, nextGrams: number | null): ReviewItem {
  const previous = item.grams;
  /**
   * Whether the nutrients can be recomputed for `nextGrams`.
   *
   * A density is enough on its own, because it already says what a gram is worth. That matters
   * when the box has been emptied: clearing it commits `grams: null`, and without a density the
   * next digit typed would have no previous grams to form a ratio from, so the nutrients would
   * keep their old absolute values and 200 kcal would become anchored to 5 g. Typing on from there
   * multiplied that. The density removes the dependence on `previous` entirely.
   *
   * With no density the old requirement stands: both sides need a usable weight.
   */
  const hasDensity = SCALED_NUTRIENTS.some((field) => item.perGram?.[field] !== undefined);
  const canScale =
    nextGrams !== null &&
    nextGrams > 0 &&
    previous !== nextGrams &&
    (hasDensity || (previous !== null && previous > 0));

  const scaled: ReviewItem = { ...item, grams: nextGrams, userEdited: true };
  if (!canScale) return scaled;

  for (const field of SCALED_NUTRIENTS) {
    const current = item[field];
    if (current === null) continue;
    // Scale from the density when there is one. Falling back to the displayed value over the
    // previous grams is the same arithmetic and reproduces the old behaviour exactly, which is
    // what an item built by hand gets because it carries no density. The fallback needs a usable
    // previous grams, which the density path does not.
    const density =
      item.perGram?.[field] ?? (previous === null || previous <= 0 ? null : current / previous);
    if (density === null) continue;
    scaled[field] = roundTo(density * nextGrams);
  }
  return scaled;
}

/** A direct edit to one nutrient field: changes that number and nothing else. */
export function setNutrient(item: ReviewItem, field: NutrientField, raw: string): ReviewItem {
  const trimmed = raw.trim();
  if (trimmed === "") {
    // Only a nullable field may be emptied; calories and the macros would become
    // NULL in a NOT NULL column.
    return NULLABLE_NUTRIENTS.has(field)
      ? { ...item, [field]: null, userEdited: true, perGram: withDensity(item, field, null) }
      : { ...item, [field]: 0, userEdited: true, perGram: withDensity(item, field, null) };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return item;
  const clamped = Math.max(0, value);
  return {
    ...item,
    [field]: roundTo(clamped),
    userEdited: true,
    perGram: withDensity(item, field, clamped),
  };
}

export function setGrams(item: ReviewItem, raw: string): ReviewItem {
  const trimmed = raw.trim();
  if (trimmed === "") return rescaleForGrams(item, null);
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return item;
  return rescaleForGrams(item, Math.max(0, roundTo(value)));
}

export function setText(item: ReviewItem, field: "name" | "unit", value: string): ReviewItem {
  return {
    ...item,
    [field]: value === "" ? (field === "unit" ? null : "") : value,
    userEdited: true,
  };
}

export function setQuantity(item: ReviewItem, raw: string): ReviewItem {
  const trimmed = raw.trim();
  if (trimmed === "") return { ...item, quantity: null, userEdited: true };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return item;
  return { ...item, quantity: roundTo(Math.max(0, value), 2), userEdited: true };
}

export interface MealTotals {
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  sugar_g: number;
  sodium_mg: number;
}

/** Sums the meal. A null nutrient contributes nothing, rather than making the total null. */
export function mealTotals(items: readonly ReviewItem[]): MealTotals {
  const totals: MealTotals = {
    calories: 0,
    protein_g: 0,
    carbs_g: 0,
    fat_g: 0,
    fiber_g: 0,
    sugar_g: 0,
    sodium_mg: 0,
  };
  for (const item of items) {
    for (const field of NUTRIENT_FIELDS) {
      const value = item[field];
      if (value !== null) totals[field] += value;
    }
  }
  for (const field of NUTRIENT_FIELDS) totals[field] = roundTo(totals[field]);
  return totals;
}

/**
 * What is left of the day after this meal. Negative means over.
 *
 * `leftToday` is what is left of today *before* this meal — the number the dashboard's ring
 * shows — and not the day's target. Handing it the target is the bug this replaced: a phone
 * reported "1641 kcal left of today's 1771" for a 130 kcal meal on a day whose ring said 408
 * remaining, because 1771 - 130 ignores the 1,363 kcal already logged. Both inputs were
 * right and the arithmetic was right; the basis was the wrong number.
 */
export function remainingCalories(leftToday: number, totals: MealTotals): number {
  return roundTo(leftToday - totals.calories);
}

export interface SaveMealInput {
  items: readonly ReviewItem[];
  mealType: MealType;
  source: MealSource;
  eatenAt: Date;
  notes: string | null;
  photoPaths: readonly string[];
  photoHashes: readonly string[];
  /** Computed when the capture was parsed, so a retry of the same meal matches it. */
  inputFingerprint: string;
  /** Generated when the review screen mounted, so a double-tap cannot log twice. */
  idempotencyKey: string;
}

/**
 * The two arguments `save_meal` expects.
 *
 * `llm_raw` is omitted rather than sent as null for an item the user added by hand:
 * the RPC reads it with `->`, and a JSON null key would store a jsonb null instead of
 * a SQL NULL.
 */
export function toSaveMealArgs(input: SaveMealInput): {
  _meal: { [key: string]: JsonValue };
  _items: Array<{ [key: string]: JsonValue }>;
} {
  return {
    _meal: {
      eaten_at: input.eatenAt.toISOString(),
      meal_type: input.mealType,
      source: input.source,
      notes: input.notes,
      photo_paths: [...input.photoPaths].slice(0, MAX_PHOTOS),
      photo_hashes: [...input.photoHashes].slice(0, MAX_PHOTOS),
      input_fingerprint: input.inputFingerprint,
      idempotency_key: input.idempotencyKey,
    },
    _items: input.items.map((item) => {
      const row: { [key: string]: JsonValue } = {
        name: item.name.trim() === "" ? "Unnamed item" : item.name.trim(),
        quantity: item.quantity,
        unit: item.unit,
        grams: item.grams,
        calories: item.calories,
        protein_g: item.protein_g,
        carbs_g: item.carbs_g,
        fat_g: item.fat_g,
        fiber_g: item.fiber_g,
        sugar_g: item.sugar_g,
        sodium_mg: item.sodium_mg,
        confidence: item.confidence,
        user_edited: item.userEdited,
      };
      if (item.llmRaw !== null) row["llm_raw"] = item.llmRaw;
      return row;
    }),
  };
}

/** Saving needs at least one item, and every item needs a name. */
export function canSave(items: readonly ReviewItem[]): boolean {
  return items.length > 0 && items.every((item) => item.name.trim() !== "");
}

export interface SaveMealResult {
  meal_id: string;
  created: boolean;
}
