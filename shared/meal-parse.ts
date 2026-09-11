/**
 * The contract between the model, the `parse-meal` Edge Function and the review UI.
 *
 * This file is shared: the Edge Function imports it over a relative path and the
 * browser imports it through the `@shared` alias, so the shape the model is asked
 * for, the shape we validate and the shape the UI edits cannot drift apart.
 *
 * It is deliberately free of Deno and browser APIs, except `crypto.subtle` for
 * hashing, which both runtimes provide.
 */
import { z } from "zod";

/** Photos per meal, and the matching bucket/constraint cap. */
export const MAX_PHOTOS = 3;

/** A single item over this many kcal, or with zero kcal, is flagged for review. */
export const MAX_ITEM_KCAL = 2000;
/** An item over this many grams is flagged for review. */
export const MAX_ITEM_GRAMS = 1500;
/** Calories must sit within this fraction of 4p + 4c + 9f, or the item is flagged. */
export const MACRO_KCAL_TOLERANCE = 0.15;

export const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"] as const;
export type MealType = (typeof MEAL_TYPES)[number];

export const MEAL_SOURCES = ["photo", "voice", "text"] as const;
export type MealSource = (typeof MEAL_SOURCES)[number];

/** Stable reason strings, surfaced in the review UI next to flagged items. */
export const REVIEW_REASONS = {
  macroMismatch: "Calories do not match the protein, carbs and fat",
  caloriesTooHigh: `More than ${MAX_ITEM_KCAL} kcal for one item`,
  caloriesZero: "Zero calories",
  gramsTooHigh: `More than ${MAX_ITEM_GRAMS} g for one item`,
} as const;

/*
 * The model is not a strict API. It returns numbers as strings, omits fields and
 * occasionally sends null, and a single unparseable field should not throw away an
 * otherwise good response. The wire schema below is therefore tolerant and the
 * strict shape is produced by `normalizeItems`, which is also where the sanity
 * checks live.
 */

const looseNumber = z
  .union([z.number(), z.string(), z.null(), z.undefined()])
  .transform((value): number | null => {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "") return null;
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  });

const looseString = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((value): string | null => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed === "" ? null : trimmed;
    }
    if (typeof value === "number") return String(value);
    return null;
  });

export const modelItemSchema = z.object({
  name: z.string().trim().min(1, "each item needs a name"),
  quantity: looseNumber,
  unit: looseString,
  grams: looseNumber,
  calories: looseNumber,
  protein_g: looseNumber,
  carbs_g: looseNumber,
  fat_g: looseNumber,
  fiber_g: looseNumber,
  sugar_g: looseNumber,
  sodium_mg: looseNumber,
  confidence: looseNumber,
});

export type ModelItem = z.infer<typeof modelItemSchema>;

const responseObjectSchema = z.object({ items: z.array(modelItemSchema) });

/**
 * Accepts either `{ items: [...] }` or a bare array. The prompt asks for the
 * object; the bare array is a common near-miss and not worth burning the retry on.
 */
export const modelResponseSchema = z.union([
  responseObjectSchema,
  z.array(modelItemSchema).transform((items) => ({ items })),
]);

/**
 * What the model is *told* to return, as opposed to what we tolerate.
 *
 * This is the single description of the response shape. It is converted into the
 * provider's response schema by `server/src/gemini-schema.ts` and sent with the
 * request, so the prompt, the validator and the model's contract all come from
 * here. The descriptions become the `description` fields the model reads, which is
 * why they are written as instructions rather than as documentation.
 *
 * It is plain Zod with no transforms, because a JSON Schema has no way to express
 * "coerce a string to a number". `modelItemSchema` above stays in place as the
 * tolerant validator on top of it: a schema-constrained model is a strong
 * guarantee, not a proof, and the tolerant layer is what makes a near-miss
 * recoverable rather than a wasted retry.
 */
export const modelItemContractSchema = z.object({
  name: z
    .string()
    .describe("Name of the food item, as a person would say it, e.g. 'Sourdough toast'"),
  quantity: z
    .number()
    .nullable()
    .describe("How many of `unit`, e.g. 2 for two slices. Null when the count is not meaningful"),
  unit: z
    .string()
    .nullable()
    .describe("The unit the quantity counts, e.g. 'slice', 'cup', 'g'. Null if unknown"),
  grams: z.number().nullable().describe("Estimated total weight of this item in grams"),
  calories: z.number().describe("Energy in kcal for the whole item, not per 100 g"),
  protein_g: z.number().describe("Protein in grams for the whole item"),
  carbs_g: z.number().describe("Carbohydrate in grams for the whole item"),
  fat_g: z.number().describe("Fat in grams for the whole item"),
  fiber_g: z.number().nullable().describe("Dietary fibre in grams, or null if unknown"),
  sugar_g: z.number().nullable().describe("Sugar in grams, or null if unknown"),
  sodium_mg: z.number().nullable().describe("Sodium in milligrams, or null if unknown"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "How sure you are: 0.95 for a read nutrition label, 0.7 for a clear look, 0.4 for a guess",
    ),
});

