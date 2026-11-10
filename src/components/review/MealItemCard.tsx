/**
 * One item, every field editable.
 *
 * The two edit paths are deliberately different and the component does not hide that:
 * grams scales the nutrients, a nutrient changes only itself. Whichever one is used,
 * the flags are recomputed from the numbers on screen rather than carried over from
 * the model's reply.
 */
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  flagsFor,
  formatFatAmount,
  NUTRIENT_FIELDS,
  NUTRIENT_LABELS,
  setCookingFat,
  setGrams,
  setNutrient,
  setQuantity,
  setText,
  type NutrientField,
  type ReviewItem,
} from "@/lib/review";
import type { CookingFat } from "@shared/meal-parse";
import { ConfidenceDot } from "./ConfidenceDot";

/** The one-tap amounts. None removes the fat; a tablespoon is three teaspoons. */
const FAT_AMOUNTS: ReadonlyArray<{ label: string; tsp: number | null }> = [
  { label: "None", tsp: null },
  { label: "1 tsp", tsp: 1 },
  { label: "2 tsp", tsp: 2 },
  { label: "1 tbsp", tsp: 3 },
];

/** The type toggle only offers the three fats with fixed values; dressing stays as the model set it. */
const FAT_TYPES = ["oil", "ghee", "butter"] as const;

/** Keeps the current type, changing only the amount. Dressing keeps its per-tsp values. */
function withAmount(item: ReviewItem, tsp: number | null): CookingFat | null {
  if (tsp === null) return null;
  const current = item.cooking_fat;
  return {
    type: (current?.type ?? "oil") as CookingFat["type"],
    amount_tsp: tsp,
    kcal_per_tsp: current?.type === "dressing" ? current.kcal_per_tsp : null,
    fat_per_tsp: current?.type === "dressing" ? current.fat_per_tsp : null,
  };
}

/** Changes the type to one of oil/ghee/butter, keeping the current amount. */
function withType(item: ReviewItem, type: "oil" | "ghee" | "butter"): CookingFat {
  return {
    type,
    amount_tsp: item.cooking_fat?.amount_tsp ?? 0,
    kcal_per_tsp: null,
    fat_per_tsp: null,
  };
}

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

/**
 * The calories box: whole kcal on screen, the stored value untouched.
 *
 * A grams rescale or a fat chip leaves calories at a tenth (245.3), which is what is saved.
 * The box shows it rounded, but only while nobody is typing in it: rounding a controlled
 * input on every keystroke would rewrite what was just typed ("12." would become "12"), so
 * while focused it shows the draft as typed, and focusing alone writes nothing.
 */
function CaloriesInput({
  item,
  index,
  onChange,
}: Pick<MealItemCardProps, "item" | "index" | "onChange">) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(Math.round(item.calories));
  return (
    <input
      inputMode="decimal"
      value={shown}
      onFocus={() => setDraft(shown)}
      onBlur={() => setDraft(null)}
      onChange={(event) => {
        setDraft(event.target.value);
        onChange(setNutrient(item, "calories", event.target.value));
      }}
      aria-label={`${NUTRIENT_LABELS.calories} for item ${index + 1}`}
      className="h-9 w-full rounded-lg border border-input bg-background px-2 text-base"
    />
  );
}

export function MealItemCard({ item, index, onChange, onDelete }: MealItemCardProps) {
  const flags = flagsFor(item);
  const cookingFat = item.cooking_fat;

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
          className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1 py-1 text-base font-medium hover:border-input focus:border-input focus:outline-none"
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
            className="h-9 w-full rounded-lg border border-input bg-background px-2 text-base"
          />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Unit</span>
          <input
            value={item.unit ?? ""}
            onChange={(event) => onChange(setText(item, "unit", event.target.value))}
            aria-label={`Unit of item ${index + 1}`}
            placeholder="cup"
            className="h-9 w-full rounded-lg border border-input bg-background px-2 text-base"
          />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Grams</span>
          <input
            inputMode="decimal"
            value={valueOf(item.grams)}
            onChange={(event) => onChange(setGrams(item, event.target.value))}
            aria-label={`Grams of item ${index + 1}`}
            className="h-9 w-full rounded-lg border border-input bg-background px-2 text-base font-medium"
          />
        </label>
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">
        Changing portion or grams rescales everything below. Editing a nutrient changes only that
        nutrient.
      </p>

      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {NUTRIENT_FIELDS.map((field) => (
          <label key={field} className="space-y-1 text-xs">
            <span className="text-muted-foreground">{NUTRIENT_LABELS[field]}</span>
            {field === "calories" ? (
              <CaloriesInput item={item} index={index} onChange={onChange} />
            ) : (
              <input
                inputMode="decimal"
                value={valueOf(item[field])}
                onChange={(event) =>
                  onChange(setNutrient(item, field as NutrientField, event.target.value))
                }
                aria-label={`${NUTRIENT_LABELS[field]} for item ${index + 1}`}
                className="h-9 w-full rounded-lg border border-input bg-background px-2 text-base"
              />
            )}
          </label>
        ))}
      </div>

      {cookingFat !== null && (
        <div className="mt-3 space-y-2 rounded-xl bg-muted/30 p-2">
          <p className="text-[11px] text-muted-foreground">
            Assumes {formatFatAmount(cookingFat.amount_tsp)} {cookingFat.type}
          </p>
          <div className="flex flex-wrap gap-1">
            {FAT_AMOUNTS.map((option) => {
              const active =
                option.tsp === null ? cookingFat === null : cookingFat.amount_tsp === option.tsp;
              return (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={active}
                  className={`rounded-full border px-2.5 py-1 text-[11px] ${
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-background text-muted-foreground"
                  }`}
                  onClick={() => onChange(setCookingFat(item, withAmount(item, option.tsp)))}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-1">
            {FAT_TYPES.map((type) => {
              const active = cookingFat.type === type;
              return (
                <button
                  key={type}
                  type="button"
                  aria-pressed={active}
                  className={`rounded-full border px-2.5 py-1 text-[11px] ${
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-background text-muted-foreground"
                  }`}
                  onClick={() => onChange(setCookingFat(item, withType(item, type)))}
                >
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {item.userEdited && <p className="mt-2 text-[11px] text-muted-foreground">Edited by you</p>}
    </li>
  );
}
