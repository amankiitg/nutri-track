import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Bucket, PeriodBucket } from "@/lib/trends";
import { bucketTick } from "@/lib/trends";

/**
 * Daily (or weekly) calories as bars, with the target drawn across them.
 *
 * The target is a per-bucket line rather than a single horizontal reference line. A
 * target only changes when the profile is saved or a weight refresh lands, so for most
 * periods the two are identical — but when it does change, one flat line would assert a
 * target that was never in force, and the days on one side of the change would look
 * wrong when they were not.
 *
 * Bars are coloured by their own status: over-target buckets are the ones worth seeing at
 * a glance, and the colour comes from the database's own verdict rather than from the
 * chart re-deriving it.
 */
export function CalorieBars({ buckets, bucket }: { buckets: PeriodBucket[]; bucket: Bucket }) {
  const chartData = buckets.map((entry) => ({
    bucketStart: entry.bucket_start,
    tick: bucketTick(entry.bucket_start, bucket),
    calories: Math.round(entry.calories),
    target: entry.target_calories === null ? null : Math.round(entry.target_calories),
    status: entry.status,
    logged: entry.meal_count > 0,
  }));

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        {/* ComposedChart, not BarChart. A `Line` inside a `BarChart` is accepted by the
            type definitions and silently not drawn, so the target simply would not
            appear — which is how this shipped for one round of review. */}
        <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
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
            width={44}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          />
          <Tooltip
            cursor={{ fill: "var(--secondary)", opacity: 0.4 }}
            contentStyle={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: "0.75rem",
              fontSize: "0.75rem",
            }}
            labelFormatter={(label) => String(label)}
            formatter={(value, name) => [
              value === null ? "not logged" : `${Number(value).toLocaleString()} kcal`,
              name === "calories" ? "Eaten" : "Target",
            ]}
          />
          <Bar dataKey="calories" radius={[3, 3, 0, 0]} isAnimationActive={false}>
            {chartData.map((entry) => (
              <Cell
                key={entry.bucketStart}
                fill={entry.status === "over" ? "var(--destructive)" : "var(--chart-1)"}
                // A bucket nobody logged is drawn in the grid colour rather than at zero
                // height, so "nothing eaten" and "ate nothing" do not look identical.
                opacity={entry.logged ? 1 : 0.25}
              />
            ))}
          </Bar>
          <Line
            type="stepAfter"
            dataKey="target"
            stroke="var(--muted-foreground)"
            strokeWidth={2}
            strokeDasharray="4 3"
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
