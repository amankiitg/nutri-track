import { ringGeometry } from "@/lib/dashboard";

const SIZE = 168;
const STROKE = 14;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

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
  const { fraction, over, remaining } = ringGeometry(consumed, target);
  const dash = CIRCUMFERENCE * fraction;
  const isOver = over > 0;

  const summary =
    target === null
      ? `${Math.round(consumed)} kcal eaten. No target set.`
      : isOver
        ? `${Math.round(consumed)} of ${target} kcal, ${Math.round(over)} over target.`
        : `${Math.round(consumed)} of ${target} kcal, ${Math.round(remaining ?? 0)} remaining.`;

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
              className={isOver ? "stroke-destructive" : "stroke-primary"}
            />
          )}
        </svg>

        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <p className="text-3xl font-semibold tabular-nums">
            {Math.round(consumed).toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {target === null ? "eaten" : `of ${target.toLocaleString()} kcal`}
          </p>
        </div>
      </div>

      <p
        className={`text-sm font-medium tabular-nums ${isOver ? "text-destructive" : "text-muted-foreground"}`}
      >
        {target === null
          ? "Finish onboarding to set a target."
          : isOver
            ? `${Math.round(over).toLocaleString()} kcal over target`
            : `${Math.round(remaining ?? 0).toLocaleString()} kcal remaining`}
      </p>
    </div>
  );
}
