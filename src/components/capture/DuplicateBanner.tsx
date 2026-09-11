/**
 * The "you may have logged this already" banner.
 *
 * Three answers, because there are three honest situations:
 *
 *   - it is a new meal      — a second helping, or the same plate photographed twice
 *                             on purpose. Carries on.
 *   - open existing         — you meant the meal you already logged. Shows it.
 *   - copy that meal        — same food, another portion. Skips the model call and
 *                             starts from the items you already checked.
 *
 * The third is only offered for a photo match, because it is the only case where the
 * items are not yet known: by the time a name match is possible, the model has already
 * been called and there is nothing left to skip.
 */
import { useState } from "react";
import { AlertTriangle, ChevronDown, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatMealTime, type CandidateMeal, type DuplicateMatch } from "@/lib/duplicates";
import type { SavedItem } from "@/lib/duplicates-repo";

const MEAL_LABELS: Record<string, string> = {
  breakfast: "breakfast",
  lunch: "lunch",
  dinner: "dinner",
  snack: "snack",
};

export interface DuplicateBannerProps {
  match: DuplicateMatch;
  /** The already-logged meal's items, once they have been fetched. */
  existingItems: readonly SavedItem[] | null;
  onKeepAsNew: () => void;
  onCopyExisting: () => void;
  busy?: boolean;
}

export function DuplicateBanner({
  match,
  existingItems,
  onKeepAsNew,
  onCopyExisting,
  busy = false,
}: DuplicateBannerProps) {
  const [showExisting, setShowExisting] = useState(false);
  const time = formatMealTime(match.meal.eatenAt);
  const label = MEAL_LABELS[match.meal.mealType] ?? "meal";

  const message =
    match.reason === "photo"
      ? `One of those photos was already logged as your ${time} ${label}.`
      : `This looks like your ${time} ${label}: ${String(match.matchedItems)} of the items match.`;

  return (
    <div className="mt-4 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3">
      <p className="flex items-start gap-2 text-sm">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden="true" />
        <span>{message}</span>
      </p>

      {match.reason === "items" && (
        <p className="mt-1 pl-6 text-xs text-muted-foreground">
          {match.meal.itemNames.slice(0, 6).join(" · ")}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2 pl-6">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-full"
          disabled={busy}
          onClick={onKeepAsNew}
        >
          It is a new meal
        </Button>

        {existingItems !== null && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-full"
            onClick={() => setShowExisting((open) => !open)}
          >
            <ChevronDown className="mr-1 size-3.5" aria-hidden="true" />
            Open existing
          </Button>
        )}

        {match.reason === "photo" && (
          <Button
            type="button"
            size="sm"
            className="rounded-full"
            disabled={busy || existingItems === null}
            onClick={onCopyExisting}
          >
            <Copy className="mr-1 size-3.5" aria-hidden="true" />
            Copy that meal instead
          </Button>
        )}
      </div>

      {showExisting && existingItems !== null && (
        <ul className="mt-3 space-y-1 rounded-xl bg-background/70 p-2 pl-6">
          <li className="text-xs text-muted-foreground">Already logged at {time}:</li>
          {existingItems.length === 0 && (
            <li className="text-xs">That meal has no items recorded.</li>
          )}
          {existingItems.map((item) => (
            <li key={item.name} className="flex justify-between text-xs">
              <span>{item.name}</span>
              <span className="text-muted-foreground">{Math.round(item.calories)} kcal</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
