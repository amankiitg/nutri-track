/**
 * Reusable onboarding/settings form fields.
 *
 * These are deliberately dumb: they render a value and report changes. All
 * validation lives in `@/lib/onboarding`.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { cmToFtIn, ftInToCm, kgToLb, lbToKg, type UnitSystem } from "@/lib/units";

export function FieldError({ id, message }: { id: string; message?: string | undefined }) {
  if (!message) return null;
  return (
    <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label?: string | undefined;
  hint?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      {label && <Label htmlFor={id}>{label}</Label>}
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      <FieldError id={id} message={error} />
    </div>
  );
}

export function TextField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  type = "text",
  placeholder,
  autoComplete,
  inputMode,
  min,
  max,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  hint?: string | undefined;
  type?: "text" | "date" | "time";
  placeholder?: string | undefined;
  autoComplete?: string | undefined;
  inputMode?: "text" | "numeric" | "decimal" | "email" | undefined;
  min?: string | undefined;
  max?: string | undefined;
}) {
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        min={min}
        max={max}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
    </Field>
  );
}

/**
 * Numeric input with a local text buffer, so a half-typed value like "-" or
 * "1." does not get clobbered mid-keystroke.
 */
export function NumberField({
  id,
  label,
  displayValue,
  onCommit,
  error,
  hint,
  suffix,
  inputMode = "decimal",
}: {
  id: string;
  label: string;
  displayValue: string;
  onCommit: (text: string) => void;
  error?: string | undefined;
  hint?: string | undefined;
  suffix?: string | undefined;
  inputMode?: "numeric" | "decimal";
}) {
  const [text, setText] = useState(displayValue);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setText(displayValue);
  }, [displayValue, editing]);

  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <div className="relative">
        <Input
          id={id}
          inputMode={inputMode}
          value={text}
          onFocus={() => setEditing(true)}
          onBlur={() => {
            setEditing(false);
            setText(displayValue);
          }}
          onChange={(event) => {
            setText(event.target.value);
            onCommit(event.target.value);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className={suffix ? "pr-12" : undefined}
        />
        {suffix && (
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
            {suffix}
          </span>
        )}
      </div>
    </Field>
  );
}

function parseNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Height, displayed in cm or ft/in, always stored in cm. */
export function HeightField({
  valueCm,
  units,
  onChange,
  error,
}: {
  valueCm: number | null;
  units: UnitSystem;
  onChange: (cm: number | null) => void;
  error?: string | undefined;
}) {
  if (units === "metric") {
    return (
      <NumberField
        id="height"
        label="Height"
        suffix="cm"
        inputMode="numeric"
        displayValue={valueCm == null ? "" : String(Math.round(valueCm))}
        onCommit={(text) => onChange(parseNumber(text))}
        error={error}
      />
    );
  }

  const { ft, in: inches } = valueCm == null ? { ft: null, in: null } : cmToFtIn(valueCm);

  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">Height</legend>
      <div className="grid grid-cols-2 gap-3">
        <NumberField
          id="height-ft"
          label="Feet"
          suffix="ft"
          inputMode="numeric"
          displayValue={ft == null ? "" : String(ft)}
          onCommit={(text) => {
            const next = parseNumber(text);
            onChange(next == null || inches == null ? null : ftInToCm(next, inches));
          }}
        />
        <NumberField
          id="height-in"
          label="Inches"
          suffix="in"
          inputMode="numeric"
          displayValue={inches == null ? "" : String(inches)}
          onCommit={(text) => {
            const next = parseNumber(text);
            onChange(next == null || ft == null ? null : ftInToCm(ft, next));
          }}
        />
      </div>
      <FieldError id="height" message={error} />
    </fieldset>
  );
}

/** Weight, displayed in kg or lb, always stored in kg. */
export function WeightField({
  valueKg,
  units,
  onChange,
  error,
  label = "Weight",
}: {
  valueKg: number | null;
  units: UnitSystem;
  onChange: (kg: number | null) => void;
  error?: string | undefined;
  label?: string | undefined;
}) {
  const metric = units === "metric";
  return (
    <NumberField
      id={metric ? "weight" : "weight-lb"}
      label={label}
      suffix={metric ? "kg" : "lb"}
      displayValue={
        valueKg == null
          ? ""
          : metric
            ? String(round(valueKg, 1))
            : String(round(kgToLb(valueKg), 1))
      }
      onCommit={(text) => {
        const next = parseNumber(text);
        onChange(next == null ? null : metric ? next : lbToKg(next));
      }}
      error={error}
    />
  );
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Large tappable radio card, used for sex, activity level and goal. */
export function ChoiceCard({
  name,
  value,
  checked,
  onSelect,
  title,
  description,
  meta,
}: {
  name: string;
  value: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  description?: string | undefined;
  meta?: string | undefined;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-2xl border p-4 transition-colors",
        checked ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-accent/40",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onSelect}
        className="mt-1 size-4 accent-primary"
      />
      <span className="flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="font-medium">{title}</span>
          {meta && <span className="shrink-0 text-xs text-muted-foreground">{meta}</span>}
        </span>
        {description && (
          <span className="mt-0.5 block text-sm text-muted-foreground">{description}</span>
        )}
      </span>
    </label>
  );
}

/** Multi-select chips, used for dietary tags. */
export function ChipGroup({
  legend,
  options,
  selected,
  onToggle,
}: {
  legend: string;
  options: readonly string[];
  selected: readonly string[];
  onToggle: (option: string) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const active = selected.includes(option);
          return (
            <button
              key={option}
              type="button"
              aria-pressed={active}
              onClick={() => onToggle(option)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-sm transition-colors",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-muted-foreground hover:bg-accent/40",
              )}
            >
              {option}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
