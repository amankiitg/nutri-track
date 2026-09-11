import { describe, expect, it } from "vitest";
import { MAX_EDGE } from "./capture";
import { buildParseRequest, fitWithin, messageFromErrorBody, parseResponseSchema } from "./capture";

describe("fitWithin", () => {
  it("leaves an image that is already small enough alone", () => {
    expect(fitWithin({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
  });

  it("caps the long edge of a photo straight off a phone", () => {
    expect(fitWithin({ width: 4032, height: 3024 })).toEqual({ width: 1024, height: 768 });
  });

  it("caps a portrait photo by its height", () => {
    expect(fitWithin({ width: 3024, height: 4032 })).toEqual({ width: 768, height: 1024 });
  });

  it("is a no-op exactly at the limit, and does not upscale past it", () => {
    expect(fitWithin({ width: MAX_EDGE, height: 500 })).toEqual({ width: MAX_EDGE, height: 500 });
    expect(fitWithin({ width: 100, height: 100 })).toEqual({ width: 100, height: 100 });
  });

  it("never rounds a dimension down to zero", () => {
    const squashed = fitWithin({ width: 8000, height: 3 });
    expect(squashed.height).toBeGreaterThanOrEqual(1);
    expect(squashed.width).toBe(1024);
  });

  it("preserves the aspect ratio within a pixel", () => {
    const source = { width: 4000, height: 2500 };
    const scaled = fitWithin(source);
    expect(scaled.width / scaled.height).toBeCloseTo(source.width / source.height, 2);
  });
});

describe("buildParseRequest", () => {
  const eatenAt = new Date("2026-03-02T12:05:00.000Z");

  it("sends an ISO instant with an offset, which is what the service requires", () => {
    const body = buildParseRequest({ source: "text", text: "two eggs", photoPaths: [], eatenAt });
    expect(body["eatenAt"]).toBe("2026-03-02T12:05:00.000Z");
  });

  it("sends null rather than omitting the optional fields", () => {
    const body = buildParseRequest({ source: "text", text: "two eggs", photoPaths: [], eatenAt });
    expect(body).toMatchObject({ mealType: null, hint: null });
  });

  it("keeps the photos that were uploaded", () => {
    const body = buildParseRequest({
      source: "photo",
      photoPaths: ["user-1/a.jpg", "user-1/b.jpg"],
      eatenAt,
    });
    expect(body["photoPaths"]).toEqual(["user-1/a.jpg", "user-1/b.jpg"]);
  });

  it("passes a hint through when there is one", () => {
    const body = buildParseRequest({
      source: "text",
      text: "rice",
      photoPaths: [],
      eatenAt,
      hint: "small portion",
    });
    expect(body["hint"]).toBe("small portion");
  });
});

describe("parseResponseSchema", () => {
  const valid = {
    items: [
      {
        name: "Oatmeal",
        quantity: 1,
        unit: "bowl",
        grams: 250,
        calories: 300,
        protein_g: 10,
        carbs_g: 54,
        fat_g: 6,
        fiber_g: 8,
        sugar_g: 12,
        sodium_mg: 150,
        confidence: 0.8,
        needs_review: false,
        review_reasons: [],
      },
    ],
    meal_type: "breakfast",
    source: "text",
    model: "gemini-3.8-flash",
    attempts: 1,
  };

  it("accepts a reply of the shape the service promises", () => {
    expect(parseResponseSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts nulls in the optional nutrient fields", () => {
    const nullable = {
      ...valid,
      items: [{ ...valid.items[0], grams: null, fiber_g: null, sugar_g: null, sodium_mg: null }],
    };
    expect(parseResponseSchema.safeParse(nullable).success).toBe(true);
  });

  it("rejects an unknown meal type", () => {
    expect(parseResponseSchema.safeParse({ ...valid, meal_type: "brunch" }).success).toBe(false);
  });

  it("rejects a reply whose item is missing needs_review", () => {
    const { needs_review: _dropped, ...item } = valid.items[0]!;
    expect(parseResponseSchema.safeParse({ ...valid, items: [item] }).success).toBe(false);
  });
});

describe("messageFromErrorBody", () => {
  it("reads the service's error envelope", () => {
    const body = JSON.stringify({ error: { code: "rate_limited", message: "Too many today." } });
    expect(messageFromErrorBody(body)).toBe("Too many today.");
  });

  it("returns null for a body that is not the envelope, so the caller can fall back", () => {
    expect(messageFromErrorBody("<html>502</html>")).toBeNull();
    expect(messageFromErrorBody(JSON.stringify({ nope: true }))).toBeNull();
  });
});
