/**
 * POST /parse-meal — the whole flow, minus HTTP.
 *
 * Everything here is injected (the model client, the caller-scoped store, the
 * clock), so the tests exercise the real control flow — including the retry, the
 * rate limit and the sanity checks — against a fake model and never touch the
 * network or spend a token.
 */
import {
  classifyModelResponse,
  guessMealType,
  MAX_LLM_CALLS_PER_DAY,
  modelContractSchema,
  SYSTEM_PROMPT,
  type MealItemDraft,
  type MealSource,
  type MealType,
} from "../../shared/meal-parse";
import type { CallerStore, Photo } from "./caller-store";
import type { Config } from "./config";
import type { ChatImagePart, ChatMessage, ChatTextPart, Completion, LlmClient } from "./llm";
import { ApiError } from "./errors";
import { log } from "./log";
import { zodToResponseSchema } from "./response-schema";
import type { ParseMealRequest } from "./schemas";
import { secondsUntilNextLocalMidnight, startOfLocalDay } from "./time";

/**
 * Re-exported so the service's own tests keep importing it from the module that
 * enforces it. The value is defined once, in the shared contract.
 */
export { MAX_LLM_CALLS_PER_DAY };

/** A bounded output budget: the reply is a short JSON object, not an essay. */
export const MAX_OUTPUT_TOKENS = 2048;

/**
 * The finish reasons that mean the model declined, rather than failed.
 *
 * The distinction earns its keep in two places. A refusal is deterministic — asking
 * again, in the same words, produces the same refusal — so retrying it costs the user
 * a second call out of their daily sixty to arrive at the same answer. And the advice
 * is different: a truncated or malformed reply is worth another go, a refusal is not,
 * and telling someone to "add a short note about what it was" when the note would also
 * be refused sends them round a loop that cannot terminate.
 */
const REFUSAL_FINISH_REASONS = new Set([
  "SAFETY",
  "IMAGE_SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
]);

export function isModelRefusal(finishReason: string | null | undefined): boolean {
  return finishReason != null && REFUSAL_FINISH_REASONS.has(finishReason);
}

/** Said when the model would not answer. Points somewhere that will. */
export const MODEL_DECLINED_MESSAGE =
  "The meal reader declined to analyse this one. Try a different photo, or type what you ate — typing works without a picture.";

/** Said when it did answer and the answer was unusable. */
export const UNUSABLE_RESPONSE_MESSAGE =
  "The meal reader could not make sense of this meal. Try adding a short note about what it was, or take the photo from further back.";

/** The retry wording is fixed so a failing prompt is reproducible from the logs. */
export const RETRY_INSTRUCTION_NOT_JSON =
  "Your previous response was not valid JSON. Return only the JSON object.";

export function retryInstructionForSchema(error: string): string {
  return `Your previous response did not match the required schema (${error}). Return only the JSON object.`;
}

export interface ParseMealOutcome {
  items: MealItemDraft[];
  meal_type: MealType;
  source: MealSource;
  /** The model that actually answered, for the record on screen. */
  model: string;
  /** 1 normally, 2 when the first reply had to be retried. */
  attempts: number;
}

export interface ParseMealDeps {
  config: Config;
  llm: LlmClient;
  store: CallerStore;
  /** Injectable clock, so the rate-limit window is testable. */
  now?: () => Date;
}

/**
 * The response schema is derived from the Zod contract in `shared/`, once, at module
 * load. Deriving it here rather than storing a hand-written copy is what keeps the
 * prompt, the model's contract and the validator from drifting apart.
 */
export const RESPONSE_SCHEMA = zodToResponseSchema(modelContractSchema);

function buildSystemMessage(): ChatMessage {
  // The shape is not described here: the provider enforces it. Repeating the field
  // list in the prompt would be a second copy free to disagree with the schema.
  return { role: "system", content: SYSTEM_PROMPT };
}

/** The user turn: what was said or typed, any hint, and the photos if there are any. */
function buildUserMessage(input: ParseMealRequest, photos: readonly Photo[]): ChatMessage {
  const lines: string[] = [];
  if (input.text) lines.push(input.text);
  if (input.hint) lines.push(`Additional context from the user: ${input.hint}`);
  if (input.mealType) lines.push(`The user says this is ${input.mealType}.`);
  if (photos.length > 0 && !input.text) lines.push("Identify every food item in the photos.");

  const text = lines.join("\n\n");
  if (photos.length === 0) return { role: "user", content: text };

  // Raw bytes, not a data URL: the provider decides how they go on the wire.
  const parts: Array<ChatTextPart | ChatImagePart> = [{ type: "text", text }];
  for (const photo of photos) {
    parts.push({ type: "image", base64: photo.base64, mimeType: photo.mimeType });
  }
  return { role: "user", content: parts };
}

/**
 * Recording a call must never fail a parse that succeeded — a meal the user
 * successfully logged is worth more than a telemetry row. A failure here is logged
 * loudly instead, because a broken insert would also silently disarm the rate limit.
 */
