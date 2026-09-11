/**
 * Derives the model's response schema from the Zod contract in `shared/`, so the
 * prompt, the validator and what the model is told to produce are one description
 * rather than three that agree by luck.
 *
 * The vocabulary is the JSON Schema subset that Gemini's structured-output mode
 * accepts, taken from its documentation:
 *
 *   - `type` is one of string, number, integer, boolean, object, array, null
 *   - a nullable field is a type *array*, e.g. ["string", "null"], not a union of
 *     two schemas
 *   - `description` and `title` are how the model is told what a field means, which
 *     is why the descriptions live on the Zod schema
 *   - `enum`, `minimum`, `maximum`, `items`, `minItems`, `maxItems`, `properties`,
 *     `required` and `additionalProperties` are supported
 *   - anything else — unions of different types, transforms, refinements, records,
 *     recursive types — is not, and is reported as unsupported rather than silently
 *     dropped, because a silently dropped constraint is a constraint the model does
 *     not have
 *
 * The converter is deliberately not general purpose. It handles the Zod features
 * the contract uses and throws on anything else, so a future edit to the contract
 * that the provider cannot express fails loudly here instead of producing a schema
 * that has quietly lost a field.
 */
import { z } from "zod";

export interface ResponseSchema {
  type?: string | string[];
  description?: string;
  title?: string;
  enum?: Array<string | number>;
  format?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: ResponseSchema;
  properties?: Record<string, ResponseSchema>;
  required?: string[];
  additionalProperties?: boolean;
}

export class UnsupportedZodTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedZodTypeError";
  }
}

/** Checks Zod can enforce locally but that the provider cannot be asked to honour. */
const COSMETIC_CHECKS = new Set([
  "trim",
  "toLowerCase",
  "toUpperCase",
  "min",
  "max",
  "length",
  "regex",
]);

function describe(source: z.ZodTypeAny): Partial<ResponseSchema> {
  const out: Partial<ResponseSchema> = {};
  if (source.description !== undefined) out.description = source.description;
  return out;
}

function numberSchema(source: z.ZodNumber): ResponseSchema {
  // Gemini takes integer for whole numbers, and it is what nudges the model away
  // from "2.0 servings".
  const schema: ResponseSchema = { type: source.isInt ? "integer" : "number", ...describe(source) };
  for (const check of source._def.checks) {
    if (check.kind === "min") schema.minimum = check.value;
    else if (check.kind === "max") schema.maximum = check.value;
    // "int" needs no field of its own: it is already expressed by type: "integer".
    else if (check.kind !== "int") {
      throw new UnsupportedZodTypeError(`a number with a ${check.kind} check cannot be expressed`);
    }
  }
  return schema;
}

function stringSchema(source: z.ZodString): ResponseSchema {
  const schema: ResponseSchema = { type: "string", ...describe(source) };
  for (const check of source._def.checks) {
    if (COSMETIC_CHECKS.has(check.kind)) continue;
    // Only the formats JSON Schema can express are forwarded.
    if (check.kind === "datetime") schema.format = "date-time";
    else if (check.kind === "date") schema.format = "date";
    else if (check.kind === "time") schema.format = "time";
    else
      throw new UnsupportedZodTypeError(`a string with a ${check.kind} check cannot be expressed`);
  }
  return schema;
}

function arraySchema(source: z.ZodArray<z.ZodTypeAny>): ResponseSchema {
  const schema: ResponseSchema = {
    type: "array",
    items: convert(source.element),
    ...describe(source),
  };
  // Bounds are in the supported subset, so forward them when present.
  if (source._def.minLength !== null) schema.minItems = source._def.minLength.value;
  if (source._def.maxLength !== null) schema.maxItems = source._def.maxLength.value;
  return schema;
}

function objectSchema(source: z.ZodObject<z.ZodRawShape>): ResponseSchema {
  const properties: Record<string, ResponseSchema> = {};
  const required: string[] = [];
  const shape = source.shape as Record<string, z.ZodTypeAny>;

  for (const [key, fieldSchema] of Object.entries(shape)) {
    const { inner, nullable, optional } = unwrap(fieldSchema);
    const converted = convertInner(inner);
    properties[key] = nullable ? { ...converted, type: withNull(converted.type) } : converted;
    // A nullable field is still required: null is how the model says "I do not know",
    // and omitting the key is not the same thing.
    if (!optional) required.push(key);
  }

  return { type: "object", properties, required, ...describe(source) };
}

