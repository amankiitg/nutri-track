export type UnitSystem = "metric" | "imperial";

export const KG_PER_LB = 0.45359237;
export const CM_PER_IN = 2.54;

export const kgToLb = (kg: number) => kg / KG_PER_LB;
export const lbToKg = (lb: number) => lb * KG_PER_LB;
export const cmToIn = (cm: number) => cm / CM_PER_IN;
export const inToCm = (inches: number) => inches * CM_PER_IN;

export function cmToFtIn(cm: number): { ft: number; in: number } {
  const totalIn = Math.round(cmToIn(cm));
  return { ft: Math.floor(totalIn / 12), in: totalIn % 12 };
}

export function ftInToCm(ft: number, inches: number): number {
  return inToCm(ft * 12 + inches);
}

export function formatWeight(kg: number, units: UnitSystem, digits = 1): string {
  return units === "imperial" ? `${kgToLb(kg).toFixed(digits)} lb` : `${kg.toFixed(digits)} kg`;
}

export function formatHeight(cm: number, units: UnitSystem): string {
  if (units === "metric") return `${Math.round(cm)} cm`;
  const { ft, in: inch } = cmToFtIn(cm);
  return `${ft}′ ${inch}″`;
}

export function formatPace(kgPerWeek: number, units: UnitSystem): string {
  return units === "imperial"
    ? `${kgToLb(kgPerWeek).toFixed(1)} lb/week`
    : `${kgPerWeek.toFixed(2).replace(/0$/, "")} kg/week`;
}

/**
 * A length the user measures with a tape, such as a waist. Centimetres in, centimetres
 * or inches out.
 *
 * Deliberately not `formatHeight`: a waist is not usefully expressed in feet, and
 * keeping the conversion here leaves exactly one `cmToIn` factor in the codebase rather
 * than a second copy appearing next to whichever input needed it.
 */
export function formatLength(cm: number, units: UnitSystem, digits = 1): string {
  return units === "imperial" ? `${cmToIn(cm).toFixed(digits)} in` : `${cm.toFixed(digits)} cm`;
}

/** The other system: the one a value would be in if the wrong one were selected. */
export function otherUnits(units: UnitSystem): UnitSystem {
  return units === "metric" ? "imperial" : "metric";
}

/** The two kinds of measurement the app converts, which convert differently. */
export type Quantity = "mass" | "length";

/** The bare unit a quantity carries in a system. */
export function unitLabel(quantity: Quantity, units: UnitSystem): string {
  if (quantity === "mass") return units === "metric" ? "kg" : "lb";
  return units === "metric" ? "cm" : "in";
}

/** How a system is named to the reader, for "switch to …". */
export function unitSystemName(units: UnitSystem): string {
  return units === "metric" ? "Metric" : "Imperial";
}

/** A stored value converted to the unit the database stores: kg for mass, cm for length. */
export function toBase(value: number, units: UnitSystem, quantity: Quantity): number {
  if (quantity === "mass") return units === "metric" ? value : lbToKg(value);
  return units === "metric" ? value : inToCm(value);
}

/** The number a single-box field would be showing for a stored value. */
export function displayValue(base: number, units: UnitSystem, quantity: Quantity): number {
  if (quantity === "mass") return units === "metric" ? base : kgToLb(base);
  return units === "metric" ? base : cmToIn(base);
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * The number to show for a stored value, rounded to the precision the store can actually
 * support — which is not always the precision the column has.
 *
 * Mass is stored in kilograms, and the column holds two decimals, so 0.01 kg is 0.022 lb. A
 * two-decimal kilogram value pins pounds to about ±0.011 lb, which means a second decimal of
 * pounds is finer than the stored number: 174.6 lb goes to the database as 79.20 kg and comes
 * back as 174.606, and printing that to two decimals says 174.61. The digit is not noise the
 * round trip added; it is the display claiming a resolution nothing in the chain has.
 *
 * So pounds get one decimal and kilograms get two — in kilograms the stored value *is* the
 * answer, because that is the unit it was stored in. Lengths go through a unit 2.54 times
 * smaller and are held to one decimal, so one decimal is right in both systems there.
 *
 * The stored value is untouched by any of this: `toBase` still round-trips to two decimals of
 * kilograms, which is what the column expects.
 */
export function displayRounded(base: number, units: UnitSystem, quantity: Quantity): number {
  const digits = quantity === "mass" ? (units === "imperial" ? 1 : 2) : 1;
  return roundTo(displayValue(base, units, quantity), digits);
}

/** A stored value rendered in a system, with its unit. */
function formatBase(base: number, quantity: Quantity, units: UnitSystem): string {
  return quantity === "mass" ? formatWeight(base, units) : formatLength(base, units);
}

/** The pieces of a unit mix-up, already worded so a field can just drop them into a sentence. */
export interface WrongUnit {
  /** How the field names its own unit. Not always the bare label: see `wrongUnit`. */
  selectedLabel: string;
  /** The system to switch to. */
  intendedLabel: string;
  /** The number as typed. */
  typed: string;
  /** What that number means read in this unit, expressed in the other one. */
  asRead: string;
  /** The same digits read as the other unit, which is what they probably meant. */
  asIntended: string;
}

/**
 * Whether a number that failed a plausibility check is more likely to be in the wrong unit
 * than to have been meant literally.
 *
 * Only the digits can decide this, and they decide it exactly: the value has to be plausible
 * in the other unit *and* implausible in the one selected. "55" as a target weight in pounds
 * is a real number for somebody who meant kilograms; "4" is nobody's weight in either unit, so
 * it gets the plain message and no speculation about units attached to it.
 *
 * `value` is the number as the field shows it, *not* the stored one. They are the same in
 * metric and differ by a factor of 2.2 in imperial, and it is the digits in the box that the
 * reader needs to recognise. They come back through a conversion, so they are rounded before
 * being printed: 55 lb returns from 24.95 kg as 54.994, and "54.994" would be a worse error
 * than the one being reported.
 *
 * `selectedLabel` is how the *field* names its own unit, which is not always the bare label:
 * a height in imperial is two boxes and reads "ft and in", and a pound is shown as "lb".
 */
export function wrongUnit(
  value: number,
  units: UnitSystem,
  quantity: Quantity,
  isPlausible: (base: number) => boolean,
  selectedLabel: string = unitLabel(quantity, units),
): WrongUnit | null {
  const asReadBase = toBase(value, units, quantity);
  if (isPlausible(asReadBase)) return null;

  const intended = otherUnits(units);
  const intendedBase = toBase(value, intended, quantity);
  if (!isPlausible(intendedBase)) return null;

  return {
    selectedLabel,
    intendedLabel: unitSystemName(intended),
    typed: String(Number(value.toFixed(1))),
    asRead: formatBase(asReadBase, quantity, intended),
    asIntended: `${String(Number(value.toFixed(1)))} ${unitLabel(quantity, intended)}`,
  };
}

/** "lb is selected, so 55 is being read as 24.9 kg. If you meant 55 kg, switch to Metric." */
export function wrongUnitSentence(mixUp: WrongUnit): string {
  return (
    `${mixUp.selectedLabel} is selected, so ${mixUp.typed} is being read as ${mixUp.asRead}. ` +
    `If you meant ${mixUp.asIntended}, switch to ${mixUp.intendedLabel}.`
  );
}