export const modelContractSchema = z.object({
  items: z.array(modelItemContractSchema).describe("One entry per distinct food item in the input"),
});

export type ModelItemContract = z.infer<typeof modelItemContractSchema>;
export type ModelContract = z.infer<typeof modelContractSchema>;

/** The strict, editable shape the UI works with. */
export interface MealItemDraft {
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
  /** 0–1; defaults to 0.5 when the model omits it. */
  confidence: number;
  needs_review: boolean;
  review_reasons: string[];
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** `4 kcal/g` protein and carbs, `9 kcal/g` fat. */
export function macroCalories(proteinG: number, carbsG: number, fatG: number): number {
  return 4 * proteinG + 4 * carbsG + 9 * fatG;
}

/** Turns one tolerant model item into the strict draft, applying the sanity checks. */
export function normalizeItem(item: ModelItem): MealItemDraft {
  const calories = roundTo(item.calories ?? 0, 1);
  const proteinG = roundTo(item.protein_g ?? 0, 1);
  const carbsG = roundTo(item.carbs_g ?? 0, 1);
  const fatG = roundTo(item.fat_g ?? 0, 1);

  const reasons: string[] = [];

  if (calories > MAX_ITEM_KCAL) {
    reasons.push(REVIEW_REASONS.caloriesTooHigh);
  } else if (calories === 0) {
    reasons.push(REVIEW_REASONS.caloriesZero);
  }

  const grams = item.grams === null ? null : roundTo(item.grams, 1);
  if (grams !== null && grams > MAX_ITEM_GRAMS) {
    reasons.push(REVIEW_REASONS.gramsTooHigh);
  }

  // Only meaningful when the item actually claims calories: a zero-calorie item
  // with no macros is "zero calories", not a macro mismatch.
  const fromMacros = macroCalories(proteinG, carbsG, fatG);
  const denominator = Math.max(calories, fromMacros);
  if (denominator > 0 && Math.abs(calories - fromMacros) > MACRO_KCAL_TOLERANCE * denominator) {
    reasons.push(REVIEW_REASONS.macroMismatch);
  }

  const confidence = item.confidence === null ? 0.5 : Math.min(1, Math.max(0, item.confidence));

  return {
    name: item.name,
    quantity: item.quantity === null ? null : roundTo(item.quantity, 2),
    unit: item.unit,
    grams,
    calories,
    protein_g: proteinG,
    carbs_g: carbsG,
    fat_g: fatG,
    fiber_g: item.fiber_g === null ? null : roundTo(item.fiber_g, 1),
    sugar_g: item.sugar_g === null ? null : roundTo(item.sugar_g, 1),
    sodium_mg: item.sodium_mg === null ? null : roundTo(item.sodium_mg, 1),
    confidence: roundTo(confidence, 2),
    needs_review: reasons.length > 0,
    review_reasons: reasons,
  };
}

export function normalizeItems(items: readonly ModelItem[]): MealItemDraft[] {
  return items.map(normalizeItem);
}

export type ParseModelResult = { ok: true; items: MealItemDraft[] } | { ok: false; error: string };

/**
 * A union reports the least useful failure there is — "Invalid input" at the root
 * — so walk into the branches and keep the deepest complaint, which is the field
 * that actually went wrong.
 */
function deepestIssue(issue: z.ZodIssue): { path: string; message: string } {
  const candidates: { path: string; message: string }[] = [];
  if (issue.code === "invalid_union") {
    for (const error of issue.unionErrors) {
      for (const inner of error.issues) candidates.push(deepestIssue(inner));
    }
  }
  candidates.push({ path: issue.path.join("."), message: issue.message });
  let best = candidates[0];
  for (const candidate of candidates) {
    if (best === undefined || candidate.path.length > best.path.length) best = candidate;
  }
  return best ?? { path: "response", message: "did not match the schema" };
}

/** Parses the raw model text. Never throws: the caller decides whether to retry. */
export function parseModelResponse(raw: string): ParseModelResult {
  const result = classifyModelResponse(raw);
  return result.ok ? result : { ok: false, error: result.error };
}

export type ParseFailureReason =
  /** The reply was not JSON at all — often prose, or a markdown code fence. */
  | "not_json"
  /** It was JSON, but not the shape the contract promised. */
  | "schema";

export type ClassifiedModelResult =
  { ok: true; items: MealItemDraft[] } | { ok: false; reason: ParseFailureReason; error: string };

/**
 * As `parseModelResponse`, but says *how* it failed. The service needs that: the
 * retry it sends depends on whether the model failed to produce JSON or produced
 * JSON of the wrong shape, and the two are worth separating in `llm_calls`.
 */
export function classifyModelResponse(raw: string): ClassifiedModelResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not_json", error: "response was not valid JSON" };
  }

  const parsed = modelResponseSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    if (first === undefined) {
      return { ok: false, reason: "schema", error: "response did not match the schema" };
    }
    const issue = deepestIssue(first);
    return {
      ok: false,
      reason: "schema",
      error: `${issue.path === "" ? "response" : issue.path}: ${issue.message}`,
    };
  }

  return { ok: true, items: normalizeItems(parsed.data.items) };
}

