import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartCard } from "@/components/trends/StatTiles";
import { cmToIn, kgToLb, type UnitSystem } from "@/lib/units";
import type { WeightPoint } from "@/lib/trends";
import { axisWidth } from "@/lib/trends";

const TOOLTIP_STYLE = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: "0.75rem",
  fontSize: "0.75rem",
} as const;

/**
 * Weight over the period, with its 7-day average and waist beside it.
 *
 * Three series and two axes. Weight and waist are both lengths but not the same length,
 * and putting them on one axis would flatten whichever is smaller into a straight line —
 * a 2 kg change and a 5 cm change are each meaningful and neither is meaningful at the
 * other's scale.
 *
 * The average is drawn *over* the raw points rather than instead of them. The points are
 * the measurements; the average is the reading of them, and hiding either would be a
 * different kind of dishonesty. Waist appears only when at least one measurement exists,
 * because an axis drawn for an empty series is a claim that something was measured.
 *
 * Everything is converted to the profile's display units here, at the edge, exactly as
 * the quick-entry card does. Storage stays kilograms and centimetres.
 */
export function WeightChart({
  points,
  unitSystem,
}: {
  points: WeightPoint[];
  unitSystem: UnitSystem;
}) {
  const imperial = unitSystem === "imperial";
  const weightUnit = imperial ? "lb" : "kg";
  const waistUnit = imperial ? "in" : "cm";

  const data = points.map((point) => ({
    logged_on: point.logged_on,
    tick: point.logged_on.slice(8),
    weight: Number((imperial ? kgToLb(point.weight_kg) : point.weight_kg).toFixed(1)),
    average:
      point.weight_avg_7d === null
        ? null
        : Number((imperial ? kgToLb(point.weight_avg_7d) : point.weight_avg_7d).toFixed(1)),
    waist:
      point.waist_cm === null
        ? null
        : Number((imperial ? cmToIn(point.waist_cm) : point.waist_cm).toFixed(1)),
  }));

  const hasWaist = data.some((point) => point.waist !== null);

  // Weight is a small number but not a short one: a decimal such as "87.2" is four
  // characters, and the same axis reads "119.5" for someone heavier. Waist is narrower by a
  // hair, and being on the right it sits inside the SVG already — it gets the same treatment
  // so that neither side depends on a number that happened to fit.
  const weightAxisWidth = axisWidth(data.flatMap((point) => [point.weight, point.average ?? 0]));
  const waistAxisWidth = axisWidth(data.map((point) => point.waist ?? 0));

  if (data.length === 0) {
    return (
      <ChartCard title="Weight and waist" description="No weigh-ins in this period.">
        <p className="py-8 text-center text-sm text-muted-foreground">
          Record a weight on Today and it will appear here.
        </p>
      </ChartCard>
    );
  }

  return (
    <ChartCard
      title="Weight and waist"
      description={
        hasWaist
          ? `Weight in ${weightUnit}, waist in ${waistUnit}. The dashed line is the 7-day average.`
          : `Weight in ${weightUnit}. The dashed line is the 7-day average. No waist measured yet.`
      }
    >
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="tick"
              tickLine={false}
              axisLine={false}
              minTickGap={16}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            />
            <YAxis
              yAxisId="weight"
              domain={["dataMin - 1", "dataMax + 1"]}
              tickLine={false}
              axisLine={false}
              width={weightAxisWidth}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            />
            {hasWaist && (
              <YAxis
                yAxisId="waist"
                orientation="right"
                domain={["dataMin - 2", "dataMax + 2"]}
                tickLine={false}
                axisLine={false}
                width={waistAxisWidth}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              />
            )}
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              labelFormatter={(label) => `Day ${String(label)}`}
              formatter={(value, name) => {
                const unit = name === "Waist" ? waistUnit : weightUnit;
                return [`${Number(value).toFixed(1)} ${unit}`, name];
              }}
            />
            <Legend
              verticalAlign="top"
              height={24}
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ fontSize: "0.7rem" }}
            />
            <Line
              yAxisId="weight"
              type="monotone"
              dataKey="weight"
              name="Weight"
              stroke="var(--chart-1)"
              strokeWidth={2}
              dot={{ r: 3 }}
              isAnimationActive={false}
            />
            <Line
              yAxisId="weight"
              type="monotone"
              dataKey="average"
              name="7-day average"
              stroke="var(--chart-3)"
              strokeWidth={2}
              strokeDasharray="5 3"
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
            {hasWaist && (
              <Line
                yAxisId="waist"
                type="monotone"
                dataKey="waist"
                name="Waist"
                stroke="var(--chart-2)"
                strokeWidth={2}
                dot={{ r: 3 }}
                isAnimationActive={false}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}
