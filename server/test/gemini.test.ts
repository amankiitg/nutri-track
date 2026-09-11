/**
 * The real Gemini client, driven through an injected fetch. Asserting the outgoing
 * request is the point: structured output and the system-instruction translation are
 * exactly the things that would break silently.
 */
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/errors";
import { createGeminiClient, responseSchemaFor, toGeminiPayload } from "../src/gemini";
import type { ChatMessage } from "../src/llm";
import { modelContractSchema } from "../../shared/meal-parse";
import { zodToResponseSchema } from "../src/response-schema";

const KEY = "gemini-key-never-send-me-anywhere";
const SCHEMA = zodToResponseSchema(modelContractSchema);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function okReply(text = '{"items":[]}', overrides: Record<string, unknown> = {}): unknown {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40 },
    modelVersion: "gemini-3.8-flash-001",
    ...overrides,
  };
}

function capture(response: Response | (() => never)) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (typeof response === "function") return response();
    return response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function bodyOf(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

describe("toGeminiPayload", () => {
  it("moves the system message into systemInstruction and leaves it out of contents", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "you are a nutrition estimator" },
      { role: "user", content: "two eggs" },
    ];
    const payload = toGeminiPayload(messages);

    expect(payload.systemInstruction).toEqual({
      parts: [{ text: "you are a nutrition estimator" }],
    });
    expect(payload.contents).toEqual([{ role: "user", parts: [{ text: "two eggs" }] }]);
  });

  it("calls the assistant role model, which is Gemini's name for it", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "two eggs" },
      { role: "assistant", content: "not json" },
      { role: "user", content: "try again" },
    ];
    expect(toGeminiPayload(messages).contents.map((content) => content.role)).toEqual([
      "user",
      "model",
      "user",
    ]);
  });

  it("encodes an image part as inline_data with the base64 payload", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", base64: "QUJD", mimeType: "image/jpeg" },
        ],
      },
    ];
    expect(toGeminiPayload(messages).contents[0]?.parts).toEqual([
      { text: "what is this" },
      { inline_data: { mime_type: "image/jpeg", data: "QUJD" } },
    ]);
  });

  it("omits systemInstruction entirely when there is no system message", () => {
    expect(toGeminiPayload([{ role: "user", content: "x" }]).systemInstruction).toBeUndefined();
  });
});

