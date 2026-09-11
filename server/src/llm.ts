/**
 * The model call, as the service depends on it.
 *
 * Provider-neutral on purpose. The part that matters is the image: Gemini wants
 * base64 in an `inline_data` field while the OpenAI-compatible APIs want a data
 * URL, so the request carries raw bytes and the provider decides how to encode
 * them. Getting that seam right is the difference between one provider and two.
 *
 * The interface is also what lets the tests drive the real control flow — the rate
 * limit, the retry, the sanity checks — against a fake, with no network and no
 * tokens spent.
 */
import type { ResponseSchema } from "./response-schema";

export interface ChatTextPart {
  type: "text";
  text: string;
}

/** Raw bytes: how they go on the wire is the provider's business. */
export interface ChatImagePart {
  type: "image";
  base64: string;
  mimeType: string;
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
  /**
   * The shape the reply must take, derived from the Zod contract in `shared/`.
   * A provider with structured output sends it and the model conforms; one that
   * cannot is free to ignore it, which is why the reply is validated either way.
   */
  responseSchema: ResponseSchema;
}

export interface Completion {
  /** The model's reply text. Empty when the model returned no content at all. */
  content: string;
  /** The model that actually answered, which can differ from the one requested. */
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
  /**
   * The provider's reason for stopping, when it gives one: "STOP", "MAX_TOKENS",
   * "SAFETY". Recorded because with structured output it is the only explanation
   * available for an empty reply.
   */
  finishReason: string | null;
}

export interface LlmClient {
  complete(request: CompletionRequest): Promise<Completion>;
}
