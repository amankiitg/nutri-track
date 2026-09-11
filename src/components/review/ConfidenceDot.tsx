/**
 * The confidence dot: green above 0.8, amber 0.5 to 0.8, red below.
 *
 * The bands come from `confidenceBand` in the shared contract, so the colour a person
 * sees and the number the model returned cannot drift apart.
 */
import { confidenceBand, type ConfidenceBand } from "@shared/meal-parse";

const BAND_STYLES: Record<ConfidenceBand, string> = {
  high: "bg-emerald-500",
  medium: "bg-amber-500",
  low: "bg-rose-500",
};

const BAND_LABELS: Record<ConfidenceBand, string> = {
  high: "confident",
  medium: "fairly confident",
  low: "a guess",
};

export function ConfidenceDot({ confidence }: { confidence: number }) {
  const band = confidenceBand(confidence);
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
      title={`${Math.round(confidence * 100)}% — ${BAND_LABELS[band]}`}
    >
      <span className={`size-2.5 rounded-full ${BAND_STYLES[band]}`} aria-hidden="true" />
      <span className="sr-only">{`Confidence: ${BAND_LABELS[band]}`}</span>
    </span>
  );
}
