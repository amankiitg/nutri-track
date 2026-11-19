/**
 * "Export my data", in Settings under Account.
 *
 * Built in the browser from the person's own session: no endpoint, no admin key, nothing to keep in
 * step with the schema later. One file per request — the meals, the daily totals, or the weigh-ins —
 * because a file somebody has to unzip before reading is a file they read later instead of now.
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { saveFailureDetail } from "@/lib/profile";
import {
  DEFAULT_EXPORT_CONTENT,
  DEFAULT_EXPORT_RANGE,
  EXPORT_CONTENTS,
  EXPORT_RANGES,
  exportFileContent,
  exportRangeStart,
  fetchExportData,
  type ExportContentId,
  type ExportRangeId,
} from "@/lib/export-data";
import type { UnitSystem } from "@/lib/units";
import { deliverExport } from "@/lib/export-delivery";

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
  const [content, setContent] = useState<ExportContentId>(DEFAULT_EXPORT_CONTENT);
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
      const file = exportFileContent({
        content,
        data,
        units,
        timeZone,
        from: exportRangeStart(range, today),
        to: today,
      });

      if (file === null) {
        const chosen = EXPORT_CONTENTS.find((option) => option.id === content);
        toast("Nothing to export", {
          description: chosen?.empty ?? "Nothing is logged in that range.",
        });
        return;
      }

      const outcome = await deliverExport({
        name: file.name,
        mimeType: "text/csv",
        bytes: new TextEncoder().encode(file.text),
      });
      if (outcome === "downloaded") {
        toast.success("Export saved.", { description: `${file.name} is in your downloads.` });
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
        One CSV of every meal and item, of the daily totals, or of every weigh-in. Built in your
        browser from your own data. Times are in your profile time zone, and weights in your chosen
        units.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="What to export"
          className="h-10 rounded-full border border-input bg-background px-4 text-base"
          value={content}
          disabled={busy}
          onChange={(event) => setContent(event.target.value as ExportContentId)}
        >
          {EXPORT_CONTENTS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
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
