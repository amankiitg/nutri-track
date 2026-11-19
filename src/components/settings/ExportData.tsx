/**
 * "Export my data", in Settings under Account.
 *
 * Built in the browser from the person's own session: no endpoint, no admin key, nothing to keep in
 * step with the schema later. The zip holds the meals file and the daily totals, so one share is
 * enough; the two CSVs are there for a browser that will not share a zip.
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { saveFailureDetail } from "@/lib/profile";
import {
  DEFAULT_EXPORT_RANGE,
  EXPORT_RANGES,
  buildExportRows,
  dailyTotals,
  exportIsEmpty,
  exportRangeStart,
  fetchExportData,
  mealsCsv,
  totalsCsv,
  weightsCsv,
  zipStore,
  type ExportRangeId,
} from "@/lib/export-data";
import type { UnitSystem } from "@/lib/units";
import { deliverExport, type ExportFile } from "@/lib/export-delivery";

export function ExportData({
  userId,
  timeZone,
  units,
  today,
}: {
  /** Empty until the session has been read; the control stays disabled until it is not. */
  userId: string;
  /** The profile's zone, so a meal's time is the clock it was eaten by. */
  timeZone: string;
  /** The unit the weight column is written in: the same preference the app shows them in. */
  units: UnitSystem;
  /** The profile's day, as YYYY-MM-DD: the end of every range. */
  today: string;
}) {
  const [range, setRange] = useState<ExportRangeId>(DEFAULT_EXPORT_RANGE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const data = await fetchExportData({
        userId,
        from: exportRangeStart(range, today),
        to: today,
      });
      const rows = buildExportRows(data.meals, data.items, timeZone);

      // Every file has to be empty for there to be nothing to export: a week with weigh-ins and no
      // meals is still a week of data.
      if (exportIsEmpty(data)) {
        toast("Nothing to export", { description: "Nothing is logged in that range." });
        return;
      }

      const totals = dailyTotals(rows);
      const meals = mealsCsv(rows);
      const daily = totalsCsv(totals);
      const weights = weightsCsv(data.weights, units);
      const base = `nutritrack-${today}`;
      const files: ExportFile[] = [
        {
          name: `${base}.zip`,
          mimeType: "application/zip",
          bytes: zipStore([
            { name: "meals.csv", text: meals },
            { name: "daily-totals.csv", text: daily },
            { name: "weights.csv", text: weights },
          ]),
        },
        { name: `${base}-meals.csv`, mimeType: "text/csv", bytes: new TextEncoder().encode(meals) },
        {
          name: `${base}-daily-totals.csv`,
          mimeType: "text/csv",
          bytes: new TextEncoder().encode(daily),
        },
        {
          name: `${base}-weights.csv`,
          mimeType: "text/csv",
          bytes: new TextEncoder().encode(weights),
        },
      ];

      const outcome = await deliverExport(files);
      if (outcome === "downloaded") {
        toast.success("Export saved.", { description: "The zip is in your downloads." });
      }
    } catch (caught) {
      console.error(caught);
      setError(saveFailureDetail(caught) ?? "Could not build the export. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-border pt-4">
      <p className="text-sm font-medium">Export my data</p>
      <p className="text-xs text-muted-foreground">
        Every meal and item, a daily total for each day, and every weigh-in, as CSV files in one
        zip. Built in your browser from your own data. Times are in your profile time zone, and
        weights are in your chosen units.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Export range"
          className="h-10 rounded-full border border-input bg-background px-4 text-base"
          value={range}
          disabled={busy}
          onChange={(event) => setRange(event.target.value as ExportRangeId)}
        >
          {EXPORT_RANGES.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="outline"
          className="rounded-full"
          disabled={busy || userId === ""}
          onClick={() => void run()}
        >
          {busy && <Loader2 className="animate-spin" />}
          Export my data
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
