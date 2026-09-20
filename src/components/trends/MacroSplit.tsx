import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartCard } from "@/components/trends/StatTiles";
import {
  axisWidth,
  bucketTick,
  macroShares,
  type Bucket,
  type PeriodBucket,
  type PeriodTotals,
} from "@/lib/trends";

const MACRO_META = {
  protein: { label: "Protein", colour: "var(--chart-3)" },
  carbs: { label: "Carbs", colour: "var(--chart-2)" },
  fat: { label: "Fat", colour: "var(--chart-4)" },
} as const;

const TOOLTIP_STYLE = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: "0.75rem",
  fontSize: "0.75rem",
} as const;

/**
 * Where the period's energy came from, and how that changed day to day.
 *
 * Both charts are in calories, not grams, and both take their numbers straight from
 * `get_period_summary`. The donut and the stacked bar side by side must be answering the
 * same question — a donut of energy above a bar chart of mass would invite the reader to
 * compare fat's share of a diet with its share of a plate, which differ by a factor of
 * 2.25.
 *
 * The donut is of the *average judged day*, not of the period's total, so it describes a
 * typical day. Summing a period would make the ring a picture of how long the period was.
 */
export function MacroSplit({
  totals,
  buckets,
  bucket,
}: {
  totals: PeriodTotals;
  buckets: PeriodBucket[];
  bucket: Bucket;
}) {
  const shares = macroShares(totals);

  const donutData = (shares ?? []).map((share) => ({
    key: share.key,
    name: MACRO_META[share.key].label,
    colour: MACRO_META[share.key].colour,
    kcal: share.kcal,
    share: share.share,
  }));

  const stacked = buckets.map((entry) => ({
    bucketStart: entry.bucket_start,
    tick: bucketTick(entry.bucket_start, bucket),
    protein: Math.round(entry.protein_kcal),
    carbs: Math.round(entry.carbs_kcal),
    fat: Math.round(entry.fat_kcal),
    logged: entry.meal_count > 0,
  }));

  // The stack's own height per bucket, which is what the axis labels.
  const macroAxisWidth = axisWidth(stacked.map((entry) => entry.protein + entry.carbs + entry.fat));

  if (shares === null) {
    return (
      <ChartCard title="Macros" description="Nothing logged in this period.">
        <p className="py-8 text-center text-sm text-muted-foreground">
          No meals to break down yet.
        </p>
      </ChartCard>
    );
  }

  return (
    <>
      <ChartCard title="Macros" description="Share of energy on an average logged day.">
        <div className="flex items-center gap-2">
          <div className="h-40 w-40 shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={donutData}
                  dataKey="kcal"
                  nameKey="name"
                  innerRadius="58%"
                  outerRadius="92%"
                  paddingAngle={2}
                  stroke="none"
                  isAnimationActive={false}
                >
                  {donutData.map((slice) => (
                    <Cell key={slice.key} fill={slice.colour} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(value) => `${Number(value).toLocaleString()} kcal`}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>

          <ul className="min-w-0 flex-1 space-y-1.5">
            {donutData.map((slice) => (
              <li key={slice.key} className="flex items-center gap-2 text-sm">
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: slice.colour }}
                  aria-hidden="true"
                />
                <span className="flex-1 truncate">{slice.name}</span>
                <span className="tabular-nums text-muted-foreground">
                  {Math.round(slice.share * 100)}%
                </span>
                <span className="w-16 text-right tabular-nums text-muted-foreground">
                  {slice.kcal.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </ChartCard>

      <ChartCard
        title="Macros over time"
        description={
          bucket === "week"
            ? "Calories from each macro, by week."
            : "Calories from each macro, by day."
        }
      >
        <div className="h-48 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={stacked} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis
                dataKey="tick"
                tickLine={false}
                axisLine={false}
                minTickGap={16}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={macroAxisWidth}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              />
              <Tooltip
                cursor={{ fill: "var(--secondary)", opacity: 0.4 }}
                contentStyle={TOOLTIP_STYLE}
                labelFormatter={(label) => String(label)}
                formatter={(value) => `${Number(value).toLocaleString()} kcal`}
              />
              <Legend
                verticalAlign="top"
                height={24}
                iconType="circle"
                iconSize={8}
                wrapperStyle={{ fontSize: "0.7rem" }}
              />
              <Bar
                dataKey="protein"
                stackId="m"
                fill={MACRO_META.protein.colour}
                name="Protein"
                isAnimationActive={false}
              />
              <Bar
                dataKey="carbs"
                stackId="m"
                fill={MACRO_META.carbs.colour}
                name="Carbs"
                isAnimationActive={false}
              />
              <Bar
                dataKey="fat"
                stackId="m"
                fill={MACRO_META.fat.colour}
                name="Fat"
                radius={[3, 3, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>
    </>
  );
}
