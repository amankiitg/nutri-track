import { describe, expect, it } from "vitest";
import {
  cmToFtIn,
  cmToIn,
  displayValue,
  formatHeight,
  formatLength,
  formatWeight,
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