describe("createGeminiClient", () => {
  it("posts to generateContent for the requested model, with the key in a header", async () => {
    const { calls, fetchImpl } = capture(jsonResponse(okReply()));
    await createGeminiClient({ apiKey: KEY, fetchImpl }).complete({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "two eggs" }],
      maxTokens: 100,
      responseSchema: SCHEMA,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    );
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe(KEY);
    // Not in the query string, where it would end up in logs and referrers.
    expect(calls[0]?.url).not.toContain(KEY);
    expect(calls[0]?.init.body).not.toContain(KEY);
  });

  it("asks for structured output and sends the schema", async () => {
    const { calls, fetchImpl } = capture(jsonResponse(okReply()));
    await createGeminiClient({ apiKey: KEY, fetchImpl }).complete({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 2048,
      responseSchema: SCHEMA,
    });

    const config = bodyOf(calls[0]!)["generationConfig"] as Record<string, unknown>;
    expect(config["responseMimeType"]).toBe("application/json");
    // toEqual, not toBe: the assertion reads back a parsed copy of the body.
    expect(config["responseSchema"]).toEqual(responseSchemaFor(SCHEMA));
    expect(config["maxOutputTokens"]).toBe(2048);
    // Nutrition estimates should not be creative.
    expect(config["temperature"]).toBe(0.2);
    expect(config).not.toHaveProperty("thinkingConfig");
  });

  it("returns the content, the model that answered and the token usage", async () => {
    const { fetchImpl } = capture(jsonResponse(okReply('{"items":[]}')));
    const completion = await createGeminiClient({ apiKey: KEY, fetchImpl }).complete({
      model: "gemini-3.8-flash",
      messages: [],
      maxTokens: 10,
      responseSchema: SCHEMA,
    });

    expect(completion.content).toBe('{"items":[]}');
    expect(completion.model).toBe("gemini-3.8-flash-001");
    expect(completion.promptTokens).toBe(120);
    expect(completion.completionTokens).toBe(40);
    expect(completion.finishReason).toBe("STOP");
    expect(completion.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("joins a reply that arrived in several parts", async () => {
    const { fetchImpl } = capture(
      jsonResponse({
        candidates: [
          { content: { parts: [{ text: '{"items"' }, { text: ":[]}" }] }, finishReason: "STOP" },
        ],
      }),
    );
    const completion = await createGeminiClient({ apiKey: KEY, fetchImpl }).complete({
      model: "m",
      messages: [],
      maxTokens: 10,
      responseSchema: SCHEMA,
    });
    expect(completion.content).toBe('{"items":[]}');
  });

  it("reports an empty reply as empty content with the reason it was empty", async () => {
    // A blocked prompt produces no candidates at all. This is the case that keeps
    // the not-JSON retry branch alive, so it is worth pinning down.
    const { fetchImpl } = capture(jsonResponse({ promptFeedback: { blockReason: "SAFETY" } }));
    const completion = await createGeminiClient({ apiKey: KEY, fetchImpl }).complete({
      model: "m",
      messages: [],
      maxTokens: 10,
      responseSchema: SCHEMA,
    });

    expect(completion.content).toBe("");
    expect(completion.finishReason).toBe("SAFETY");
    expect(completion.promptTokens).toBeNull();
  });

  it("reports a truncated reply as empty content with MAX_TOKENS", async () => {
    const { fetchImpl } = capture(
      jsonResponse({ candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] }),
    );
    const completion = await createGeminiClient({ apiKey: KEY, fetchImpl }).complete({
      model: "m",
      messages: [],
      maxTokens: 10,
      responseSchema: SCHEMA,
    });
    expect(completion.content).toBe("");
    expect(completion.finishReason).toBe("MAX_TOKENS");
  });

  it("honours a custom base URL", async () => {
    const { calls, fetchImpl } = capture(jsonResponse(okReply()));
    await createGeminiClient({
      apiKey: KEY,
      baseUrl: "https://proxy.example.com",
      fetchImpl,
    }).complete({
      model: "m",
      messages: [],
      maxTokens: 10,
      responseSchema: SCHEMA,
    });
    expect(calls[0]?.url).toBe("https://proxy.example.com/v1beta/models/m:generateContent");
  });

  it("treats a throttled upstream as transient and says when to retry", async () => {
    const { fetchImpl } = capture(jsonResponse({ error: { message: "quota exceeded" } }, 429));
    const error = await createGeminiClient({ apiKey: KEY, fetchImpl })
      .complete({ model: "m", messages: [], maxTokens: 10, responseSchema: SCHEMA })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    // 503, not 502: Google being busy is a wait-and-retry, not a broken service.
    expect((error as ApiError).status).toBe(503);
    expect((error as ApiError).code).toBe("upstream_error");
    expect((error as ApiError).headers["Retry-After"]).toBe("30");
    expect((error as ApiError).details).toMatchObject({ status: 429 });
  });

  it.each([429, 503])("offers a Retry-After for upstream status %i", async (status) => {
    const { fetchImpl } = capture(jsonResponse({ error: { message: "slow down" } }, status));
    const error = await createGeminiClient({ apiKey: KEY, fetchImpl })
      .complete({ model: "m", messages: [], maxTokens: 10, responseSchema: SCHEMA })
      .catch((caught: unknown) => caught);
    expect((error as ApiError).headers["Retry-After"]).toBeDefined();
  });

  it("says something a person can act on, and names no provider and no status code", async () => {
    // Every message from this file reaches a phone screen verbatim. `Gemini returned
    // HTTP 429.` is true, and useless; worse, it invites a retry loop the user cannot
    // win. The status and the body still travel in `details`, where the logs are.
    const { fetchImpl } = capture(jsonResponse({ error: { message: "quota" } }, 429));
    const error = await createGeminiClient({ apiKey: KEY, fetchImpl })
      .complete({ model: "m", messages: [], maxTokens: 10, responseSchema: SCHEMA })
      .catch((caught: unknown) => caught);

    const message = (error as ApiError).message;
    expect(message).not.toMatch(/gemini/i);
    expect(message).not.toMatch(/\b\d{3}\b/);
    expect(message).toContain("try again");
    expect((error as ApiError).details).toMatchObject({ status: 429 });
  });

  it("calls an upstream key or server fault unavailable, not the user's fault", async () => {
    const { fetchImpl } = capture(jsonResponse({ error: { message: "bad key" } }, 403));
    const error = await createGeminiClient({ apiKey: KEY, fetchImpl })
      .complete({ model: "m", messages: [], maxTokens: 10, responseSchema: SCHEMA })
      .catch((caught: unknown) => caught);

    expect((error as ApiError).status).toBe(502);
    // No Retry-After: waiting a minute will not fix a key.
    expect((error as ApiError).headers["Retry-After"]).toBeUndefined();
    expect((error as ApiError).message).toContain("Your photo is still here");
  });

  it.each([
    ["a body that is not JSON", new Response("<html>gateway</html>", { status: 200 })],
    ["a shape we do not recognise", jsonResponse({ candidates: "not an array" })],
  ])("rejects %s as an upstream error", async (_label, response) => {
    const { fetchImpl } = capture(response);
    const error = await createGeminiClient({ apiKey: KEY, fetchImpl })
      .complete({ model: "m", messages: [], maxTokens: 10, responseSchema: SCHEMA })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
  });

  it("turns a transport failure into an upstream error rather than letting it escape", async () => {
    const failing = vi.fn(() => Promise.reject(new Error("socket hang up")));
    const error = await createGeminiClient({
      apiKey: KEY,
      fetchImpl: failing as unknown as typeof fetch,
    })
      .complete({ model: "m", messages: [], maxTokens: 10, responseSchema: SCHEMA })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(503);
    // The distinction that matters to the reader: checking your connection is worth
    // doing when the request never arrived, and not when Google was simply slow.
    expect((error as ApiError).details).toMatchObject({ timedOut: false });
    expect((error as ApiError).message).toContain("Check your connection");
  });

  it("describes its own timeout as slowness, not as the user's connection", async () => {
    const timedOut = vi.fn(() => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      return Promise.reject(error);
    });
    const error = await createGeminiClient({
      apiKey: KEY,
      timeoutMs: 60_000,
      fetchImpl: timedOut as unknown as typeof fetch,
    })
      .complete({ model: "m", messages: [], maxTokens: 10, responseSchema: SCHEMA })
      .catch((caught: unknown) => caught);

    expect((error as ApiError).status).toBe(503);
    expect((error as ApiError).details).toMatchObject({ timedOut: true, timeoutMs: 60_000 });
    expect((error as ApiError).message).not.toContain("Check your connection");
  });

  it("truncates a large upstream body instead of echoing it into a log", async () => {
    const huge = jsonResponse({ error: { message: "x".repeat(5000) } }, 500);
    const error = await createGeminiClient({ apiKey: KEY, fetchImpl: capture(huge).fetchImpl })
      .complete({ model: "m", messages: [], maxTokens: 10, responseSchema: SCHEMA })
      .catch((caught: unknown) => caught);

    const details = (error as ApiError).details as { body: string };
    expect(details.body.length).toBeLessThanOrEqual(500);
  });
});
