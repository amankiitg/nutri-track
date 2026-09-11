/**
 * Manual smoke test for the model provider.
 *
 * This spends real tokens, so it lives outside `test/` and is never collected by the
 * test runner. Nothing in the suite imports it. Run it by hand when the provider
 * configuration changes:
 *
 *   cd server
 *   npm run smoke -- /path/to/a/food/photo.jpg
 *
 * It sends ONE real image through the real client, with the real response schema
 * derived from the Zod contract, and prints what came back: the finish reason, the
 * token counts, and the parsed items. If the provider rejects the response schema,
 * that is reported plainly rather than falling back to prompt-only JSON.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { classifyModelResponse, modelContractSchema, SYSTEM_PROMPT } from "../../shared/meal-parse";
import { loadConfig } from "../src/config";
import { createGeminiClient } from "../src/gemini";
import { ApiError } from "../src/errors";
import { zodToResponseSchema } from "../src/response-schema";

const MAX_OUTPUT_TOKENS = 2048;

/** `.env` is the single source of truth for the key and the model id. */
function loadEnvFile(): void {
  const path = fileURLToPath(new URL("../../.env", import.meta.url));
  try {
    // Node's own reader, so this script needs no dotenv dependency.
    process.loadEnvFile(path);
  } catch {
    console.warn(`could not read ${path}; falling back to the ambient environment`);
  }
}

function mimeTypeOf(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".heic")) return "image/heic";
  return "image/jpeg";
}

/** A readable summary of the schema, rather than the whole 1.5 kB object. */
function describeSchema(schema: ReturnType<typeof zodToResponseSchema>): string {
  const items = schema.properties?.["items"];
  const item = items?.items;
  const fields = Object.entries(item?.properties ?? {}).map(([name, field]) => {
    return `${name}:${field.type}${field.nullable === true ? "?" : ""}`;
  });
  return [
    `top level: ${schema.type}, required [${(schema.required ?? []).join(", ")}]`,
    `items: ${items?.type} of ${item?.type}`,
    `fields: ${fields.join(", ")}`,
    `schema size: ${JSON.stringify(schema).length} bytes`,
  ].join("\n  ");
}

async function main(): Promise<void> {
  loadEnvFile();

  const imagePath = process.argv[2];
  if (imagePath === undefined) {
    console.error("usage: npm run smoke -- <path-to-image>");
    process.exit(2);
  }

  const config = loadConfig();
  const bytes = await readFile(imagePath);
  const mimeType = mimeTypeOf(imagePath);
  const responseSchema = zodToResponseSchema(modelContractSchema);

  console.log("--- request ---");
  console.log(`  model:  ${config.GEMINI_VISION_MODEL}`);
  console.log(`  image:  ${imagePath} (${mimeType}, ${(bytes.length / 1024).toFixed(1)} kB)`);
  console.log(`  prompt: ${SYSTEM_PROMPT.length} chars`);
  console.log(`  structured output requested, response schema:\n  ${describeSchema(responseSchema)}`);
  console.log("");

  const client = createGeminiClient({ apiKey: config.GEMINI_API_KEY });
  const startedAt = Date.now();

  let completion;
  try {
    completion = await client.complete({
      model: config.GEMINI_VISION_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "Identify every food item in this photo." },
            { type: "image", base64: bytes.toString("base64"), mimeType },
          ],
        },
      ],
      maxTokens: MAX_OUTPUT_TOKENS,
      responseSchema,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      console.error("--- FAILED ---");
      console.error(`  ${error.message}`);
      console.error(`  details: ${JSON.stringify(error.details)}`);
      const details = error.details as { status?: number } | undefined;
      if (details?.status === 400) {
        console.error(
          "\n  HTTP 400 usually means the response schema was rejected for this model id.\n" +
            "  This script does not fall back to prompt-only JSON: the schema is the contract.",
        );
      }
      process.exit(1);
    }
    throw error;
  }

  const wallClockMs = Date.now() - startedAt;
  const result = classifyModelResponse(completion.content);

  console.log("--- response ---");
  console.log(`  model answered:   ${completion.model}`);
  console.log(`  finishReason:     ${completion.finishReason ?? "(none)"}`);
  console.log(`  latency:          ${completion.latencyMs} ms upstream, ${wallClockMs} ms total`);
  console.log(
    `  tokens:           prompt ${completion.promptTokens ?? "?"}, output ${completion.completionTokens ?? "?"}, total ${
      (completion.promptTokens ?? 0) + (completion.completionTokens ?? 0)
    }`,
  );
  console.log(`  reply length:     ${completion.content.length} chars`);
  console.log(`  conformed:        ${result.ok ? "yes" : `no (${result.reason})`}`);
  console.log("");
  console.log("--- raw reply ---");
  console.log(completion.content === "" ? "  (empty)" : `  ${completion.content}`);

  if (!result.ok) {
    console.error("");
    console.error(`--- the reply did not satisfy the contract: ${result.reason} ---`);
    console.error(`  ${result.error}`);
    process.exit(1);
  }

  console.log("");
  console.log("--- parsed items ---");
  console.log(`  ${result.items.length} item(s) after normalisation`);
  console.log(JSON.stringify(result.items, null, 2));
}

await main();
