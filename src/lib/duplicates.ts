/**
 * Duplicate detection: deciding whether a capture is a meal that has already been
 * logged.
 *
 * Two independent signals, because they catch different mistakes:
 *
 *   - the same photo, hashed, within a day — you re-photograph a plate you already
 *     logged, or double-tap through the sheet.
 *   - the same meal by name and time — you log lunch from a description at 12:40 and
 *     then again from a photo of the same lunch at 13:10.
 *
 * The comparison is over item names, fuzzy-matched at a normalised Levenshtein ratio
 * above 0.85, and it needs at least two of them: one matching name is a coincidence,
 * two is the same meal.
 *
 * All pure functions. The queries live in `duplicates-repo.ts`.
 */

/** Names above this similarity count as the same item. */
export const SIMILARITY_THRESHOLD = 0.85;

/** How far either side of the capture a meal can be and still be "the same meal". */
export const SIMILAR_WINDOW_MINUTES = 90;

/** How far back a matching photo hash counts. */
export const PHOTO_WINDOW_HOURS = 24;

/** One matching name is a coincidence; two is a meal. */
export const MIN_MATCHING_ITEMS = 2;

/**
 * Lower-cased, punctuation removed, whitespace collapsed.
 *
 * "Grilled chicken, 2 pieces" and "grilled chicken 2 pieces" have to compare equal
 * before the distance is measured, or commas and spacing dominate the ratio.
 */
export function normalizeItemName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Levenshtein distance, as a rolling two-row table. */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length] ?? 0;
}

/**
 * 1 is identical, 0 is nothing in common. Normalised by the longer of the two, so a
 * short name inside a long one does not score as a match.
 */
export function similarityRatio(a: string, b: string): number {
  const left = normalizeItemName(a);
  const right = normalizeItemName(b);
  if (left === "" && right === "") return 1;
  if (left === "" || right === "") return 0;
  const longest = Math.max(left.length, right.length);
  return 1 - levenshteinDistance(left, right) / longest;
}

/** True when the two names are the same food, allowing for spelling and phrasing. */
export function namesMatch(a: string, b: string, threshold = SIMILARITY_THRESHOLD): boolean {
  return similarityRatio(a, b) >= threshold;
}

/**
 * How many of `candidateNames` have a counterpart in `existingNames`, counting each
 * existing name once.
 *
 * Greedy on purpose: with "rice" and "rice" against a single "rice", one match is
 * right, not two. Each existing name can only be claimed once.
 */
export function countMatchingNames(
  candidateNames: readonly string[],
  existingNames: readonly string[],
  threshold = SIMILARITY_THRESHOLD,
): number {
  const claimed = new Set<number>();
  let matches = 0;

  for (const candidate of candidateNames) {
    let bestIndex = -1;
    let bestScore = threshold;
    for (let index = 0; index < existingNames.length; index += 1) {
      if (claimed.has(index)) continue;
      const score = similarityRatio(candidate, existingNames[index] ?? "");
      if (score >= bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) {
      claimed.add(bestIndex);
      matches += 1;
    }
  }
  return matches;
}

/** A meal that may already cover this capture. */
export interface CandidateMeal {
  id: string;
  eatenAt: string;
  mealType: string;
  source: string;
  itemNames: readonly string[];
  photoHashes: readonly string[];
}

export interface DuplicateMatch {
  meal: CandidateMeal;
  /** How many item names lined up. */
  matchedItems: number;
  /** Why it was flagged, for the banner's wording. */
  reason: "photo" | "items";
}

/**
 * The first recent meal that looks like this one, or null.
 *
 * Photos are checked before names: a hash match is exact, and it is the only signal
 * that can be acted on before the model has been called.
 */
export function findDuplicate(
  candidate: { itemNames: readonly string[]; photoHashes: readonly string[] },
  recent: readonly CandidateMeal[],
): DuplicateMatch | null {
  const wanted = new Set(candidate.photoHashes.filter((hash) => hash !== ""));
  if (wanted.size > 0) {
    for (const meal of recent) {
      if (meal.photoHashes.some((hash) => wanted.has(hash))) {
        return { meal, matchedItems: 0, reason: "photo" };
      }
    }
  }

  let best: DuplicateMatch | null = null;
  for (const meal of recent) {
    const matchedItems = countMatchingNames(candidate.itemNames, meal.itemNames);
    if (matchedItems < MIN_MATCHING_ITEMS) continue;
    if (best === null || matchedItems > best.matchedItems) {
      best = { meal, matchedItems, reason: "items" };
    }
  }
  return best;
}

/** "12:40" in the device's zone, for the banner and the already-logged notice. */
export function formatMealTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
