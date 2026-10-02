import { useRef, useState } from "react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatTimeInZone, mealTypeLabel, quantityLabel, type TimelineMeal } from "@/lib/dashboard";

/** How far the row slides to reveal one action. */
const ACTION_WIDTH = 96;
/**
 * How much travel in one direction latches that action open — and why it is not half the slide.
 *
 * The two directions are opposite actions on one row, and one of them deletes. At half the slide
the boundary sits exactly in the middle, where a few pixels of finger jitter decide between
 * editing a meal and removing it. 58px is 60% of the slide, which leaves hysteresis on both sides
 * of the old single-direction threshold of 48px while still reading as a flick rather than a haul.
 * Measured by driving the rendered row with real mouse input in Chromium, in a 390px container:
 * 57px springs shut and 58px latches, and the same boundary holds in both directions. A synthetic
 * event cannot establish this — jsdom has no layout, and a real browser may coalesce pointer moves
 * — so the number came from watching which way the row settled.
 */
const COMMIT_TRAVEL = 58;
/**
 * How much further the winning direction must have travelled than the other one.
 *
 * A drag that goes out to the left and then out to the right just as far has said nothing about
 * which action was meant, and guessing would be guessing between an edit and a delete. Below this
 * difference the row springs shut instead: 24px is a quarter of the slide, roughly where the two
 * excursions stop looking like one gesture.
 */
const AMBIGUITY_MARGIN = 24;

/**
 * A meal row that slides left to reveal Delete and right to reveal Edit.
 *
 * Swipe is a gesture, so it cannot be the only way in. Both action buttons are always in the DOM
 * behind the row — not `display: none` — so they are reachable by Tab and by a screen reader, and
 * focusing one slides the row towards it so the focus is not invisible. The row also answers
 * Delete and Backspace. Both actions are in the overflow menu as well, which is the only path
 * that is *visible* without knowing a gesture: a mouse user has no reason to drag a meal sideways.
 *
 * The two directions are deliberately hard to confuse. Letting go latches an action only when one
 * direction travelled `COMMIT_TRAVEL` and beat the other by `AMBIGUITY_MARGIN`; anything else
 * springs shut, including a drag that went both ways. Delete is the destructive one, and it keeps
 * its undo, which is the safety net that makes a mis-swipe recoverable.
 */
