import { useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTimeInZone, mealTypeLabel, quantityLabel, type TimelineMeal } from "@/lib/dashboard";

/** How far the row slides to reveal the action. */
const ACTION_WIDTH = 96;
/** Past this much travel, letting go opens rather than springs back. */
const OPEN_THRESHOLD = ACTION_WIDTH / 2;

/**
 * A meal row that slides left to reveal Delete.
 *
 * Swipe is a gesture, so it cannot be the only way in. The action button is always in
 * the DOM behind the row — not `display: none` — which means it is reachable by Tab and
 * by a screen reader, and focusing it opens the row so the focus is not invisible. The
 * row itself also answers Delete and Backspace. The hint above the list tells everyone
 * else the gesture exists.
 */
function TimelineRow({
  meal,
  timeZone,
  onDelete,
  busy,
}: {
  meal: TimelineMeal;
  timeZone: string;
  onDelete: (meal: TimelineMeal) => void;
  busy: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const startX = useRef<number | null>(null);

  const open = offset < 0;

  function settle(next: boolean): void {
    setOffset(next ? -ACTION_WIDTH : 0);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    // Ignore a secondary click, which is a context menu and not a drag.
    if (event.pointerType === "mouse" && event.button !== 0) return;
    startX.current = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    if (startX.current === null) return;
    const travel = event.clientX - startX.current;
    const from = open ? -ACTION_WIDTH : 0;
    // Clamped to the left only: there is nothing to reveal on the right, and a row that
    // slides both ways makes the whole list feel loose.
    setOffset(Math.min(0, Math.max(-ACTION_WIDTH, from + travel)));
  }

  function handlePointerUp(): void {
    if (startX.current === null) return;
    startX.current = null;
    settle(offset < -OPEN_THRESHOLD);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      onDelete(meal);
    }
  }

  return (
    <li className="relative overflow-hidden rounded-2xl">
      <button
        type="button"
        disabled={busy}
        onClick={() => onDelete(meal)}
        onFocus={() => settle(true)}
        onBlur={() => settle(false)}
        aria-label={`Delete ${mealTypeLabel(meal.meal_type)}`}
        className="absolute inset-y-0 right-0 flex w-24 flex-col items-center justify-center gap-1 bg-destructive text-sm font-medium text-destructive-foreground disabled:opacity-60"
      >
        <Trash2 className="size-4" aria-hidden="true" />
        Delete
      </button>

      <div
        role="group"
        tabIndex={0}
        aria-label={`${mealTypeLabel(meal.meal_type)} at ${formatTimeInZone(meal.eaten_at, timeZone)}, ${Math.round(meal.calories)} kcal. Swipe left or press Delete to remove.`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
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
          <p className="text-sm font-semibold tabular-nums">
            {Math.round(meal.calories).toLocaleString()}
            <span className="ml-1 text-xs font-normal text-muted-foreground">kcal</span>
          </p>
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
  busyId,
}: {
  meals: TimelineMeal[];
  timeZone: string;
  onDelete: (meal: TimelineMeal) => void;
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
              Swipe a meal left, or focus it and press Delete, to remove it. You can undo.
            </p>
            <ul className="space-y-2">
              {meals.map((meal) => (
                <TimelineRow
                  key={meal.id}
                  meal={meal}
                  timeZone={timeZone}
                  onDelete={onDelete}
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
