import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { kgToLb, lbToKg, type UnitSystem } from "@/lib/units";
import { weightDelta, type WeightEntry } from "@/lib/dashboard";

/** Weigh-ins are recorded to two decimals by the column, so do not offer more. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * One field and a button, for the common case of stepping on a scale and wanting the
 * number recorded. Enter submits, because on a phone that is one thumb.
 *
 * The input is in whatever unit the profile uses; the database is always kilograms.
 * Converting in one place here is why every other screen can read `weight_kg` without
 * asking what unit it is in.
 */
export function WeightEntry({
  entries,
  unitSystem,
  onSave,
  saving,
}: {
  /** Newest first, at most two: the latest weigh-in and the one before it. */
  entries: WeightEntry[];
  unitSystem: UnitSystem;
  onSave: (weightKg: number) => void;
  saving: boolean;
}) {
  const latest = entries[0] ?? null;
  const delta = weightDelta(entries);
  const display =
    latest === null
      ? ""
      : String(round(unitSystem === "imperial" ? kgToLb(latest.weight_kg) : latest.weight_kg));

  // Prefilled with the last weigh-in, so re-recording after a correction does not mean
  // retyping. Cleared state means the user is typing something new.
  const [value, setValue] = useState<string | null>(null);
  const shown = value ?? display;
  const unit = unitSystem === "imperial" ? "lb" : "kg";

  const parsed = Number(shown);
  const valid = shown.trim() !== "" && Number.isFinite(parsed) && parsed > 0 && parsed < 1000;

  function submit(): void {
    if (!valid) return;
    const weightKg = round(unitSystem === "imperial" ? lbToKg(parsed) : parsed);
    onSave(weightKg);
  }

  return (
    <Card className="card-soft animate-rise">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Weight</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {latest === null ? (
          <p className="text-sm text-muted-foreground">No weigh-in recorded yet.</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Last recorded{" "}
            <span className="font-medium text-foreground tabular-nums">
              {round(unitSystem === "imperial" ? kgToLb(latest.weight_kg) : latest.weight_kg)}{" "}
              {unit}
            </span>{" "}
            on{" "}
            <time dateTime={latest.logged_on}>
              {new Date(`${latest.logged_on}T00:00:00Z`).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "short",
                timeZone: "UTC",
              })}
            </time>
            .
            {delta !== null && (
              <>
                {" "}
                <span className={delta > 0 ? "text-amber-600" : "text-emerald-600"}>
                  {delta > 0 ? "+" : "−"}
                  {round(
                    Math.abs(unitSystem === "imperial" ? kgToLb(Math.abs(delta)) : delta),
                  )}{" "}
                  {unit}
                </span>{" "}
                since the one before.
              </>
            )}
          </p>
        )}

        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <Label htmlFor="weight-today">Today ({unit})</Label>
            <Input
              id="weight-today"
              inputMode="decimal"
              autoComplete="off"
              value={shown}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
              aria-invalid={shown.trim() !== "" && !valid}
            />
          </div>
          <Button
            type="button"
            className="rounded-full"
            disabled={!valid || saving}
            onClick={submit}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>

        {/* Said out loud because it is a decision, not an accident: recording a weight
            does not rewrite the day's calorie target. */}
        <p className="text-[11px] text-muted-foreground">
          Recorded against today. This does not change today's calorie target — update it in
          Settings.
        </p>
      </CardContent>
    </Card>
  );
}
