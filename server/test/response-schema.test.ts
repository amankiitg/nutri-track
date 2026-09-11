/**
 * The Zod → response-schema conversion, and the guarantee that it agrees with what
 * the model's reply is validated against.
 *
 * The point of the last block is the important one: the contract schema is what the
 * model is told to produce and the tolerant schema is what we validate against, so a
 * reply that satisfies the contract must never be rejected. If those two ever
 * diverge, this fails rather than the app silently retrying forever.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { modelContractSchema, parseModelResponse } from "../../shared/meal-parse";
import { UnsupportedZodTypeError, zodToResponseSchema } from "../src/response-schema";

describe("zodToResponseSchema", () => {
  const schema = zodToResponseSchema(modelContractSchema);

  it("describes the top level as an object that admits no extra fields", () => {
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["items"]);
  });

  it("carries the Zod descriptions through as the model's instructions", () => {
    const item = schema.properties?.["items"]?.items;
    expect(item?.type).toBe("object");
    expect(item?.properties?.["name"]?.description).toContain("as a person would say it");
    expect(item?.properties?.["calories"]?.description).toContain("not per 100 g");
  });

  it("expresses a nullable field as a type array, not a union", () => {
    const item = schema.properties?.["items"]?.items;
    expect(item?.properties?.["grams"]?.type).toEqual(["number", "null"]);
    expect(item?.properties?.["sugar_g"]?.type).toEqual(["number", "null"]);
  });

  it("leaves a non-nullable field as a single type", () => {
    const item = schema.properties?.["items"]?.items;
    expect(item?.properties?.["calories"]?.type).toBe("number");
    expect(item?.properties?.["name"]?.type).toBe("string");
  });

  it("keeps every field required, so null is how the model says 'unknown'", () => {
    const item = schema.properties?.["items"]?.items;
    expect(item?.required).toEqual([
      "name",
      "quantity",
      "unit",
      "grams",
      "calories",
      "protein_g",
      "carbs_g",
      "fat_g",
      "fiber_g",
      "sugar_g",
      "sodium_mg",
      "confidence",
    ]);
  });

  it("forwards the confidence bounds, which is what keeps it between 0 and 1", () => {
    const confidence = schema.properties?.["items"]?.items?.properties?.["confidence"];
    expect(confidence?.minimum).toBe(0);
    expect(confidence?.maximum).toBe(1);
  });

  it("converts integers, booleans, enums and arrays", () => {
    expect(
      zodToResponseSchema(
        z.object({
          servings: z.number().int(),
          reviewed: z.boolean(),
          meal: z.enum(["breakfast", "lunch"]),
          notes: z.array(z.string()),
        }),
      ).properties,
    ).toEqual({
      servings: { type: "integer" },
      reviewed: { type: "boolean" },
      meal: { type: "string", enum: ["breakfast", "lunch"] },
      notes: { type: "array", items: { type: "string" } },
    });
  });

  it("treats an optional field as not required", () => {
    const converted = zodToResponseSchema(z.object({ a: z.string(), b: z.string().optional() }));
    expect(converted.required).toEqual(["a"]);
  });

  it("refuses a union of mixed types rather than dropping it", () => {
    // Silently dropping this would hand the model a schema with no constraint on the
    // field at all, which is worse than failing.
    expect(() => zodToResponseSchema(z.object({ a: z.union([z.string(), z.number()]) }))).toThrow(
      UnsupportedZodTypeError,
    );
  });

  it("refuses a transform, which a JSON Schema cannot express", () => {
    expect(() =>
      zodToResponseSchema(z.object({ a: z.string().transform((v) => v.length) })),
    ).toThrow(UnsupportedZodTypeError);
  });

  it("names the unsupported type in the error, so the cause is obvious", () => {
    expect(() => zodToResponseSchema(z.object({ a: z.record(z.string()) }))).toThrow(
      /ZodRecord cannot be expressed/,
    );
  });

  it("does not choke on the cosmetic checks a string may carry", () => {
    expect(
      zodToResponseSchema(z.object({ a: z.string().trim().min(1).max(50) })).properties,
    ).toEqual({
      a: { type: "string" },
    });
  });
});

describe("the contract and the validator agree", () => {
  /** A payload of exactly the shape the response schema describes. */
  const contractConforming = {
    items: [
      {
        name: "Sourdough toast",
        quantity: 1,
        unit: "slice",
        grams: 45,
        calories: 120,
        protein_g: 4,
        carbs_g: 22,
        fat_g: 1,
        fiber_g: 1.2,
        sugar_g: 1,
        sodium_mg: 210,
        confidence: 0.75,
      },
    ],
  };

  it("accepts a reply that fits the contract", () => {
    const result = parseModelResponse(JSON.stringify(contractConforming));
    expect(result.ok).toBe(true);
  });

  it("accepts a contract-conforming reply with every nullable field set to null", () => {
    const allNull = {
      items: [
        {
          name: "Black coffee",
          quantity: null,
          unit: null,
          grams: null,
          calories: 2,
          protein_g: 0,
          carbs_g: 0,
          fat_g: 0,
          fiber_g: null,
          sugar_g: null,
          sodium_mg: null,
          confidence: 0.9,
        },
      ],
    };
    expect(parseModelResponse(JSON.stringify(allNull)).ok).toBe(true);
  });

  it("accepts an empty list, which is the model saying it found no food", () => {
    expect(parseModelResponse(JSON.stringify({ items: [] }))).toEqual({ ok: true, items: [] });
  });

  it("still validates: a reply missing a name is rejected, schema or no schema", () => {
    const missingName = { items: [{ ...contractConforming.items[0], name: "" }] };
    const result = parseModelResponse(JSON.stringify(missingName));
    expect(result.ok).toBe(false);
  });
});
