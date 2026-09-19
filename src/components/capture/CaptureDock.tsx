/**
 * The add-meal button and the sheet it opens, as one unit so the shell has a single
 * thing to render on every authenticated screen.
 *
 * It sits above the tab bar and to the right, which is where a thumb reaches without
 * covering the content underneath.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { fetchDailyTotals } from "@/lib/dashboard";
import { localDateString } from "@/lib/profile";
import { CaptureSheet } from "./CaptureSheet";

export interface CaptureDockProps {
  userId: string;
  timeZone: string;
}

export function CaptureDock({ userId, timeZone }: CaptureDockProps) {
  const [open, setOpen] = useState(false);

  const today = localDateString(timeZone);

  // The dashboard's own query, under the dashboard's own key, so the ring and the review
  // footer read one number and cannot disagree. The footer needs what is left of the day,
  // not the day's target: subtracting this meal from the target ignores everything already
  // logged, which is how a phone showed "1641 kcal left" while the ring said 408.
  const totals = useQuery({
    queryKey: ["daily-totals", userId, today],
    queryFn: () => fetchDailyTotals(today),
    enabled: userId !== "",
  });

  return (
    <>
      <button
        type="button"
        aria-label="Add a meal"
        onClick={() => setOpen(true)}
        className="fixed right-4 z-40 grid size-14 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform active:scale-95"
        // Derived from the tab bar's own height rather than a hand-picked offset, so the two
        // cannot drift apart: the bar is `--tabbar-height` plus the inset, and this is that
        // plus the inset plus the gap. Clear at any viewport height and any inset.
        style={{ bottom: "calc(var(--tabbar-height) + env(safe-area-inset-bottom) + 1rem)" }}
      >
        <Plus className="size-6" aria-hidden="true" />
      </button>

      <CaptureSheet
        open={open}
        onOpenChange={setOpen}
        userId={userId}
        timeZone={timeZone}
        targetCalories={totals.data?.target_calories ?? null}
        remainingToday={totals.data?.remaining_calories ?? null}
      />
    </>
  );
}
