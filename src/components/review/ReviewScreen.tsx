/**
 * The review screen. The only route from a capture to a saved meal.
 *
 * It owns the idempotency key — generated once, when it mounts, so a double tap on
 * Save cannot log two meals — and the fingerprint, which was computed when the capture
 * was parsed and covers the photos, the words and the ten-minute window.
 *
 * Discard and Cancel delete the photos this capture uploaded. So does closing the
 * sheet without saving: see the effect in `CaptureSheet`.
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import type { MealType } from "@shared/meal-parse";
import type { ParseResponse } from "@/lib/capture";
import { formatMealTime } from "@/lib/duplicates";
import {
  blankReviewItem,
  canSave,
  mealTotals,
  remainingCalories,
  toSaveMealArgs,
  type ReviewItem,
  type ReviewMeta,
  type SaveMealResult,
} from "@/lib/review";
import { MealItemCard } from "./MealItemCard";

const MEAL_TYPE_LABELS: Record<MealType, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
};

const MACRO_LABELS: Array<{ key: "protein_g" | "carbs_g" | "fat_g"; label: string }> = [
  { key: "protein_g", label: "Protein" },
  { key: "carbs_g", label: "Carbs" },
  { key: "fat_g", label: "Fat" },
];

export interface ReviewScreenProps {
  meta: ReviewMeta;
  /** The starting items. The screen owns them from here. */
  initialItems: readonly ReviewItem[];
  photoPaths: readonly string[];
  photoHashes: readonly string[];
  /** Local object URLs for the thumbnails, so no storage round trip is needed. */
  photoPreviews: readonly string[];
  /** What was said or typed, shown when there are no photos. */
  transcript: string | null;
  inputFingerprint: string;
  /** Stable for this review session, so a retry cannot log the meal twice. */
  idempotencyKey: string;
  /** Today's target, for the remaining-calories line. */
  targetCalories: number | null;
  eatenAt: Date;
  mealType: MealType;
  notes: string | null;
  onSaved: (saved: SaveMealResult) => void;
  /** Called for Discard and Cancel. The caller deletes the photos. */
  onDiscard: () => void;
  /** Re-runs the parse with a hint, reusing the same photos. */
  onReanalyze: (hint: string) => Promise<void>;
  isReanalyzing: boolean;
}