/**
 * Meal type from the wall clock: 5–10 breakfast, 11–14 lunch, 17–21 dinner,
 * otherwise snack. Pass the profile's zone so this agrees with `daily_summaries`.
 */
export function guessMealType(at: Date, timeZone?: string): MealType {
  const hour = hourInZone(at, timeZone);
  if (hour >= 5 && hour <= 10) return "breakfast";
  if (hour >= 11 && hour <= 14) return "lunch";
  if (hour >= 17 && hour <= 21) return "dinner";
  return "snack";
}

function hourInZone(at: Date, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(at);
  const hour = parts.find((part) => part.type === "hour")?.value;
  return hour === undefined ? at.getHours() : Number(hour);
}

/** The fingerprint ignores anything finer than ten minutes. */
export const FINGERPRINT_WINDOW_MS = 10 * 60 * 1000;

export function roundToTenMinutes(at: Date): Date {
  return new Date(Math.floor(at.getTime() / FINGERPRINT_WINDOW_MS) * FINGERPRINT_WINDOW_MS);
}

/** Lower-cased, whitespace-collapsed. */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export async function sha256HexOfBytes(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Copy into a fresh ArrayBuffer: some runtimes reject a view over a detached buffer.
  const digest = await crypto.subtle.digest("SHA-256", view.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  return sha256HexOfBytes(new TextEncoder().encode(value));
}

/**
 * `SHA-256(user_id | sorted photo hashes | normalized text | eaten_at to 10 min)`.
 *
 * Photo hashes are sorted so the same three photos in any order fingerprint
 * identically. Paired with the unique index on `(user_id, input_fingerprint)`, an
 * exact repeat is rejected; `save_meal` turns that into "you already logged this".
 */
export async function mealFingerprint(input: {
  userId: string;
  photoHashes?: readonly string[];
  text?: string | null;
  eatenAt: Date;
}): Promise<string> {
  const photoPart = [...(input.photoHashes ?? [])].sort().join(",");
  const textPart = normalizeText(input.text ?? "");
  const timePart = roundToTenMinutes(input.eatenAt).toISOString();
  return sha256Hex([input.userId, photoPart, textPart, timePart].join("|"));
}

export type ConfidenceBand = "high" | "medium" | "low";

/** Green above 0.8, amber 0.5–0.8, red below 0.5. */
export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence > 0.8) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

/**
 * Storage path for one photo: `<user id>/<uuid>.jpg`. The first segment must be the
 * owner's user id — the bucket policies pin access to it, and the service checks it
 * again before reading. One uuid per photo, so a photo's path never changes and
 * re-uploading the second of three photos cannot overwrite the first.
 */
export function mealPhotoPath(userId: string, photoId: string): string {
  return `${userId}/${photoId}.jpg`;
}

/** The private bucket the capture sheet uploads to and the service reads from. */
export const MEAL_PHOTO_BUCKET = "meal-photos";

/**
 * The prompt. It describes the job, not the shape: the shape is enforced by the
 * provider's structured-output mode, from `modelContractSchema` below. Repeating the
 * field list here would be a second copy free to drift from the first.
 */
export const SYSTEM_PROMPT = [
  "You are a nutrition estimator. Identify each distinct food item in the input.",
  "Use USDA-style typical values. If a nutrition label is visible, read it and set",
  "confidence 0.95. If a portion is ambiguous, pick the most common serving and lower",
  "confidence accordingly.",
  "List every distinct item separately, including drinks and condiments that carry",
  "meaningful calories. Do not invent items you cannot see or read.",
].join(" ");
