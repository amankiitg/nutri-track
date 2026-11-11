import { useEffect, useRef, useState } from "react";
import { ringGeometry, targetZone } from "@/lib/dashboard";

const SIZE = 168;
const STROKE = 14;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * How long the ring and the number take to travel to a new value, in ms.
 *
 * Chosen, not measured: 600 ms is long enough to read as movement rather than a jump,
 * and short enough that the screen has settled before anyone looks away from the sheet
 * they just closed.
 */
const FILL_ANIMATION_MS = 600;

/** Fast at the start, settled at the end, so the last few kcal are not a crawl. */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Whether this device has asked for less movement. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The number to draw, which trails the real one for a moment after it changes.
 *
 * It moves from wherever it currently sits to the new value, so a change that arrives
 * mid-animation continues from what is on screen rather than snapping back. It never
 * animates the first paint: there is no previous value to travel from, and a ring that
 * fills itself as the day loads would claim something was just logged.
 *
 * With `prefers-reduced-motion` the new value is used immediately. That is the whole
 * accommodation: the information is the number, and the movement is decoration.
 */
function useAnimatedValue(value: number): number {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);

  useEffect(() => {
    const from = shownRef.current;
    if (from === value) return;

    if (prefersReducedMotion()) {
      shownRef.current = value;
      setShown(value);
      return;
    }

    let startedAt: number | null = null;
    let frame = 0;
    const step = (now: number) => {
      if (startedAt === null) startedAt = now;
      const progress = Math.min((now - startedAt) / FILL_ANIMATION_MS, 1);
      const next = from + (value - from) * easeOutCubic(progress);
      shownRef.current = next;
      setShown(next);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return shown;
}

/**
 * The calorie ring: eaten against target, with what is left underneath.
 *
 * The ring is drawn from a fraction that is clamped at 1, so a day over target shows a
 * complete circle and the overage is stated in words instead. Letting the arc run past
 * the start would draw a shape that reads as "barely started", which is the opposite of
 * what happened.
 *
 * The SVG is decorative and hidden from assistive tech: the numbers it surrounds are
 * real text, and a screen reader announcing both would say everything twice.
 */
export function CalorieRing({ consumed, target }: { consumed: number; target: number | null }) {
  // The geometry that is spoken and the geometry that is drawn come from different
  // numbers on purpose: the arc travels with the animation, while the summary is the
  // final value so a screen reader never announces a fraction of a day.
  const animated = useAnimatedValue(consumed);
  const { over, remaining } = ringGeometry(consumed, target);
  const { fraction } = ringGeometry(animated, target);
  const dash = CIRCUMFERENCE * fraction;
  const isOver = over > 0;
  // The same rule the macro bars use, so "over" is one idea on this screen: amber once the
  // target is passed, destructive past 110%, which is where `calorie_status` draws the line too.
  const zone = targetZone(consumed, target);
  const strokeClass =
    zone === "over"
      ? "stroke-destructive"
      : zone === "near"
        ? "stroke-amber-500"
        : "stroke-primary";
  const summaryClass =
    zone === "over"
      ? "text-destructive"
      : zone === "near"
        ? "text-amber-600 dark:text-amber-400"
        : "text-muted-foreground";

  const summary =
    target === null
      ? `${Math.round(consumed)} kcal eaten. No target set.`
      : isOver
        ? `${Math.round(consumed)} of ${Math.round(target)} kcal, ${Math.round(over)} over target.`
        : `${Math.round(consumed)} of ${Math.round(target)} kcal, ${Math.round(remaining ?? 0)} remaining.`;

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative" role="img" aria-label={summary}>
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="-rotate-90"
          aria-hidden="true"
          focusable="false"
        >
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            className="stroke-secondary"
          />
          {fraction > 0 && (
            <circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={`${dash} ${CIRCUMFERENCE}`}
              className={strokeClass}
            />
          )}
        </svg>

        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <p className="text-3xl font-semibold tabular-nums">
            {Math.round(animated).toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {target === null ? "eaten" : `of ${Math.round(target).toLocaleString()} kcal`}
          </p>
        </div>
      </div>

      <p className={`text-sm font-medium tabular-nums ${summaryClass}`}>
        {target === null
          ? "Finish onboarding to set a target."
          : isOver
            ? `${Math.round(over).toLocaleString()} kcal over target`
            : `${Math.round(remaining ?? 0).toLocaleString()} kcal remaining`}
      </p>
    </div>
  );
}
