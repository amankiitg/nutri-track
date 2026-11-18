import { describe, expect, it } from "vitest";
import {
  cmToFtIn,
  cmToIn,
  displayValue,
  formatHeight,
  formatLength,
  formatMeasuredWeight,
  formatWeight,
  formatWeightDelta,
  ftInToCm,
  inToCm,
  kgToLb,
  lbToKg,
  wrongUnit,
  wrongUnitSentence,
} from "./units";

describe("formatLength", () => {
  it("reads centimetres in metric", () => {
    expect(formatLength(80, "metric")).toBe("80.0 cm");
  });

  it("reads inches in imperial, and converts", () => {
    // 80 cm / 2.54 = 31.496..., so 31.5 in. Inches are what a tape measure shows for a
    // waist; feet and inches are right for a height and wrong for this.
    expect(formatLength(80, "imperial")).toBe("31.5 in");
  });

  it("agrees with cmToIn rather than keeping a second conversion factor", () => {
    for (const cm of [60, 75.5, 80, 92.3, 110]) {
      expect(formatLength(cm, "imperial", 2)).toBe(`${cmToIn(cm).toFixed(2)} in`);
    }
  });

  it("does not express a waist in feet", () => {
    // The obvious mistake is reusing formatHeight, which would print "2′ 7″" here.
    expect(formatLength(80, "imperial")).not.toContain("′");
  });

  it("takes a smaller number of decimals when asked", () => {
    expect(formatLength(80, "metric", 0)).toBe("80 cm");
  });
});

describe("wrongUnit", () => {
  const adultWeight = (base: number) => base >= 30 && base <= 400;
  const adultHeight = (base: number) => base >= 100 && base <= 250;

  it("spots a kilogram number typed into a pound field", () => {
    // 60 lb is 27.2 kg, under any adult range. 60 kg is a person.
    expect(wrongUnit(60, "imperial", "mass", adultWeight)).toMatchObject({
      selectedLabel: "lb",
      intendedLabel: "Metric",
      typed: "60",
      asRead: "27.2 kg",
      asIntended: "60 kg",
    });
  });

  it("spots an inches number typed into a centimetre field", () => {
    // 65 cm is not a person's height; 65 in is.
    expect(wrongUnit(65, "metric", "length", adultHeight)).toMatchObject({
      typed: "65",
      asRead: "25.6 in",
      asIntended: "65 in",
    });
  });

  it("says nothing when the value is nobody's measurement in either unit", () => {
    // 4 is not 4 kg or 4 lb. Speculating about units here is noise on top of the real message.
    expect(wrongUnit(4, "imperial", "mass", adultWeight)).toBeNull();
  });

  it("says nothing when the guard would have passed anyway", () => {
    expect(wrongUnit(70, "imperial", "mass", adultWeight)).toBeNull();
  });

  it("rounds the digits it prints, because they arrive through a conversion", () => {
    // A field showing 55 lb has been through the database as 24.947 kg and back as 54.994.
    const asShown = displayValue(lbToKg(55), "imperial", "mass");
    expect(wrongUnit(asShown, "imperial", "mass", adultWeight)?.typed).toBe("55");
  });

  it("takes the field's own name for its unit", () => {
    // An imperial height is two boxes, so the field says "ft and in" rather than "in".
    expect(wrongUnit(65, "metric", "length", adultHeight, "ft and in")?.selectedLabel).toBe(
      "ft and in",
    );
  });

  it("words the sentence with the cause before the consequence", () => {
    const mixUp = wrongUnit(60, "imperial", "mass", adultWeight);
    if (mixUp === null) throw new Error("expected a unit mix-up");
    expect(wrongUnitSentence(mixUp)).toBe(
      "lb is selected, so 60 is being read as 27.2 kg. If you meant 60 kg, switch to Metric.",
    );
  });
});

