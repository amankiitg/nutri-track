/**
 * The edit sheet: a meal that is already on record, opened in the review screen.
 *
 * A sheet of its own rather than a mode on `CaptureSheet`. That one's job is to get a meal out of a
 * photo, a voice note or some typing, and there is nothing to capture about a meal that already
 * exists — it would have had to hide its tabs, its camera button and its reason for existing. What
 * the two do share is the screen the meal is checked on, so `ReviewScreen` takes an edit context
 * rather than being copied.
 *
 * The one thing this sheet does that the capture flow does too is call the model, and only for a
 * re-analysis: the photos are already in storage, so they can be read again without the person
 * retaking them.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { supabase } from "@/integrations/supabase/client";
import {
  buildParseRequest,
  describeParseFailure,
  requestParseMeal,
  toParseFailure,
} from "@/lib/capture";
import { fetchMealForEdit, type MealForEdit } from "@/lib/duplicates-repo";
import { reviewItemFromDraft, reviewItemFromExisting, type ReviewItem } from "@/lib/review";
import { guessMealType, type MealSource, type MealType } from "@shared/meal-parse";
import { ReviewScreen } from "./ReviewScreen";

export interface EditMealSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mealId: string;
  /** The profile's zone, so a guessed meal type agrees with the rest of the app. */
  timeZone: string;
  /** Today's target, for the wording around the remaining-calories line. */
  targetCalories: number | null;
  /**
   * What is left of today, from the same Postgres function the ring reads. It already counts the
   * meal being edited, which is why the review screen adds that meal's stored total back before
   * it subtracts the new one.
   */
  remainingToday: number | null;
  /** Called once a change is saved, so the caller can refetch the day. */
  onSaved: () => void;
}

/**
 * The stored enums already are these values, so these narrow rather than cast.
 *
 * The fallbacks are unreachable through the app — the columns are enums — but a `string` from
 * PostgREST has to become a union somehow, and guessing is better than a blind assertion that
 * would be wrong silently if the column ever changed.
 */
function mealTypeOf(value: string): MealType | null {
  return value === "breakfast" || value === "lunch" || value === "dinner" || value === "snack"
    ? value
    : null;
}

function mealSourceOf(value: string): MealSource {
  return value === "voice" || value === "text" ? value : "photo";
}

export function EditMealSheet({
  open,
  onOpenChange,
  mealId,
  timeZone,
  targetCalories,
  remainingToday,
  onSaved,
}: EditMealSheetProps) {
  const [meal, setMeal] = useState<MealForEdit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isReanalyzing, setIsReanalyzing] = useState(false);
  /** Set only by a re-analysis. Until then the screen shows the meal's own rows. */
  const [reanalyzed, setReanalyzed] = useState<ReviewItem[] | null>(null);
  /** Bumped by a re-analysis: the screen owns its items from mount, so replacing them is a remount. */
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setMeal(null);
    setReanalyzed(null);
    setError(null);
    setVersion(0);

    void fetchMealForEdit(mealId)
      .then((loaded) => {
        if (cancelled) return;
        setMeal(loaded);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : "Could not load that meal.");
      });

    return () => {
      cancelled = true;
    };
  }, [open, mealId]);

  /** The meal's own items, as the screen should show them, holding their row ids. */
  const storedItems = useMemo(
    () => (meal === null ? [] : meal.items.map((row) => reviewItemFromExisting(row))),
    [meal],
  );

  /**
   * Held across renders rather than generated inline.
   *
   * Nothing on this screen reads it: `update_meal` takes no idempotency key, and the thing a key
   * protects against — a double tap creating two meals — cannot happen to a row that already
   * exists. It is passed because the screen's props are shared with the capture flow, and
   * generating a fresh one on every render would be a value that changes for no reason.
   */
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  /** Re-reads the stored photos with a hint, replacing every item. */
  async function reanalyze(hint: string): Promise<void> {
    if (meal === null) return;
    setIsReanalyzing(true);
    setError(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Your session has expired. Sign in again.");

      const parsed = await requestParseMeal(
        token,
        buildParseRequest({
          // The photos are the only thing there is to read again: an edit never had words of its
          // own, and the service prompts for a photo when told the source is one.
          source: "photo",
          text: null,
          photoPaths: meal.photo_paths,
          eatenAt: new Date(meal.eaten_at),
          mealType: mealTypeOf(meal.meal_type),
          hint,
        }),
      );

      // Every item is fresh and names no row. When this is saved, `update_meal` deletes the rows
      // the payload no longer names and inserts these, which is precisely what the confirmation
      // said would happen to the model's original numbers.
      setReanalyzed(parsed.items.map((draft) => reviewItemFromDraft(draft)));
      setVersion((current) => current + 1);
    } catch (caught) {
      // The screen is left as it is, so the edits the confirmation warned about are still there
      // to keep, and the reason the hint did not work is on screen above it.
      setError(describeParseFailure(toParseFailure(caught)));
    } finally {
      setIsReanalyzing(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[92dvh] overflow-y-auto pb-0">
        <SheetHeader className="text-left">
          <SheetTitle>Edit this meal</SheetTitle>
          <SheetDescription>
            Correct anything the model got wrong. Nothing about your day changes until you save.
          </SheetDescription>
        </SheetHeader>

        {error !== null && (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm"
          >
            {error}
          </p>
        )}

        {meal === null && error === null && (
          <p className="mt-4 text-sm text-muted-foreground">Loading the meal…</p>
        )}

        {meal !== null && (
          <ReviewScreen
            // A re-analysis replaces every item, and the screen takes its items on mount, so a new
            // mount is how they are replaced.
            key={version}
            edit={{
              mealId: meal.id,
              canReanalyze: meal.photo_paths.length > 0,
              onUpdated: () => onSaved(),
            }}
            // The provenance of *this screen*, not of the meal: no model produced these items for
            // this session, and the header says "editing a saved meal" rather than naming a model.
            meta={{ source: mealSourceOf(meal.source), model: null, attempts: 0 }}
            initialItems={reanalyzed ?? storedItems}
            // The capture-shaped props below are inert here: an edit saves through `update_meal`,
            // which takes no fingerprint, key, photos or source, and shows no thumbnails. They
            // carry the meal's real values rather than blanks so that nothing on this screen is a
            // placeholder that reads like data.
            photoPaths={meal.photo_paths}
            photoHashes={meal.photo_hashes}
            photoPreviews={[]}
            transcript={null}
            inputFingerprint={meal.input_fingerprint}
            idempotencyKey={idempotencyKey}
            targetCalories={targetCalories}
            remainingToday={remainingToday}
            eatenAt={new Date(meal.eaten_at)}
            mealType={
              mealTypeOf(meal.meal_type) ?? guessMealType(new Date(meal.eaten_at), timeZone)
            }
            notes={meal.notes}
            onSaved={onSaved}
            // Closing without saving is the whole of Cancel: the meal's photos belong to a meal
            // that is staying, so unlike a capture there is nothing to clean up.
            onDiscard={() => onOpenChange(false)}
            onReanalyze={reanalyze}
            isReanalyzing={isReanalyzing}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
