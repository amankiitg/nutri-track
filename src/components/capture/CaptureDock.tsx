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
import { fetchCurrentTarget } from "@/lib/profile";
import { CaptureSheet } from "./CaptureSheet";

export interface CaptureDockProps {
  userId: string;
  timeZone: string;
}

export function CaptureDock({ userId, timeZone }: CaptureDockProps) {
  const [open, setOpen] = useState(false);

  // Read here rather than in the sheet: the remaining-calories line on the review
  // screen is the only thing that needs it, and this is the component that already
  // knows who the user is and what their timezone is.
  const target = useQuery({
    queryKey: ["currentTarget", userId, timeZone],
    queryFn: () => fetchCurrentTarget(userId, timeZone),
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
        targetCalories={target.data?.calories ?? null}
      />
    </>
  );
}