describe("the existing conversions, unchanged", () => {
  it("round-trips kilograms through pounds", () => {
    expect(lbToKg(kgToLb(70))).toBeCloseTo(70, 10);
  });

  it("round-trips centimetres through inches", () => {
    expect(inToCm(cmToIn(80))).toBeCloseTo(80, 10);
  });

  it("still formats a height as feet and inches", () => {
    expect(formatHeight(180, "metric")).toBe("180 cm");
    expect(formatHeight(180, "imperial")).toBe("5′ 11″");
  });

  it("splits a height into feet and inches consistently", () => {
    expect(cmToFtIn(180)).toEqual({ ft: 5, in: 11 });
    expect(ftInToCm(5, 11)).toBeCloseTo(180.34, 2);
  });

  it("formats a weight in the unit asked for", () => {
    expect(formatWeight(70, "metric")).toBe("70.0 kg");
    expect(formatWeight(70, "imperial")).toBe("154.3 lb");
  });
});

describe("formatMeasuredWeight", () => {
  it("uses the weight card's precision: two decimals of kilograms", () => {
    // The card reads `displayRounded`, where kilograms keep the column's two decimals rather
    // than formatWeight's one. 69.46 and 69.5 must not be printed as the same number.
    expect(formatMeasuredWeight(69.46, "metric")).toBe("69.46 kg");
  });

  it("uses the weight card's precision: one decimal of pounds, no trailing zero", () => {
    expect(formatMeasuredWeight(lbToKg(169.44), "imperial")).toBe("169.4 lb");
    expect(formatMeasuredWeight(lbToKg(170), "imperial")).toBe("170 lb");
  });
});

/**
 * The change since the previous weigh-in.
 *
 * The first case is the reported bug: 167.6 lb to 166.6 lb showed 1.1 lb. The card used to round
 * the kilogram difference to a tenth (0.45 kg became 0.5 kg) and then convert that rounded
 * number, so the last digit was decided in the unit the reader does not use.
 */
describe("formatWeightDelta", () => {
  /** What the column holds for a pound reading: kilograms to two decimals. */
  const storedKg = (lb: number) => Number(lbToKg(lb).toFixed(2));

  it("prints a pound of change as 1.0 lb, not 1.1", () => {
    const delta = storedKg(166.6) - storedKg(167.6);
    expect(delta).toBeCloseTo(-0.45, 2);
    expect(formatWeightDelta(delta, "imperial")).toBe("1.0");
  });

  it("keeps two decimals for kilograms, trailing zero and all", () => {
    // Fixed decimals rather than displayRounded’s dropped zero: 0.50 kg sits under "76.00 kg".
    expect(formatWeightDelta(76.0 - 75.5, "metric")).toBe("0.50");
    expect(formatWeightDelta(0.4, "metric")).toBe("0.40");
    expect(formatWeightDelta(0.4, "imperial")).toBe("0.9");
  });

  it("says the same thing in either system", () => {
    const delta = storedKg(166.6) - storedKg(167.6);
    const metric = Number(formatWeightDelta(delta, "metric"));
    const imperial = Number(formatWeightDelta(delta, "imperial"));
    // One change, two readings: each is the other converted, inside its own half-step.
    expect(metric).toBeCloseTo(0.45, 2);
    expect(kgToLb(metric)).toBeCloseTo(imperial, 1);
  });

  it("round-trips a pound reading unchanged", () => {
    // 167.6 lb is stored as 76.02 kg and has to come back as the same number in the box.
    expect(formatMeasuredWeight(storedKg(167.6), "imperial")).toBe("167.6 lb");
  });

  it("says nothing when the change rounds away in the reader’s unit", () => {
    expect(formatWeightDelta(0.002, "metric")).toBeNull();
    expect(formatWeightDelta(0.002, "imperial")).toBeNull();
    expect(formatWeightDelta(0, "metric")).toBeNull();
    expect(formatWeightDelta(-0.004, "imperial")).toBeNull();
  });
});
