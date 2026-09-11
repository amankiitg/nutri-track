import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PeriodTotals } from "@/lib/trends";

interface Tile {
  label: string;
  value: string;
  detail: string;
}

/**
 * The period's four headline numbers.
 *
 * "Days logged" and "Adherence" deliberately disagree in their denominators, and their
 * details say so: logged counts days with food, adherence counts only days that also had
 * a target to be measured against. Using one denominator for both would make adherence
 * look worse on any period that predates the user's first target.
 */
export function StatTiles({ totals, windowDays }: { totals: PeriodTotals; windowDays: number }) {
  const logged = Math.round(totals.days_logged);
  const judged = Math.round(totals.days_judged);

  const tiles: Tile[] = [
    {
      label: "Days logged",
      value: `${logged}`,
      detail: `of ${windowDays} day${windowDays === 1 ? "" : "s"}`,
    },
    {
      label: "Adherence",
      value: totals.adherence_pct === null ? "—" : `${Math.round(totals.adherence_pct)}%`,
      detail:
        judged === 0
          ? "nothing to compare yet"
          : `${Math.round(totals.days_on_track)} of ${judged} within 10%`,
    },
    {
      label: "Average calories",
      value: totals.avg_calories === null ? "—" : Math.round(totals.avg_calories).toLocaleString(),
      detail:
        totals.avg_target_calories === null
          ? "per logged day"
          : `per logged day, target ${Math.round(totals.avg_target_calories).toLocaleString()}`,
    },
    {
      label: "Average protein",
      value: totals.avg_protein_g === null ? "—" : `${Math.round(totals.avg_protein_g)} g`,
      detail:
        totals.avg_target_protein_g === null
          ? "per logged day"
          : `of ${Math.round(totals.avg_target_protein_g)} g`,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3">
      {tiles.map((tile) => (
        <div key={tile.label} className="rounded-2xl border border-border bg-card px-3 py-3">
          <p className="text-xs text-muted-foreground">{tile.label}</p>
          <p className="mt-0.5 text-2xl font-semibold tabular-nums">{tile.value}</p>
          <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">{tile.detail}</p>
        </div>
      ))}
    </div>
  );
}

/** The chart headings, so all four cards look the same. */
export function ChartCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <Card className="card-soft animate-rise">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {description !== undefined && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </CardHeader>
      <CardContent className="pb-4">{children}</CardContent>
    </Card>
  );
}