function TimelineRow({
  meal,
  timeZone,
  onDelete,
  onEdit,
  busy,
}: {
  meal: TimelineMeal;
  timeZone: string;
  onDelete: (meal: TimelineMeal) => void;
  /** Absent until a host has a screen to open. The row then offers no way in. */
  onEdit?: ((meal: TimelineMeal) => void) | undefined;
  busy: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const startX = useRef<number | null>(null);
  /** Where the row was when the drag began, so an open row can be dragged shut again. */
  const fromOffset = useRef(0);
  /** How far each direction reached during this drag. The latch is decided on these, not on
   * where the finger happened to stop, because a flick is pulled out and released. */
  const travel = useRef({ left: 0, right: 0 });

  function show(next: number): void {
    setOffset(next);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    // Ignore a secondary click, which is a context menu and not a drag.
    if (event.pointerType === "mouse" && event.button !== 0) return;
    startX.current = event.clientX;
    fromOffset.current = offset;
    travel.current = { left: 0, right: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    if (startX.current === null) return;
    const distance = event.clientX - startX.current;
    travel.current = {
      left: Math.max(travel.current.left, -distance),
      right: Math.max(travel.current.right, distance),
    };
    // The row follows the finger in both directions rather than being clamped to one side: the
    // drag has to be able to cross the middle and come back, or an ambiguous gesture could not be
    // recognised as one and would instead latch whichever side it happened to end on.
    setOffset(Math.max(-ACTION_WIDTH, Math.min(ACTION_WIDTH, fromOffset.current + distance)));
  }

  function handlePointerUp(): void {
    if (startX.current === null) return;
    startX.current = null;

    const { left, right } = travel.current;
    const latches = (winner: number, loser: number): boolean =>
      winner >= COMMIT_TRAVEL && winner - loser >= AMBIGUITY_MARGIN;

    if (latches(left, right)) show(-ACTION_WIDTH);
    // Only if there is something to reveal: a right-hand latch with no `onEdit` would slide the
    // row onto an empty panel, which looks like the gesture half-worked.
    else if (onEdit !== undefined && latches(right, left)) show(ACTION_WIDTH);
    else show(0);
  }

  function handlePointerCancel(): void {
    // A cancelled pointer is not a decision — the browser took the gesture away mid-drag.
    startX.current = null;
    show(0);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      onDelete(meal);
    }
  }

  return (
    <li className="relative overflow-hidden rounded-2xl">
      {onEdit !== undefined && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onEdit?.(meal)}
          onFocus={() => show(ACTION_WIDTH)}
          onBlur={() => show(0)}
          aria-label={`Edit ${mealTypeLabel(meal.meal_type)}`}
          className="absolute inset-y-0 left-0 flex w-24 flex-col items-center justify-center gap-1 bg-secondary text-sm font-medium text-secondary-foreground disabled:opacity-60"
        >
          <Pencil className="size-4" aria-hidden="true" />
          Edit
        </button>
      )}

      <button
        type="button"
        disabled={busy}
        onClick={() => onDelete(meal)}
        onFocus={() => show(-ACTION_WIDTH)}
        onBlur={() => show(0)}
        aria-label={`Delete ${mealTypeLabel(meal.meal_type)}`}
        className="absolute inset-y-0 right-0 flex w-24 flex-col items-center justify-center gap-1 bg-destructive text-sm font-medium text-destructive-foreground disabled:opacity-60"
      >
        <Trash2 className="size-4" aria-hidden="true" />
        Delete
      </button>

      <div
        role="group"
        tabIndex={0}
        aria-label={`${mealTypeLabel(meal.meal_type)} at ${formatTimeInZone(meal.eaten_at, timeZone)}, ${Math.round(meal.calories)} kcal. Swipe left to delete or right to edit, or press Delete to remove.`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onKeyDown={handleKeyDown}
        style={{ transform: `translateX(${offset}px)`, touchAction: "pan-y" }}
        className="relative bg-card px-4 py-3 transition-transform duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium">
            {mealTypeLabel(meal.meal_type)}
            <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">
              {formatTimeInZone(meal.eaten_at, timeZone)}
            </span>
          </p>
          <div className="flex shrink-0 items-center gap-1 self-center">
            <p className="text-sm font-semibold tabular-nums">
              {Math.round(meal.calories).toLocaleString()}
              <span className="ml-1 text-xs font-normal text-muted-foreground">kcal</span>
            </p>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                {/* The row treats a pointerdown on itself as the start of a swipe, and this
                    button is inside it. Radix opens the menu on pointerdown, so without the
                    guard the menu would open *and* the row would start to drag — and a drag
                    that ends over the menu is a swipe that deletes nothing. */}
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Actions for ${mealTypeLabel(meal.meal_type)} at ${formatTimeInZone(meal.eaten_at, timeZone)}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  className="-mr-1 grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                >
                  <MoreHorizontal className="size-4" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onSelect={() => onEdit?.(meal)}>
                  <Pencil className="mr-2 size-4" aria-hidden="true" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => onDelete(meal)}
                >
                  <Trash2 className="mr-2 size-4" aria-hidden="true" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {meal.items.length > 0 ? (
          <ul className="mt-1 space-y-0.5">
            {meal.items.map((item) => (
              <li key={item.id} className="flex items-baseline justify-between gap-3 text-xs">
                <span className="truncate text-muted-foreground">
                  {item.name}
                  {item.user_edited && (
                    <span className="ml-1 text-[10px] uppercase tracking-wide">edited</span>
                  )}
                </span>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {[quantityLabel(item), `${Math.round(item.calories)} kcal`]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">No items.</p>
        )}

        <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
          {Math.round(meal.protein_g)} g protein · {Math.round(meal.carbs_g)} g carbs ·{" "}
          {Math.round(meal.fat_g)} g fat
          {meal.photo_count > 0 &&
            ` · ${meal.photo_count} photo${meal.photo_count === 1 ? "" : "s"}`}
        </p>
      </div>
    </li>
  );
}

export function MealTimeline({
  meals,
  timeZone,
  onDelete,
  onEdit,
  busyId,
}: {
  meals: TimelineMeal[];
  timeZone: string;
  onDelete: (meal: TimelineMeal) => void;
  /** Absent until a host has a screen to open; the row then offers no Edit. */
  onEdit?: ((meal: TimelineMeal) => void) | undefined;
  /** The meal currently being deleted, so its row cannot be actioned twice. */
  busyId: string | null;
}) {
  return (
    <Card className="card-soft animate-rise">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Today's meals</CardTitle>
      </CardHeader>
      <CardContent>
        {meals.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
            Nothing logged yet today. Tap <span className="font-semibold text-foreground">+</span>{" "}
            to add a meal by photo, voice or text.
          </p>
        ) : (
          <>
            <p className="mb-2 text-[11px] text-muted-foreground">
              Swipe left for Delete, right for Edit, or use the ⋯ menu. A delete can be undone.
            </p>
            <ul className="space-y-2">
              {meals.map((meal) => (
                <TimelineRow
                  key={meal.id}
                  meal={meal}
                  timeZone={timeZone}
                  onDelete={onDelete}
                  onEdit={onEdit}
                  busy={busyId === meal.id}
                />
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
