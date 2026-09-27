import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  displayRounded,
  formatLength,
  lbToKg,
  cmToIn,
  inToCm,
  wrongUnit,
  wrongUnitSentence,
  type UnitSystem,
} from "@/lib/units";
import { weightDelta, type WeightEntry } from "@/lib/dashboard";

/**
 * What the column stores: two decimals of kilograms. Not what the box shows — see
 * `displayRounded`, which knows that a second decimal of pounds is finer than this.
 */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Waists are recorded to one decimal. Bounds match the column's check constraint. */
const WAIST_MIN_CM = 20;
const WAIST_MAX_CM = 300;

/**
 * A quick-entry card: weight, optionally with a waist measurement.
 *
 * Weight is prefilled with the last weigh-in, because correcting a number is common and
 * retyping it is not. Waist is deliberately **not** prefilled: it is measured far less
 * often, and a stale value sitting in the box is one accidental Save away from being
 * recorded as a new measurement on a day nobody measured anything.
 *
 * Both inputs are in the profile's display units; storage is always kilograms and
 * centimetres. Converting at this boundary is why every other screen can read
 * `weight_kg` and `waist_cm` without asking what unit they are in.
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
  onSave: (input: { weightKg: number; waistCm?: number | undefined }) => void;
  saving: boolean;
}) {
  const latest = entries[0] ?? null;
  const delta = weightDelta(entries);
  const display =
    latest === null ? "" : String(displayRounded(latest.weight_kg, unitSystem, "mass"));

  const [value, setValue] = useState<string | null>(null);
  const [waist, setWaist] = useState("");
  const shown = value ?? display;
  const unit = unitSystem === "imperial" ? "lb" : "kg";
  const waistUnit = unitSystem === "imperial" ? "in" : "cm";

  const parsed = Number(shown);
  const weightValid = shown.trim() !== "" && Number.isFinite(parsed) && parsed > 0 && parsed < 1000;

  // Converted to cm only to validate against the column's bounds, so a value the
  // database would reject is caught here rather than surfacing as a raw constraint error.
  const parsedWaist = waist.trim() === "" ? null : Number(waist);
  const waistCm =
    parsedWaist === null || !Number.isFinite(parsedWaist)
      ? null
      : unitSystem === "imperial"
        ? inToCm(parsedWaist)
        : parsedWaist;
  const waistInRange = (cm: number): boolean => cm > WAIST_MIN_CM && cm < WAIST_MAX_CM;
  const waistValid =
    parsedWaist === null ||
    (Number.isFinite(parsedWaist) && waistCm !== null && waistInRange(waistCm));

  // A waist is the likeliest field in the app to be typed in the wrong unit: inches and
  // centimetres are far enough apart that a mix-up lands outside the bounds, and close enough
  // that neither number looks obviously wrong on its own. Named first, then the range.
  const waistMixUp =
    parsedWaist === null || !Number.isFinite(parsedWaist)
      ? null
      : wrongUnit(parsedWaist, unitSystem, "length", waistInRange);

  const valid = weightValid && waistValid;

  function submit(): void {
    if (!valid) return;
    const weightKg = round(unitSystem === "imperial" ? lbToKg(parsed) : parsed);
    onSave(waistCm === null ? { weightKg } : { weightKg, waistCm: round(waistCm) });
  }

  return (
    <Card className="card-soft animate-rise">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Weight and waist</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {latest === null ? (
          <p className="text-sm text-muted-foreground">No weigh-in recorded yet.</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Last recorded{" "}
            <span className="font-medium text-foreground tabular-nums">
              {displayRounded(latest.weight_kg, unitSystem, "mass")} {unit}
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
                  {displayRounded(Math.abs(delta), unitSystem, "mass")} {unit}
                </span>{" "}
                since the one before.
              </>
            )}
            {latest.waist_cm !== null && <> Waist {formatLength(latest.waist_cm, unitSystem)}.</>}
          </p>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="weight-today">Weight ({unit})</Label>
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
              aria-invalid={shown.trim() !== "" && !weightValid}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="waist-today">
              Waist ({waistUnit}) <span className="font-normal">optional</span>
            </Label>
            <Input
              id="waist-today"
              inputMode="decimal"
              autoComplete="off"
              placeholder="—"
              value={waist}
              onChange={(event) => setWaist(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
              aria-invalid={!waistValid}
            />
          </div>
        </div>

        {!waistValid && (
          <p role="alert" className="text-xs text-destructive">
            {waistMixUp !== null && `${wrongUnitSentence(waistMixUp)} `}A waist of{" "}
            {formatLength(WAIST_MIN_CM, unitSystem)} to {formatLength(WAIST_MAX_CM, unitSystem)} is
            expected.
          </p>
        )}

        <div className="flex items-end gap-2">
          <Button
            type="button"
            className="w-full rounded-full"
            disabled={!valid || saving}
            onClick={submit}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>

        {/* Said out loud because it is a policy, not an accident. Recording a weight does
            not touch today's target, but it is the input a later refresh reads: once the
            trailing 7-day average is 1.5 kg from the weight the current target was built
            from, tomorrow starts on a new one. */}
        <p className="text-[11px] text-muted-foreground">
          Recorded against today. Today's calorie target is unchanged — once your recent weight has
          moved enough, tomorrow starts on a target recomputed from it.
        </p>
      </CardContent>
    </Card>
  );
}