/**
 * Zod's own `_def.typeName`, rather than `instanceof`.
 *
 * There are two copies of zod reachable from this package — the shared contract
 * resolves the root install, the service resolves its own — and `instanceof` is
 * false across copies. Using it here failed with "ZodObject cannot be expressed"
 * for the very schema it exists to convert. `_def.typeName` is the same string
 * whichever copy built the schema, so this works in the test runner and in the
 * bundle alike.
 */
function typeNameOf(source: z.ZodTypeAny): string {
  return (source as { _def?: { typeName?: string } })._def?.typeName ?? "unknown";
}

interface Unwrapped {
  inner: z.ZodTypeAny;
  nullable: boolean;
  optional: boolean;
}

/** Peels off `ZodNullable` / `ZodOptional` and reports what it found. */
function unwrap(source: z.ZodTypeAny): Unwrapped {
  let inner = source;
  let nullable = false;
  let optional = false;

  for (;;) {
    const typeName = typeNameOf(inner);
    if (typeName === "ZodNullable") nullable = true;
    else if (typeName === "ZodOptional") optional = true;
    else return { inner, nullable, optional };
    inner = (inner as z.ZodNullable<z.ZodTypeAny>).unwrap() as z.ZodTypeAny;
  }
}

function convertInner(source: z.ZodTypeAny): ResponseSchema {
  switch (typeNameOf(source)) {
    case "ZodString":
      return stringSchema(source as z.ZodString);
    case "ZodNumber":
      return numberSchema(source as z.ZodNumber);
    case "ZodBoolean":
      return { type: "boolean", ...describe(source) };
    case "ZodEnum": {
      const options = (source as unknown as { options: string[] }).options;
      return { type: "string", enum: [...options], ...describe(source) };
    }
    case "ZodArray":
      return arraySchema(source as z.ZodArray<z.ZodTypeAny>);
    case "ZodObject":
      return objectSchema(source as z.ZodObject<z.ZodRawShape>);
    case "ZodLiteral": {
      const value = (source as unknown as { value: unknown }).value;
      if (typeof value === "string") return { type: "string", enum: [value] };
      if (typeof value === "number") return { type: "number", enum: [value] };
      throw new UnsupportedZodTypeError(`a literal of type ${typeof value} cannot be expressed`);
    }
    case "ZodUnion": {
      // Only a union of literals becomes an enum; anything else is unexpressible.
      const options = (source as unknown as { options: z.ZodTypeAny[] }).options;
      if (options.every((option) => typeNameOf(option) === "ZodLiteral")) {
        return {
          enum: options.map((option) => (option as unknown as { value: string }).value),
        };
      }
      throw new UnsupportedZodTypeError(
        "a union of mixed types cannot be expressed: the provider accepts one type per field, plus null",
      );
    }
    default:
      throw new UnsupportedZodTypeError(
        `${typeNameOf(source)} cannot be expressed as a response schema. The provider accepts one type per field, plus null.`,
      );
  }
}

function withNull(type: ResponseSchema["type"]): string | string[] {
  if (type === undefined) return ["null"];
  return Array.isArray(type) ? [...type, "null"] : [type, "null"];
}

/** Converts one schema, keeping the null-ness of the field it came from. */
function convert(source: z.ZodTypeAny): ResponseSchema {
  const { inner, nullable } = unwrap(source);
  const converted = convertInner(inner);
  if (!nullable) return converted;
  return { ...converted, type: withNull(converted.type) };
}

/**
 * The response schema to send with the request. `additionalProperties: false` is
 * what makes the model stick to the listed fields instead of inventing its own.
 */
export function zodToResponseSchema(schema: z.ZodTypeAny): ResponseSchema {
  const converted = convert(schema);
  if (converted.type === "object") {
    return { ...converted, additionalProperties: false };
  }
  return converted;
}
