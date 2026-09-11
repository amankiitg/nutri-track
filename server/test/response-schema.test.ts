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
import { UnsupportedZodTypeError, zodToResponseSchema, type ResponseSchema } from "../src/response-schema";

describe("zodToResponseSchema", () => {
  const schema = zodToResponseSchema(modelContractSchema);

  it("describes the top level as the object the model must return", () => {
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["items"]);
    // Not additionalProperties: the Proto has no such field and rejects the whole
    // request if it is sent. Checked on the serialised form, because the type no
    // longer declares the property to assert on.
    expect(Object.keys(schema)).not.toContain("additionalProperties");
  });

  it("carries the Zod descriptions through as the model's instructions", () => {
    const item = schema.properties?.["items"]?.items;
    expect(item?.type).toBe("object");
    expect(item?.properties?.["name"]?.description).toContain("as a person would say it");
    expect(item?.properties?.["calories"]?.description).toContain("not per 100 g");
  });

  it("marks a nullable field with the Proto nullable flag, not a type array", () => {
    const item = schema.properties?.["items"]?.items;
    // generationConfig.responseSchema is a Proto Schema, in which `type` is a single
    // enum. A type array is rejected outright with "Proto field is not repeating,
    // cannot start list" — which is how a real call found this.
    expect(item?.properties?.["grams"]?.type).toBe("number");
    expect(item?.properties?.["grams"]?.nullable).toBe(true);
    expect(item?.properties?.["sugar_g"]?.nullable).toBe(true);
    expect(item?.properties?.["unit"]?.nullable).toBe(true);
  });

  it("leaves a non-nullable field as a single type with no nullable flag", () => {
    const item = schema.properties?.["items"]?.items;
    expect(item?.properties?.["calories"]?.type).toBe("number");
    expect(item?.properties?.["name"]?.type).toBe("string");
    expect(item?.properties?.["calories"]?.nullable).toBeUndefined();
    expect(item?.properties?.["confidence"]?.nullable).toBeUndefined();
  });

  it("never emits a type array anywhere, at any depth", () => {
    // The whole schema is rejected if one field uses the documented-but-wrong form,
    // so this walks the tree rather than trusting the fields we happen to assert on.
    const walk = (node: ResponseSchema | undefined, path: string): void => {
      if (node === undefined) return;
      expect({ path, type: Array.isArray(node.type) }).toEqual({ path, type: false });
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        walk(child, `${path}.${key}`);
      }
      walk(node.items, `${path}[]`);
    };
    walk(schema, "response");
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
