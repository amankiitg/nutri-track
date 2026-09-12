/**
 * Reusable onboarding/settings form fields.
 *
 * These are deliberately dumb: they render a value and report changes. All
 * validation lives in `@/lib/onboarding`.
 */
import { useEffect, useState, type FocusEvent, type ReactNode } from "react";
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
/**
 * The input, its unit suffix, and nothing else.
 *
 * Controlled: the caller owns the text. That matters for the imperial height pair,
 * where the two boxes are one value and each one has to be able to see what the other
 * currently says rather than what has been committed.
 */
function NumberInput({
  id,
  text,
  onTextChange,
  onFocus,
  onBlur,
  suffix,
  inputMode,
  invalid,
  describedBy,
}: {
  id: string;
  text: string;
  onTextChange: (text: string) => void;
  onFocus?: (() => void) | undefined;
  onBlur?: ((event: FocusEvent<HTMLInputElement>) => void) | undefined;
  suffix?: string | undefined;
  inputMode: "numeric" | "decimal";
  invalid: boolean;
  describedBy?: string | undefined;
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        inputMode={inputMode}
        value={text}
        onChange={(event) => onTextChange(event.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        className={suffix ? "pr-12" : undefined}
      />
      {suffix && (
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
          {suffix}
        </span>
      )}
    </div>
  );
}

/**
 * Numeric input with a local text buffer, so a half-typed value like "-" or
 * "1." does not get clobbered mid-keystroke.
 *
 * The buffer is what makes a partial entry survive: what is on screen is the text, not
 * a number converted back and forth, so "1" and "16" sit there untouched while 165 is
 * being typed. The committed value is only ever read back once this field is no longer
 * the one being edited.
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
      <NumberInput
        id={id}
        text={text}
        suffix={suffix}
        inputMode={inputMode}
        invalid={error !== undefined}
        describedBy={error ? `${id}-error` : undefined}
        onFocus={() => setEditing(true)}
        onBlur={() => {
          // Hand the buffer over before releasing it. A value that was typed but never
          // committed — because it is not a number yet, or because the field it belongs
          // to combines with another one — would otherwise be discarded when the buffer
          // is dropped, which looks exactly like the field clearing itself as you leave
          // it.
          if (text !== displayValue) onCommit(text);
          setEditing(false);
        }}
        onTextChange={(next) => {
          setText(next);
          onCommit(next);
        }}
      />
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

  return <ImperialHeightField valueCm={valueCm} onChange={onChange} error={error} />;
}

/**
 * Feet and inches, which are two boxes holding one stored value.
 *
 * The boxes are controlled from here, so each one can see what the other currently
 * *says* rather than what has been committed. That is the fix for the way this used to
 * behave: the old version read the sibling from the committed value, so clearing either
 * box — or opening a profile with no height yet, where both are empty — nulled the pair
 * and left the remaining box unable to write anything at all. The digits stayed on
 * screen, were never stored, and were wiped the moment the field lost focus.
 *
 * A blank box counts as zero. Somebody who types 5 and then 11 has asked for five foot
 * eleven, not for a puzzle.
 */
function ImperialHeightField({
  valueCm,
  onChange,
  error,
}: {
  valueCm: number | null;
  onChange: (cm: number | null) => void;
  error?: string | undefined;
}) {
  const { ft, in: inches } = valueCm == null ? { ft: null, in: null } : cmToFtIn(valueCm);
  const storedFeet = ft == null ? "" : String(ft);
  const storedInches = inches == null ? "" : String(inches);

  /**
   * What is in the two boxes while they are being used, or null when they are not.
   *
   * Nothing but a blur that leaves the pair throws this away, so a keystroke cannot be
   * undone by the committed value arriving a render later.
   */
  const [typed, setTyped] = useState<{ feet: string; inches: string } | null>(null);
  const feetText = typed?.feet ?? storedFeet;
  const inchesText = typed?.inches ?? storedInches;

  function edit(next: { feet: string; inches: string }): void {
    setTyped(next);
    const feet = parseNumber(next.feet);
    const remaining = parseNumber(next.inches);
    if (feet === null && remaining === null) {
      onChange(null);
      return;
    }
    onChange(ftInToCm(feet ?? 0, remaining ?? 0));
  }

  /** Moving between the two boxes is not leaving the field. */
  function handleBlur(event: FocusEvent<HTMLInputElement>): void {
    const next = event.relatedTarget;
    if (next instanceof HTMLElement && (next.id === "height-ft" || next.id === "height-in")) {
      return;
    }
    setTyped(null);
  }

  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">Height</legend>
      <div className="grid grid-cols-2 gap-3">
        <Field id="height-ft" label="Feet">
          <NumberInput
            id="height-ft"
            text={feetText}
            suffix="ft"
            inputMode="numeric"
            invalid={error !== undefined}
            describedBy={error ? "height-error" : undefined}
            onBlur={handleBlur}
            onTextChange={(text) => edit({ feet: text, inches: inchesText })}
          />
        </Field>
        <Field id="height-in" label="Inches">
          <NumberInput
            id="height-in"
            text={inchesText}
            suffix="in"
            inputMode="numeric"
            invalid={error !== undefined}
            describedBy={error ? "height-error" : undefined}
            onBlur={handleBlur}
            onTextChange={(text) => edit({ feet: feetText, inches: text })}
          />
        </Field>
      </div>
      <FieldError id="height" message={error} />
    </fieldset>
  );
}

/** Weight, displayed in kg or lb, always stored in kg. */
export function WeightField({
  id,
  valueKg,
  units,
  onChange,
  error,
  label = "Weight",
}: {
  /**
   * Required where two of these appear on one screen. Both used to render `id="weight"`,
   * which is invalid, and made the "Target weight" label point its `htmlFor` at the body
   * weight box — so tapping that label put the cursor in the wrong field.
   */
  id?: string | undefined;
  valueKg: number | null;
  units: UnitSystem;
  onChange: (kg: number | null) => void;
  error?: string | undefined;
  label?: string | undefined;
}) {
  const metric = units === "metric";
  return (
    <NumberField
      id={id ?? (metric ? "weight" : "weight-lb")}
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
