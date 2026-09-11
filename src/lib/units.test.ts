import { describe, expect, it } from "vitest";
import {
  cmToFtIn,
  cmToIn,
  formatHeight,
  formatLength,
  formatWeight,
  ftInToCm,
  inToCm,
  kgToLb,
  lbToKg,
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
