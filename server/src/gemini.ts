/**
 * The Gemini implementation of `LlmClient`, against the `generateContent` REST API.
 *
 * Two things it does that the OpenAI-compatible shape did not need:
 *
 *   - **Structured output.** `generationConfig.responseMimeType` is set to
 *     `application/json` and `responseSchema` carries the schema derived from the
 *     Zod contract, so the model returns conforming JSON rather than merely valid
 *     JSON. That is the whole reason for the provider change.
 *   - **System instructions.** Gemini takes the system prompt in its own
 *     `systemInstruction` field rather than as a message with role "system", and to
 *     make matters worse it calls the assistant role "model". Both are translated
 *     here so nothing above this file has to know.
 *
 * There is no thinking-mode switch to fight any more: the Flash models answer
 * directly, so there is nothing to disable.
 */
import { z } from "zod";
import { ApiError } from "./errors";
import { log } from "./log";
import type { ChatContent, ChatMessage, Completion, CompletionRequest, LlmClient } from "./llm";
import type { ResponseSchema } from "./response-schema";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_TIMEOUT_MS = 60_000;
/** Keeps a pathological upstream body out of our logs. */
const BODY_EXCERPT = 500;

/**
 * What went wrong upstream, said to the person holding the phone.
 *
 * These messages are shown verbatim in the capture sheet, so they are written for
 * that reader and not for a log: no status codes, no host names, and one sentence
 * saying whether trying again is worth anything. The status code and the upstream
 * body still travel in `details`, where the logs can find them and the user cannot.
 */
const UPSTREAM_MESSAGES = {
  /**
   * Google's own quota, not the user's daily budget. It is transient — a per-minute
   * window — so the advice is to wait, and `ApiError.headers` carries a Retry-After
   * so the UI can be specific about how long.
   */
  busy: "The meal reader is busy at the moment. Nothing was logged — try again in a minute.",
  /** A key problem or a 5xx. Neither is the user's fault and neither is worth retrying. */
  broken:
    "The meal reader is not available right now. Your photo is still here, so try again later.",
  unreachable: "Could not reach the meal reader. Check your connection and try again.",
} as const;

/** The upstream statuses that mean "throttled", and how long to wait by default. */
const RETRYABLE_STATUSES = new Set([429, 503]);
const DEFAULT_RETRY_AFTER_SECONDS = 30;

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/**
 * The reply is an external payload, so it is parsed rather than trusted. Every field
 * is optional because an error shape is still JSON: the only thing worth insisting
 * on is that `candidates` is an array when present.
 */
const geminiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({ parts: z.array(z.object({ text: z.string().nullish() })).nullish() })
          .nullish(),
        finishReason: z.string().nullish(),
      }),
    )
    .nullish(),
  // Present when the prompt itself was refused, which produces no candidates at all.
  promptFeedback: z.object({ blockReason: z.string().nullish() }).nullish(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().nullish(),
      candidatesTokenCount: z.number().nullish(),
    })
    .nullish(),
  modelVersion: z.string().nullish(),
});

/** Gemini wants the top-level schema inline, not wrapped in a `{name, schema}` pair. */
export function responseSchemaFor(schema: ResponseSchema): Record<string, unknown> {
  return schema as unknown as Record<string, unknown>;
}

function toParts(content: ChatContent): GeminiPart[] {
  if (typeof content === "string") return [{ text: content }];
  return content.map((part) => {
    if (part.type === "text") return { text: part.text };
    return { inline_data: { mime_type: part.mimeType, data: part.base64 } };
  });
}

/**
 * Splits the neutral message list into Gemini's two concepts: a system instruction
 * and the contents array, in which the assistant is called "model".
 */
export function toGeminiPayload(messages: ChatMessage[]): {
  contents: GeminiContent[];
  systemInstruction: { parts: GeminiPart[] } | undefined;
} {
  const contents: GeminiContent[] = [];
  const systemParts: GeminiPart[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(...toParts(message.content));
      continue;
    }
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: toParts(message.content),
    });
  }

  return {
    contents,
    systemInstruction: systemParts.length > 0 ? { parts: systemParts } : undefined,
  };
}

export interface GeminiOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injectable so tests can assert the outgoing request without a network call. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createGeminiClient(options: GeminiOptions): LlmClient {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async complete(request: CompletionRequest): Promise<Completion> {
      const { contents, systemInstruction } = toGeminiPayload(request.messages);
      const startedAt = Date.now();

      let response: Response;
      try {
        response = await doFetch(
          `${baseUrl}/v1beta/models/${encodeURIComponent(request.model)}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              // The key goes in a header, not a query string, so it stays out of
              // URLs and out of anything that logs them.
              "x-goog-api-key": options.apiKey,
            },
            body: JSON.stringify({
              ...(systemInstruction === undefined ? {} : { systemInstruction }),
              contents,
              generationConfig: {
                responseMimeType: "application/json",
                responseSchema: responseSchemaFor(request.responseSchema),
                maxOutputTokens: request.maxTokens,
                // Nutrition estimates should not be creative.
                temperature: 0.2,
              },
            }),
            signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
          },
        );
      } catch (error) {
        // A timeout is not a network failure and should not be described as one: the
        // first means Google is slow, the second means the service cannot get there at
        // all, and only the second is worth the user checking their connection over.
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        throw new ApiError(
          503,
          "upstream_error",
          timedOut ? UPSTREAM_MESSAGES.broken : UPSTREAM_MESSAGES.unreachable,
          {
            details: {
              timedOut,
              timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
              error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            },
          },
        );
      }

      const body = await response.text();
      const latencyMs = Date.now() - startedAt;

      if (!response.ok) {
        const retryable = RETRYABLE_STATUSES.has(response.status);
        throw new ApiError(
          retryable ? 503 : 502,
          "upstream_error",
          retryable ? UPSTREAM_MESSAGES.busy : UPSTREAM_MESSAGES.broken,
          {
            // On the response rather than only in the body, so a client that never
            // reads the body still knows how long to wait.
            ...(retryable
              ? {
                  headers: { "Retry-After": String(DEFAULT_RETRY_AFTER_SECONDS) },
                }
              : {}),
            details: { status: response.status, body: body.slice(0, BODY_EXCERPT) },
          },
        );
      }

      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        throw new ApiError(502, "upstream_error", UPSTREAM_MESSAGES.broken, {
          details: { body: body.slice(0, BODY_EXCERPT) },
        });
      }

      const parsed = geminiResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new ApiError(502, "upstream_error", UPSTREAM_MESSAGES.broken, {
          details: { issue: parsed.error.issues[0]?.message ?? "unknown" },
        });
      }

      const candidate = parsed.data.candidates?.[0];
      const text = (candidate?.content?.parts ?? [])
        .map((part) => part.text ?? "")
        .join("")
        .trim();

      // A refusal and a truncated reply both arrive here as empty content, and the
      // caller turns that into a retry. finishReason is what makes it diagnosable.
      const finishReason =
        candidate?.finishReason ?? parsed.data.promptFeedback?.blockReason ?? null;
      if (text === "") {
        log("warn", "gemini returned no content", {
          model: request.model,
          finishReason: finishReason ?? "no candidate",
        });
      }

      return {
        content: text,
        model: parsed.data.modelVersion ?? request.model,
        promptTokens: parsed.data.usageMetadata?.promptTokenCount ?? null,
        completionTokens: parsed.data.usageMetadata?.candidatesTokenCount ?? null,
        latencyMs,
        finishReason: finishReason ?? null,
      };
    },
  };
}
