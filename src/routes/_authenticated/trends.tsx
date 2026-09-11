import { useState } from "react";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { CalorieBars } from "@/components/trends/CalorieBars";
import { MacroSplit } from "@/components/trends/MacroSplit";
import { PeriodPicker } from "@/components/trends/PeriodPicker";
import { ChartCard, StatTiles } from "@/components/trends/StatTiles";
import { WeightChart } from "@/components/trends/WeightChart";
import { localDateString } from "@/lib/profile";
import {
  bucketFor,
  clampEnd,
  containsToday,
  fetchPeriodSummary,
  fetchWeightSeries,
  isEmptyPeriod,
  periodFor,
  periodLabel,
  shiftPeriod,
  type Granularity,
} from "@/lib/trends";

const parentApi = getRouteApi("/_authenticated");

export const Route = createFileRoute("/_authenticated/trends")({
  component: TrendsPage,
});

function TrendsPage() {
  const { profile } = parentApi.useRouteContext();
  const userId = profile?.user_id ?? "";
  const timeZone = profile?.timezone ?? "UTC";
  const unitSystem = profile?.units ?? "metric";

  // The window is held as an anchor *date* rather than as a period object. When the
  // granularity changes, the anchor is what the new period gets built around; keeping the
  // old period would make Month open on whatever month the week happened to start in.
  const today = localDateString(timeZone);
  const [granularity, setGranularity] = useState<Granularity>("week");
  const [anchor, setAnchor] = useState(today);

  const period = periodFor(granularity, anchor);
  // The rest of a current period has not happened yet. Asking for it would return a zero
  // row per future day, and every average would be dragged towards zero by days that have
  // not occurred. The label still names the whole calendar period.
  const range = clampEnd(period, today);
  const label = periodLabel(granularity, period);
  // A year of daily bars is 254 of them and its axis is unreadable; a week per bar is
  // ~37 and can be read. The shorter views stay daily, where each bar is legible.
  const bucket = bucketFor(granularity);
  const enabled = userId !== "";

  const summary = useQuery({
    queryKey: ["period-summary", userId, range.start, range.end, bucket],
    queryFn: () => fetchPeriodSummary(range, bucket),
    enabled,
  });

  const weights = useQuery({
    queryKey: ["weight-series", userId, range.start, range.end],
    queryFn: () => fetchWeightSeries(range),
    enabled,
  });

  function step(direction: -1 | 1): void {
    const next = shiftPeriod(granularity, period, direction);
    setAnchor(next.start);
  }

  function chooseGranularity(next: Granularity): void {
    setGranularity(next);
    // Re-anchor on the day being viewed, so switching from Month to Week shows the week
    // containing that day rather than jumping back to today.
    setAnchor(containsToday(period, today) ? today : period.start);
  }

  return (
    <div className="app-shell space-y-5 py-8">
      <header className="animate-rise">
        <h1 className="text-3xl font-semibold">Trends</h1>
      </header>

      <div className="animate-rise rounded-2xl border border-border bg-card px-4 py-4">
        <PeriodPicker
          granularity={granularity}
          period={period}
          label={label}
          canGoForward={!containsToday(period, today)}
          onGranularity={chooseGranularity}
          onStep={step}
        />
      </div>

      {summary.isPending && (
        <Card className="card-soft">
          <CardContent className="py-6">
            <p className="text-sm text-muted-foreground">Loading {label}…</p>
          </CardContent>
        </Card>
      )}

      {summary.isError && (
        <Card className="card-soft">
          <CardContent className="py-6">
            <p role="alert" className="text-sm text-destructive">
              Could not load this period. Try another range or come back shortly.
            </p>
          </CardContent>
        </Card>
      )}

      {summary.isSuccess && isEmptyPeriod(summary.data) && (
        <Card className="card-soft animate-rise">
          <CardContent className="py-8 text-center">
            <p className="text-sm text-muted-foreground">
              Nothing logged in {label}. Step back with the arrows, or add a meal from Today.
            </p>
          </CardContent>
        </Card>
      )}

      {summary.isSuccess && !isEmptyPeriod(summary.data) && (
        <>
          <StatTiles totals={summary.data.totals} windowDays={summary.data.window_days} />

          <ChartCard
            title="Calories by day"
            description={
              bucket === "week"
                ? "Bars are a week's total; the dashed line is what seven days allowed."
                : "Bars are what you ate; the dashed line is your target on that day."
            }
          >
            <CalorieBars buckets={summary.data.buckets} bucket={bucket} />
          </ChartCard>

          <MacroSplit totals={summary.data.totals} buckets={summary.data.buckets} bucket={bucket} />
        </>
      )}

      {weights.isSuccess && <WeightChart points={weights.data} unitSystem={unitSystem} />}
    </div>
  );
}
