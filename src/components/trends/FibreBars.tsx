import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Bucket, PeriodBucket } from "@/lib/trends";
import { axisWidth, bucketTick } from "@/lib/trends";

/**
 * Fibre across the period, as a bar per bucket against the daily target.
 *
 * The bar is the average on the days that were logged, not the bucket's sum. A weekly bucket of
 * 120 g is not "four times the target"; it is seven days, and the target is a daily one. Using
 * the same per-logged-day average the other macro figures use keeps the comparison honest and
 * keeps a week nobody logged from being drawn as zero.
 *
 * The target is a line rather than a colour rule: passing it is not a problem, so there is no
 * over/under verdict here to colour.
 */
export function FibreBars({ buckets, bucket }: { buckets: PeriodBucket[]; bucket: Bucket }) {
  const chartData = buckets.map((entry) => ({
    bucketStart: entry.bucket_start,
    tick: bucketTick(entry.bucket_start, bucket),
    fibre: entry.avg_fiber_g === null ? null : Math.round(entry.avg_fiber_g),
    target: entry.avg_target_fiber_g === null ? null : Math.round(entry.avg_target_fiber_g),
    logged: entry.days_logged > 0,
  }));

  const yAxisWidth = axisWidth([
    ...chartData.map((entry) => entry.fibre ?? 0),
    ...chartData.map((entry) => entry.target ?? 0),
  ]);

  return (
    <div className="h-48 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
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
            width={yAxisWidth}
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
              value === null ? "not logged" : `${Math.round(Number(value))} g`,
              name === "fibre" ? "Fibre" : "Target",
            ]}
          />
          <Bar dataKey="fibre" fill="#3DAA5C" radius={[3, 3, 0, 0]} isAnimationActive={false} />
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
