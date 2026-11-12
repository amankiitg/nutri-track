import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  VERDICT_DAYS,
  lowFibreNudge,
  macroFraction,
  targetZone,
  verdictHasNumbers,
  verdictSentence,
  verdictWindowLabel,
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
    overWarning: true,
  },
  {
    key: "carbs",
    label: "Carbs",
    bar: "bg-amber-500",
    consumed: "carbs_g",
    target: "target_carbs_g",
    overWarning: true,
  },
  {
    key: "fat",
    label: "Fat",
    bar: "bg-violet-500",
    consumed: "fat_g",
    target: "target_fat_g",
    overWarning: true,
  },
] as const;

/** The fibre bar's own green, distinct from every macro above it. */
const FIBRE_BAR = "bg-[#3DAA5C]";

/**
 * One macro against its target.
 *
 * Protein, carbs and fat warn when they go past the target. Fibre does not: a day over 30 g is
 * not a problem, and a warning there would teach the reader to ignore the two that matter. Under
 * target it keeps the same quiet line, saying how many grams are left rather than colouring
 * anything.
 */
function MacroBar({
  label,
  bar,
  eaten,
  goal,
  overWarning,
}: {
  label: string;
  bar: string;
  eaten: number;
  goal: number | null;
  overWarning: boolean;
}) {
  const fraction = macroFraction(eaten, goal);
  const goalLabel = goal === null ? "no target" : `${Math.round(goal)} g`;
  const zone = targetZone(eaten, goal);
  // Stated in grams as well as shown in colour: "167% of target" is arithmetic, and
  // "+32 g over" is the thing a person can act on.
  const overBy = zone === null ? 0 : Math.max(0, eaten - Math.round(goal ?? 0));
  const toGo = goal === null ? 0 : Math.max(0, Math.round(goal) - eaten);

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-sm">
        <dt className="font-medium">{label}</dt>
        <dd className="tabular-nums text-muted-foreground">
          <span className="text-foreground">{eaten} g</span> / {goalLabel}
        </dd>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        aria-label={`${label}: ${eaten} of ${goalLabel}${
          overWarning && overBy > 0
            ? `, ${overBy} g over`
            : !overWarning && toGo > 0
              ? `, ${toGo} g to go`
              : ""
        }`}
        aria-valuenow={eaten}
        aria-valuemin={0}
        {...(goal === null ? {} : { "aria-valuemax": Math.round(goal) })}
      >
        {/* The fill is the macro's own colour whether it is under, at, or over the
            target: it says "this is protein", and repainting it red made the bar mean
            two things at once. The number beside it works the same way, so nothing
            above the line below changes colour. No target means no bar, not an empty
            one: an empty bar would claim the user is at zero of something. */}
        {fraction !== null && (
          <div
            className={`h-full rounded-full transition-[width] ${bar}`}
            style={{ width: `${fraction * 100}%` }}
          />
        )}
      </div>
      {/* The warning, and now the only place it appears: amber the moment the target is
          passed, red once the day is 110% of it. Two levels rather than one, so a day
          that is 2 g over is not dressed the same as one that is 300 g over. Fibre has no
          over line at all; under target it says what is left, quietly. */}
      {overWarning && overBy > 0 && (
        <p
          className={`text-right text-[11px] ${
            zone === "over" ? "text-destructive" : "text-amber-600 dark:text-amber-400"
          }`}
        >
          +{overBy} g over
        </p>
      )}
      {!overWarning && toGo > 0 && (
        <p className="text-right text-[11px] text-muted-foreground">{toGo} g to go</p>
      )}
    </div>
  );
}

/** Protein, carbs, fat and fibre against their targets. */
export function MacroBars({
  totals,
  fiberTarget,
}: {
  totals: DailyTotals;
  /** The daily fibre target from the profile, or null when there is no profile to read. */
  fiberTarget: number | null;
}) {
  return (
    <Card className="card-soft animate-rise">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Macros</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {MACROS.map(({ key, label, bar, consumed, target, overWarning }) => (
          <MacroBar
            key={key}
            label={label}
            bar={bar}
            eaten={Math.round(totals[consumed])}
            goal={totals[target]}
            overWarning={overWarning}
          />
        ))}
        <MacroBar
          label="Fibre"
          bar={FIBRE_BAR}
          eaten={Math.round(totals.fiber_g)}
          goal={fiberTarget}
          overWarning={false}
        />
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
  const window = verdictWindowLabel(verdict);

  return (
    <Card className="card-soft animate-rise">
      <CardHeader className="pb-3">
        {/* "Complete" is the whole point: the window ends yesterday, so nothing here moves
            when today's first meal is logged. The dates underneath say which days they were,
            because "the last 7 days" is not a date and the person reading it may be owed a
            better answer than an implicit one. */}
        <CardTitle className="text-base">The last {VERDICT_DAYS} complete days</CardTitle>
        {window === "" ? null : (
          <CardDescription className="tabular-nums">{window} · not counting today</CardDescription>
        )}
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

        {confident && verdict.avg_fiber_g !== null && (
          <p className="text-xs text-muted-foreground tabular-nums">
            Fibre averaging {Math.round(verdict.avg_fiber_g)} g against{" "}
            {Math.round(verdict.avg_target_fiber_g ?? 30)} g.
          </p>
        )}

        {lowFibreNudge(verdict) !== null && (
          <p className="text-xs text-muted-foreground">{lowFibreNudge(verdict)}</p>
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
