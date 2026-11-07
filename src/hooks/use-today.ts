/**
 * Today's date in the profile's zone, re-read while the screen stays open.
 *
 * A phone left on the Today screen overnight used to keep yesterday's date: the day was computed
 * once during a render, and nothing re-rendered it. Two things can move the day under a screen
 * that is already open, and both are handled here.
 *
 * The first is the clock passing midnight in the profile's zone. The second is the app coming back
 * to the foreground, where timers may not have run at all — a phone that was asleep is not a phone
 * whose interval fired.
 *
 * The check runs twice a minute rather than sleeping until the next midnight. A local day is not
 * always 24 hours long, so "the next midnight" is a calculation that can be wrong by an hour twice
 * a year; two string comparisons a minute cannot be, and cost nothing. The state is only replaced
 * when the day actually moved, so the screen does not re-render thirty times a minute to say so.
 */
import { useEffect, useState } from "react";
import { localDateString } from "@/lib/profile";

/** How often the day is re-checked while the screen is open. Chosen, not measured. */
export const DAY_CHECK_MS = 30_000;

export function useToday(timeZone: string): string {
  const [at, setAt] = useState(() => new Date());

  useEffect(() => {
    function reread(): void {
      const fresh = new Date();
      // The same object when the day has not moved, so React can skip the render entirely.
      setAt((current) =>
        localDateString(timeZone, fresh) === localDateString(timeZone, current) ? current : fresh,
      );
    }

    function onVisibilityChange(): void {
      if (document.visibilityState === "visible") reread();
    }

    const ticker = setInterval(reread, DAY_CHECK_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(ticker);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [timeZone]);

  return localDateString(timeZone, at);
}
