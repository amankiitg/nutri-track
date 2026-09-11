/**
 * The DeepSeek client, behind an interface so tests can supply a fake.
 *
 * The API is OpenAI-compatible. Two details are worth knowing, both taken from the
 * published API reference:
 *
 *   - Thinking mode is ON by default and its effort defaults to "high". An
 *     experimental vision model in thinking mode spends the entire output budget on
 *     reasoning and returns no content, so `reasoning_effort: "none"` is sent on
 *     every request. That is the documented way to disable it.
 *   - `max_tokens` defaults to 8K without thinking, but this endpoint returns a
 *     short JSON object, so it is capped to bound the worst-case cost of a bad
 *     response.
 *
 * `response_format: json_object` is deliberately not used. It is not documented for
 * the models configured here, and the contract already validates with Zod and
 * retries once.
 */
import { z } from "zod";
import { ApiError } from "./errors";

export interface ChatTextPart {
  type: "text";
  text: string;
}

export interface ChatImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type ChatContent = string | Array<ChatTextPart | ChatImagePart>;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: ChatContent;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
}

export interface Completion {
  content: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
}

export interface LlmClient {
  complete(request: CompletionRequest): Promise<Completion>;
}

export interface DeepSeekOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injectable so tests can assert the outgoing request without a network call. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The model's reply is an external payload, so it is parsed rather than trusted.
 * `content` is nullable: a reply that hit the token cap before producing anything
 * comes back as null, and that should become a retry, not a crash.
 */
const completionSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullish() }).nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().nullish(),
      completion_tokens: z.number().nullish(),
    })
    .nullish(),
});

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_TIMEOUT_MS = 60_000;

/** Keeps a pathological upstream body out of our logs. */
const BODY_EXCERPT = 500;

export function createDeepSeekClient(options: DeepSeekOptions): LlmClient {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async complete(request) {
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            // Documented switch: "none" disables thinking mode.
            reasoning_effort: "none",
            max_tokens: request.maxTokens,
            temperature: 0.2,
            stream: false,
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "network failure";
        throw new ApiError(502, "upstream_error", `Could not reach DeepSeek: ${reason}`);
      }

      const body = await response.text();
      const latencyMs = Date.now() - startedAt;

      if (!response.ok) {
        throw new ApiError(502, "upstream_error", `DeepSeek returned HTTP ${response.status}.`, {
          details: { status: response.status, body: body.slice(0, BODY_EXCERPT) },
        });
      }

      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        throw new ApiError(502, "upstream_error", "DeepSeek returned a body that is not JSON.", {
          details: { body: body.slice(0, BODY_EXCERPT) },
        });
      }

      const parsed = completionSchema.safeParse(json);
      if (!parsed.success) {
        throw new ApiError(
          502,
          "upstream_error",
          "DeepSeek returned an unexpected response shape.",
          {
            details: { issue: parsed.error.issues[0]?.message ?? "unknown" },
          },
        );
      }

      const choice = parsed.data.choices[0];
      return {
        content: choice?.message?.content ?? "",
        model: parsed.data.model ?? request.model,
        promptTokens: parsed.data.usage?.prompt_tokens ?? null,
        completionTokens: parsed.data.usage?.completion_tokens ?? null,
        latencyMs,
      };
    },
  };
}
