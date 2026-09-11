import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { GRANULARITIES, GRANULARITY_LABELS, type Granularity, type Period } from "@/lib/trends";

/**
 * Week / Month / Year, the period in words, and two arrows.
 *
 * "Next" is disabled on the period containing today rather than omitted, so the control
 * does not move under the user's thumb as they step back through history and then return.
 */
export function PeriodPicker({
  granularity,
  period,
  label,
  canGoForward,
  onGranularity,
  onStep,
}: {
  granularity: Granularity;
  period: Period;
  label: string;
  canGoForward: boolean;
  onGranularity: (next: Granularity) => void;
  onStep: (direction: -1 | 1) => void;
}) {
  return (
    <div className="space-y-3">
      <ToggleGroup
        type="single"
        value={granularity}
        // Radix reports an empty string when the active item is pressed again; keeping
        // the current value stops the control from ever having nothing selected.
        onValueChange={(next) => next !== "" && onGranularity(next as Granularity)}
        className="grid w-full grid-cols-3 rounded-full bg-secondary/60 p-1"
        aria-label="Period length"
      >
        {GRANULARITIES.map((option) => (
          <ToggleGroupItem
            key={option}
            value={option}
            className="rounded-full text-sm data-[state=on]:bg-background data-[state=on]:shadow-sm"
          >
            {GRANULARITY_LABELS[option]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label={`Previous ${GRANULARITY_LABELS[granularity].toLowerCase()}`}
          onClick={() => onStep(-1)}
        >
          <ChevronLeft className="size-5" aria-hidden="true" />
        </Button>

        <p aria-live="polite" className="text-sm font-medium">
          {label}
        </p>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label={`Next ${GRANULARITY_LABELS[granularity].toLowerCase()}`}
          disabled={!canGoForward}
          onClick={() => onStep(1)}
        >
          <ChevronRight className="size-5" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