async function record(store: CallerStore, record: Parameters<CallerStore["recordCall"]>[0]) {
  try {
    await store.recordCall(record);
  } catch (error) {
    log("warn", "could not record an llm_call", {
      status: record.status,
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}

export async function parseMeal(
  input: ParseMealRequest,
  userId: string,
  deps: ParseMealDeps,
): Promise<ParseMealOutcome> {
  const now = deps.now?.() ?? new Date();
  const timeZone = await deps.store.timeZone();

  const usedToday = await deps.store.countCallsSince(startOfLocalDay(now, timeZone));
  if (usedToday >= MAX_LLM_CALLS_PER_DAY) {
    const retryAfterSeconds = secondsUntilNextLocalMidnight(now, timeZone);
    throw new ApiError(
      429,
      "rate_limited",
      `You have used all ${MAX_LLM_CALLS_PER_DAY} meal analyses for today.`,
      {
        headers: { "Retry-After": String(retryAfterSeconds) },
        details: {
          limit: MAX_LLM_CALLS_PER_DAY,
          used: usedToday,
          retry_after_seconds: retryAfterSeconds,
        },
      },
    );
  }

  const photos = input.photoPaths.length > 0 ? await deps.store.loadPhotos(input.photoPaths) : [];
  // One multimodal model for photos and text alike: Gemini Flash reads both, so
  // there is no second id to keep in step.
  const model = deps.config.GEMINI_VISION_MODEL;
  const messages: ChatMessage[] = [buildSystemMessage(), buildUserMessage(input, photos)];

  /** One model call, logged whether or not it parses. */
  const runAttempt = async (attemptMessages: ChatMessage[]) => {
    let completion: Completion;
    try {
      completion = await deps.llm.complete({
        model,
        messages: attemptMessages,
        maxTokens: MAX_OUTPUT_TOKENS,
        responseSchema: RESPONSE_SCHEMA,
      });
    } catch (error) {
      await record(deps.store, {
        model,
        promptTokens: null,
        completionTokens: null,
        latencyMs: null,
        status: "error",
      });
      throw error;
    }

    const result = classifyModelResponse(completion.content);
    await record(deps.store, {
      model: completion.model,
      promptTokens: completion.promptTokens,
      completionTokens: completion.completionTokens,
      latencyMs: completion.latencyMs,
      // The finish reason rides along on a not-JSON failure because that is the only
      // place it explains anything: an empty reply is a refusal or a truncation, and
      // the two are indistinguishable without it.
      status: result.ok ? "ok" : result.reason === "not_json" ? "invalid_json" : "invalid_schema",
    });

    if (!result.ok) {
      // finishReason belongs in the log rather than in `status`, which stays a small
      // set of values worth filtering on.
      log("warn", "the model's reply did not match the contract", {
        userId,
        model: completion.model,
        reason: result.reason,
        detail: result.error,
        finishReason: completion.finishReason,
      });
    }

    return { completion, result };
  };

  const first = await runAttempt(messages);
  let items: MealItemDraft[];
  let attempts = 1;
  let modelThatAnswered = first.completion.model;

  if (first.result.ok) {
    items = first.result.items;
  } else if (isModelRefusal(first.completion.finishReason)) {
    // Not retried, and said plainly. See REFUSAL_FINISH_REASONS.
    log("warn", "the model declined to answer", {
      userId,
      reason: first.result.reason,
      finishReason: first.completion.finishReason,
    });
    throw new ApiError(422, "unparseable_response", MODEL_DECLINED_MESSAGE, {
      details: { reason: "refusal", finishReason: first.completion.finishReason },
    });
  } else {
    // Exactly one retry, told precisely what was wrong with the first reply, with
    // the bad reply echoed back so "your previous response" has a referent.
    log("info", "retrying a parse that did not match the contract", {
      userId,
      reason: first.result.reason,
    });
    const instruction =
      first.result.reason === "not_json"
        ? RETRY_INSTRUCTION_NOT_JSON
        : retryInstructionForSchema(first.result.error);

    const second = await runAttempt([
      ...messages,
      { role: "assistant", content: first.completion.content },
      { role: "user", content: instruction },
    ]);
    attempts = 2;
    modelThatAnswered = second.completion.model;

    if (!second.result.ok) {
      // A retry that lands on a refusal is still a refusal, so the message follows the
      // finish reason rather than assuming the second attempt failed the same way.
      const declined = isModelRefusal(second.completion.finishReason);
      throw new ApiError(
        422,
        "unparseable_response",
        declined ? MODEL_DECLINED_MESSAGE : UNUSABLE_RESPONSE_MESSAGE,
        {
          details: {
            reason: declined ? "refusal" : second.result.error,
            finishReason: second.completion.finishReason,
          },
        },
      );
    }
    items = second.result.items;
  }

  const mealType = input.mealType ?? guessMealType(new Date(input.eatenAt), timeZone);

  return {
    items,
    meal_type: mealType,
    source: input.source,
    model: modelThatAnswered,
    attempts,
  };
}