export function ReviewScreen({
  meta,
  initialItems,
  photoPaths,
  photoHashes,
  photoPreviews,
  transcript,
  inputFingerprint,
  idempotencyKey,
  targetCalories,
  eatenAt,
  mealType,
  notes,
  onSaved,
  onDiscard,
  onReanalyze,
  isReanalyzing,
}: ReviewScreenProps) {
  const [items, setItems] = useState<ReviewItem[]>(() => [...initialItems]);
  const [type, setType] = useState<MealType>(mealType);
  const [when, setWhen] = useState(() => eatenAt);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hintOpen, setHintOpen] = useState(false);
  const [hint, setHint] = useState("");
  const [confirmReanalyze, setConfirmReanalyze] = useState(false);

  /**
   * Generated once by the capture sheet and stable for this review session, so every
   * attempt to save this meal carries the same key and a double tap cannot log two.
   */
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const totals = useMemo(() => mealTotals(items), [items]);
  const remaining = targetCalories === null ? null : remainingCalories(targetCalories, totals);

  /** How many items the user has changed, which a re-analysis would replace. */
  const editedCount = items.filter((item) => item.userEdited).length;

  function replaceItem(next: ReviewItem): void {
    setItems((current) => current.map((item) => (item.id === next.id ? next : item)));
  }

  function deleteItem(id: string): void {
    setItems((current) => current.filter((item) => item.id !== id));
  }

  async function save(): Promise<void> {
    setIsSaving(true);
    setError(null);
    try {
      const args = toSaveMealArgs({
        items,
        mealType: type,
        source: meta.source,
        eatenAt: when,
        notes,
        photoPaths,
        photoHashes,
        inputFingerprint,
        idempotencyKey,
      });

      const { data, error: rpcError } = await supabase.rpc("save_meal", args);
      if (rpcError) throw new Error(rpcError.message);

      const saved = data as SaveMealResult | null;
      if (!saved?.meal_id) throw new Error("The meal was not saved.");

      // created: false means the service recognised this meal as one already on
      // record — the same fingerprint, or a replay of this very key. Saying "saved"
      // would be a lie, and the user would go looking for a second meal that is not
      // there.
      if (!saved.created) {
        setSavedNotice(
          `You already logged this meal. It is on your record for ${formatMealTime(new Date(when).toISOString())}.`,
        );
        return;
      }

      onSaved(saved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the meal.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="rounded-2xl border border-border bg-muted/30 p-3">
        {photoPreviews.length > 0 ? (
          <ul className="flex gap-2">
            {photoPreviews.map((url, index) => (
              <li key={url}>
                <img
                  src={url}
                  alt={`Photo ${index + 1} of this meal`}
                  className="size-14 rounded-xl object-cover"
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">
            {transcript !== null && transcript !== ""
              ? `“${transcript}”`
              : meta.source === "voice"
                ? "From your voice note"
                : "From your description"}
          </p>
        )}

        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="space-y-1.5 text-sm">
            <span className="text-muted-foreground">Meal</span>
            <select
              value={type}
              onChange={(event) => setType(event.target.value as MealType)}
              className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"
            >
              {(Object.keys(MEAL_TYPE_LABELS) as MealType[]).map((value) => (
                <option key={value} value={value}>
                  {MEAL_TYPE_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="text-muted-foreground">Eaten at</span>
            <input
              type="datetime-local"
              value={toLocalInputValue(when)}
              onChange={(event) => {
                const parsed = new Date(event.target.value);
                if (!Number.isNaN(parsed.getTime())) setWhen(parsed);
              }}
              className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"
            />
          </label>
        </div>

        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {items.length} item{items.length === 1 ? "" : "s"}
            {meta.model === null ? " · copied from an earlier meal" : ` · ${meta.model}`}
            {meta.attempts > 1 ? " · retried" : ""}
          </span>
          <button
            type="button"
            className="inline-flex items-center gap-1 underline"
            onClick={() => setHintOpen((open) => !open)}
          >
            <Sparkles className="size-3.5" aria-hidden="true" />
            Re-analyze with a hint
          </button>
        </div>

        {hintOpen && (
          <div className="mt-2 space-y-2">
            <div className="flex gap-2">
              <input
                value={hint}
                onChange={(event) => setHint(event.target.value)}
                aria-label="Hint for re-analysis"
                placeholder="e.g. the rice was a small portion, not a cup"
                className="h-10 flex-1 rounded-xl border border-input bg-background px-3 text-sm"
              />
              <Button
                type="button"
                variant="outline"
                className="rounded-full"
                disabled={hint.trim() === "" || isReanalyzing}
                onClick={() => {
                  // Re-analyzing throws away whatever was typed. When there is
                  // nothing to lose it just runs; when there is, it asks first.
                  if (editedCount > 0) setConfirmReanalyze(true);
                  else void onReanalyze(hint.trim());
                }}
              >
                {isReanalyzing ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  "Go"
                )}
              </Button>
            </div>

            {editedCount > 0 && (
              <p className="text-[11px] text-muted-foreground">
                {editedCount === 1
                  ? "1 item has been edited by you."
                  : `${editedCount} items have been edited by you.`}{" "}
                Re-analyzing will replace them.
              </p>
            )}
          </div>
        )}
      </div>

      <ul className="space-y-3">
        {items.map((item, index) => (
          <MealItemCard
            key={item.id}
            item={item}
            index={index}
            onChange={replaceItem}
            onDelete={() => deleteItem(item.id)}
          />
        ))}
      </ul>

      <Button
        type="button"
        variant="outline"
        className="w-full rounded-full"
        onClick={() => setItems((current) => [...current, blankReviewItem()])}
      >
        <Plus className="mr-1.5 size-4" aria-hidden="true" />
        Add item
      </Button>

      {savedNotice !== null && (
        <p
          role="status"
          className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          {savedNotice}
        </p>
      )}

      {error !== null && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm"
        >
          {error}
        </p>
      )}

      {/* Sticky, because the totals are the thing you are deciding about. */}
      <div className="sticky bottom-0 -mx-6 space-y-3 border-t border-border bg-background/95 px-6 py-3 backdrop-blur">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-muted-foreground">This meal</span>
          <span className="text-lg font-semibold">{Math.round(totals.calories)} kcal</span>
        </div>
        <dl className="grid grid-cols-3 gap-2 text-xs">
          {MACRO_LABELS.map(({ key, label }) => (
            <div key={key} className="flex justify-between rounded-lg bg-muted/50 px-2 py-1">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium">{Math.round(totals[key])} g</dd>
            </div>
          ))}
        </dl>
        {remaining !== null && (
          <p className="text-xs text-muted-foreground">
            {remaining >= 0
              ? `${Math.round(remaining)} kcal left of today's ${Math.round(targetCalories ?? 0)}`
              : `${Math.abs(Math.round(remaining))} kcal over today's ${Math.round(targetCalories ?? 0)}`}
          </p>
        )}

        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="rounded-full"
            disabled={isSaving}
            onClick={onDiscard}
          >
            <Trash2 className="mr-1.5 size-4" aria-hidden="true" />
            Discard
          </Button>
          <Button
            type="button"
            className="flex-1 rounded-full"
            disabled={!canSave(items) || isSaving}
            onClick={() => void save()}
          >
            {isSaving ? (
              <>
                <Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden="true" />
                Saving…
              </>
            ) : (
              "Save meal"
            )}
          </Button>
        </div>
      </div>

      {/*
        A re-analysis replaces every item, so anything the user has corrected goes with
        it. Asking first costs one tap and saves the work of re-entering four items.
      */}
      <AlertDialog open={confirmReanalyze} onOpenChange={setConfirmReanalyze}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-analyze and lose your edits?</AlertDialogTitle>
            <AlertDialogDescription>
              {editedCount === 1
                ? "1 item has been changed by you. Re-analyzing replaces all the items with what the model returns."
                : `${editedCount} items have been changed by you. Re-analyzing replaces all the items with what the model returns.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my edits</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmReanalyze(false);
                void onReanalyze(hint.trim());
              }}
            >
              Re-analyze anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in the device's own zone. */
function toLocalInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
