import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  VERDICT_DAYS,
  macroFraction,
  verdictHasNumbers,
  verdictSentence,
  type DailyTotals,
  type WeekVerdict,
} from "@/lib/dashboard";

const MACROS = [
  {
    key: "protein",
    label: "Protein",
    bar: "bg-sky-500",
    consumed: "protein_g",
    target: "target_protein_g",
  },
  {
    key: "carbs",
    label: "Carbs",
    bar: "bg-amber-500",
    consumed: "carbs_g",
    target: "target_carbs_g",
  },
  { key: "fat", label: "Fat", bar: "bg-violet-500", consumed: "fat_g", target: "target_fat_g" },
] as const;

/** Protein, carbs and fat against their targets. */
export function MacroBars({ totals }: { totals: DailyTotals }) {
  return (
    <Card className="card-soft animate-rise">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Macros</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {MACROS.map(({ key, label, bar, consumed, target }) => {
          const eaten = Math.round(totals[consumed]);
          const goal = totals[target];
          const fraction = macroFraction(eaten, goal);
          const goalLabel = goal === null ? "no target" : `${Math.round(goal)} g`;

          return (
            <div key={key} className="space-y-1">
              <div className="flex items-baseline justify-between text-sm">
                <dt className="font-medium">{label}</dt>
                <dd className="tabular-nums text-muted-foreground">
                  <span className="text-foreground">{eaten} g</span> / {goalLabel}
                </dd>
              </div>
              <div
                className="h-2 overflow-hidden rounded-full bg-secondary"
                role="progressbar"
                aria-label={`${label}: ${eaten} of ${goalLabel}`}
                aria-valuenow={eaten}
                aria-valuemin={0}
                {...(goal === null ? {} : { "aria-valuemax": Math.round(goal) })}
              >
                {/* No target means no bar, not an empty one: an empty bar would claim
                    the user is at zero of something. */}
                {fraction !== null && (
                  <div
                    className={`h-full rounded-full transition-[width] ${bar}`}
                    style={{ width: `${fraction * 100}%` }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

/**
 * The trailing-window verdict, as one sentence.
 *
 * The sentence itself is built by `verdictSentence`, which knows the difference between
 * "nothing logged", "logged but nothing to compare against" and "not enough days yet".
 * The three states that cannot produce a number are rendered quietly on purpose — a
 * large confident figure over a one-day sample is the failure this is avoiding.
 */
export function VerdictLine({ verdict }: { verdict: WeekVerdict }) {
  const confident = verdictHasNumbers(verdict.verdict);

  return (
    <Card className="card-soft animate-rise">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">The last {VERDICT_DAYS} days</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className={confident ? "text-sm" : "text-sm text-muted-foreground"}>
          {verdictSentence(verdict)}
        </p>

        {confident && verdict.avg_protein_g !== null && verdict.avg_target_protein_g !== null && (
          <p className="text-xs text-muted-foreground tabular-nums">
            Protein averaging {Math.round(verdict.avg_protein_g)} g against{" "}
            {Math.round(verdict.avg_target_protein_g)} g.
          </p>
        )}

        {confident && (
          <p className="text-xs text-muted-foreground">
            {Math.round(verdict.days_on_track)} of {Math.round(verdict.days_judged)} of those days
            landed within 10% of target.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
