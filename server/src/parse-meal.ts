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
  RESPONSE_CONTRACT,
  RESPONSE_EXAMPLE,
  SYSTEM_PROMPT,
  type MealItemDraft,
  type MealSource,
  type MealType,
} from "../../shared/meal-parse";
import type { CallerStore, Photo } from "./caller-store";
import type { Config } from "./config";
import type { ChatImagePart, ChatMessage, ChatTextPart, Completion, LlmClient } from "./deepseek";
import { ApiError } from "./errors";
import { log } from "./log";
import type { ParseMealRequest } from "./schemas";
import { secondsUntilNextLocalMidnight, startOfLocalDay } from "./time";

/**
 * Model calls per user per local day. Counting calls rather than requests is the
 * conservative reading: a request that needed the retry costs the user two, which
 * is what it costs us.
 */
export const MAX_LLM_CALLS_PER_DAY = 60;

/** A bounded output budget: the reply is a short JSON object, not an essay. */
export const MAX_OUTPUT_TOKENS = 2048;

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

function buildSystemMessage(): ChatMessage {
  return {
    role: "system",
    content: [
      SYSTEM_PROMPT,
      "Respond with exactly this shape, and nothing else:",
      RESPONSE_CONTRACT,
      "For example:",
      RESPONSE_EXAMPLE,
    ].join("\n\n"),
  };
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

  const parts: Array<ChatTextPart | ChatImagePart> = [{ type: "text", text }];
  for (const photo of photos) {
    parts.push({
      type: "image_url",
      image_url: { url: `data:${photo.mimeType};base64,${photo.base64}` },
    });
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
    throw new ApiError(429, "rate_limited", "You have reached today's limit for analysing meals.", {
      headers: { "Retry-After": String(retryAfterSeconds) },
      details: {
        limit: MAX_LLM_CALLS_PER_DAY,
        used: usedToday,
        retry_after_seconds: retryAfterSeconds,
      },
    });
  }

  const photos = input.photoPaths.length > 0 ? await deps.store.loadPhotos(input.photoPaths) : [];
  const model =
    photos.length > 0 ? deps.config.DEEPSEEK_VISION_MODEL : deps.config.DEEPSEEK_TEXT_MODEL;
  const messages: ChatMessage[] = [buildSystemMessage(), buildUserMessage(input, photos)];

  /** One model call, logged whether or not it parses. */
  const runAttempt = async (attemptMessages: ChatMessage[]) => {
    let completion: Completion;
    try {
      completion = await deps.llm.complete({
        model,
        messages: attemptMessages,
        maxTokens: MAX_OUTPUT_TOKENS,
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
      status: result.ok ? "ok" : result.reason === "not_json" ? "invalid_json" : "invalid_schema",
    });
    return { completion, result };
  };

  const first = await runAttempt(messages);
  let items: MealItemDraft[];
  let attempts = 1;
  let modelThatAnswered = first.completion.model;

  if (first.result.ok) {
    items = first.result.items;
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
      throw new ApiError(
        422,
        "unparseable_response",
        "The model could not produce a usable answer for this meal. Try adding a short note about what it was.",
        { details: { reason: second.result.error } },
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
