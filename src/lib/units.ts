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
