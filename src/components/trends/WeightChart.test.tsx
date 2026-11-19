/**
 * The dotted target line on the weight chart, and the date it carries.
 *
 * Recharts is replaced here by stubs that hand back the props they were given: jsdom has no
 * layout, so a real `ResponsiveContainer` measures zero and draws nothing, and a test that watched
 * for the SVG text would be testing recharts rather than this component. What matters is that the
 * line is asked for at the target weight and labelled with the date the shared function produced.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { WeightPoint } from "@/lib/trends";
import { reachTargetSentence } from "@/lib/target-date";
import { lbToKg } from "@/lib/units";

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ReferenceLine: (props: { y: number; label: { value: string } }) => (
    <div data-testid="target-line" data-y={String(props.y)} data-label={props.label.value} />
  ),
  Line: () => null,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

import { WeightChart } from "./WeightChart";

const POINT: WeightPoint = {
  logged_on: "2026-11-18",
  weight_kg: 71.4,
  weight_avg_7d: 71.2,
  waist_cm: null,
};

const WEEK = {
  goal: "lose" as const,
  averageKg: 71,
  targetKg: 70,
  paceKgPerWeek: 0.5,
  today: "2026-11-19",
};

describe("the target line", () => {
  it("is drawn at the target and labelled with the projected day", () => {
    render(<WeightChart points={[POINT]} unitSystem="metric" {...WEEK} />);

    const line = screen.getByTestId("target-line");
    expect(line).toHaveAttribute("data-y", "70");
    expect(line).toHaveAttribute("data-label", "Target 70.0 kg · 3 Dec");
  });

  it("carries the same day as the sentence under Settings\u2019 pace options", () => {
    // The requirement, as an assertion: one week, two screens, one date.
    render(<WeightChart points={[POINT]} unitSystem="metric" {...WEEK} />);

    const label = screen.getByTestId("target-line").getAttribute("data-label") ?? "";
    const sentence =
      reachTargetSentence({ ...WEEK, basisKg: WEEK.averageKg, units: "metric" }) ?? "";
    const day = /\d{1,2} [A-Z][a-z]{2}/;
    expect(sentence).toContain("3 Dec");
    expect(label.match(day)?.[0]).toBe(sentence.match(day)?.[0]);
  });

  it("is drawn in pounds for an imperial profile", () => {
    render(
      <WeightChart
        points={[POINT]}
        unitSystem="imperial"
        goal="lose"
        averageKg={Number(lbToKg(170).toFixed(2))}
        targetKg={Number(lbToKg(165).toFixed(2))}
        paceKgPerWeek={0.5}
        today="2026-11-19"
      />,
    );

    expect(screen.getByTestId("target-line")).toHaveAttribute("data-y", "165");
    expect(screen.getByTestId("target-line").getAttribute("data-label")).toContain("21 Dec");
  });

  it("says the target was reached instead of dating it", () => {
    render(<WeightChart points={[POINT]} unitSystem="metric" {...WEEK} averageKg={70.2} />);

    expect(screen.getByTestId("target-line")).toHaveAttribute(
      "data-label",
      "Target 70.0 kg · at target",
    );
  });

  it("still draws the target with no week to project from, and dates nothing", () => {
    render(<WeightChart points={[POINT]} unitSystem="metric" {...WEEK} averageKg={null} />);

    const line = screen.getByTestId("target-line");
    expect(line).toHaveAttribute("data-label", "Target 70.0 kg");
    // The line stays because a target is still a target; only the date needs an average, and
    // with no weigh-in in the last seven days there is nothing to project from.
    expect(line.getAttribute("data-label")).not.toMatch(/\d{1,2} [A-Z][a-z]{2}/);
  });

  it("draws nothing when there is no target", () => {
    render(<WeightChart points={[POINT]} unitSystem="metric" {...WEEK} targetKg={null} />);

    expect(screen.queryByTestId("target-line")).toBeNull();
  });
});
