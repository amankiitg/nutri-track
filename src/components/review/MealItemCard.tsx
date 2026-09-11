/**
 * One item, every field editable.
 *
 * The two edit paths are deliberately different and the component does not hide that:
 * grams scales the nutrients, a nutrient changes only itself. Whichever one is used,
 * the flags are recomputed from the numbers on screen rather than carried over from
 * the model's reply.
 */
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  flagsFor,
  NUTRIENT_FIELDS,
  NUTRIENT_LABELS,
  setGrams,
  setNutrient,
  setQuantity,
  setText,
  type NutrientField,
  type ReviewItem,
} from "@/lib/review";
import { ConfidenceDot } from "./ConfidenceDot";

export interface MealItemCardProps {
  item: ReviewItem;
  index: number;
  onChange: (item: ReviewItem) => void;
  onDelete: () => void;
}

/** `null` renders as an empty box, so "unknown" looks different from "zero". */
function valueOf(value: number | null): string {
  return value === null ? "" : String(value);
}

export function MealItemCard({ item, index, onChange, onDelete }: MealItemCardProps) {
  const flags = flagsFor(item);

  return (
    <li className="rounded-2xl border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium">
          {index + 1}
        </span>
        <input
          value={item.name}
          onChange={(event) => onChange(setText(item, "name", event.target.value))}
          aria-label={`Name of item ${index + 1}`}
          placeholder="What was it?"
          className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1 py-1 text-sm font-medium hover:border-input focus:border-input focus:outline-none"
        />
        <ConfidenceDot confidence={item.confidence} />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Delete item ${index + 1}`}
          onClick={onDelete}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {flags.needsReview && (
        <ul className="mt-2 space-y-1 rounded-xl bg-amber-500/10 p-2">
          {flags.reasons.map((reason) => (
            <li key={reason} className="text-xs text-amber-700 dark:text-amber-400">
              {reason}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 grid grid-cols-3 gap-2">
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Portion</span>
          <input
            inputMode="decimal"
            value={valueOf(item.quantity)}
            onChange={(event) => onChange(setQuantity(item, event.target.value))}
            aria-label={`Portion of item ${index + 1}`}
            className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
          />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Unit</span>
          <input
            value={item.unit ?? ""}
            onChange={(event) => onChange(setText(item, "unit", event.target.value))}
            aria-label={`Unit of item ${index + 1}`}
            placeholder="cup"
            className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
          />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Grams</span>
          <input
            inputMode="decimal"
            value={valueOf(item.grams)}
            onChange={(event) => onChange(setGrams(item, event.target.value))}
            aria-label={`Grams of item ${index + 1}`}
            className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm font-medium"
          />
        </label>
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">
        Changing grams rescales everything below. Editing a nutrient changes only that nutrient.
      </p>

      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {NUTRIENT_FIELDS.map((field) => (
          <label key={field} className="space-y-1 text-xs">
            <span className="text-muted-foreground">{NUTRIENT_LABELS[field]}</span>
            <input
              inputMode="decimal"
              value={valueOf(item[field])}
              onChange={(event) =>
                onChange(setNutrient(item, field as NutrientField, event.target.value))
              }
              aria-label={`${NUTRIENT_LABELS[field]} for item ${index + 1}`}
              className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
            />
          </label>
        ))}
      </div>

      {item.userEdited && <p className="mt-2 text-[11px] text-muted-foreground">Edited by you</p>}
    </li>
  );
}
