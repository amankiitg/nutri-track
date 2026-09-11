/**
 * The real DeepSeek client, driven through an injected fetch. Asserting on the
 * outgoing request is the point: the request shape is where the two documented
 * gotchas live — thinking mode must be off, and the base64 image parts.
 */
import { describe, expect, it, vi } from "vitest";
import { createDeepSeekClient } from "../src/deepseek";
import { ApiError } from "../src/errors";

const KEY = "sk-test-key-never-send-me-anywhere";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function okCompletion(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "chat-1",
    model: "deepseek-chat",
    choices: [{ message: { role: "assistant", content: '{"items":[]}' }, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 40 },
    ...overrides,
  };
}

/** Captures what the client would have sent. */
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

describe("createDeepSeekClient", () => {
  it("posts to the chat completions endpoint with the key in the header only", async () => {
    const { calls, fetchImpl } = capture(jsonResponse(okCompletion()));
    await createDeepSeekClient({ apiKey: KEY, fetchImpl }).complete({
      model: "deepseek-chat",
      messages: [{ role: "user", content: "two eggs" }],
      maxTokens: 100,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.deepseek.com/chat/completions");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.init.body).not.toContain(KEY);
  });

  it("disables thinking mode, which is on by default and would eat the whole budget", async () => {
    const { calls, fetchImpl } = capture(jsonResponse(okCompletion()));
    await createDeepSeekClient({ apiKey: KEY, fetchImpl }).complete({
      model: "deepseek-v4-flash-vision-exp",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 2048,
    });

    const body = bodyOf(calls[0]!);
    expect(body["reasoning_effort"]).toBe("none");
    expect(body["max_tokens"]).toBe(2048);
    expect(body["stream"]).toBe(false);
    expect(body["model"]).toBe("deepseek-v4-flash-vision-exp");
    // Not documented for the configured models, so we do not rely on it.
    expect(body).not.toHaveProperty("response_format");
  });

  it("sends image parts as base64 data URLs", async () => {
    const { calls, fetchImpl } = capture(jsonResponse(okCompletion()));
    await createDeepSeekClient({ apiKey: KEY, fetchImpl }).complete({
      model: "vision",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
          ],
        },
      ],
      maxTokens: 100,
    });

    const messages = bodyOf(calls[0]!)["messages"] as Array<{ content: unknown }>;
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "what is this" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
    ]);
  });

  it("returns the content, the model that answered and the token usage", async () => {
    const { fetchImpl } = capture(
      jsonResponse(
        okCompletion({
          model: "deepseek-v4-pro",
          usage: { prompt_tokens: 7, completion_tokens: 9 },
        }),
      ),
    );
    const completion = await createDeepSeekClient({ apiKey: KEY, fetchImpl }).complete({
      model: "deepseek-chat",
      messages: [],
      maxTokens: 10,
    });

    expect(completion.content).toBe('{"items":[]}');
    expect(completion.model).toBe("deepseek-v4-pro");
    expect(completion.promptTokens).toBe(7);
    expect(completion.completionTokens).toBe(9);
    expect(completion.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("turns a null content into an empty string, so the caller retries instead of crashing", async () => {
    const { fetchImpl } = capture(
      jsonResponse({
        model: "m",
        choices: [{ message: { content: null }, finish_reason: "length" }],
      }),
    );
    const completion = await createDeepSeekClient({ apiKey: KEY, fetchImpl }).complete({
      model: "m",
      messages: [],
      maxTokens: 10,
    });
    expect(completion.content).toBe("");
    expect(completion.promptTokens).toBeNull();
  });

  it("honours a custom base URL", async () => {
    const { calls, fetchImpl } = capture(jsonResponse(okCompletion()));
    await createDeepSeekClient({
      apiKey: KEY,
      baseUrl: "https://proxy.example.com",
      fetchImpl,
    }).complete({
      model: "m",
      messages: [],
      maxTokens: 10,
    });
    expect(calls[0]?.url).toBe("https://proxy.example.com/chat/completions");
  });

  it("reports a non-2xx as a 502 with the upstream status, not as a 500", async () => {
    const { fetchImpl } = capture(jsonResponse({ error: { message: "rate limited" } }, 429));
    const error = await createDeepSeekClient({ apiKey: KEY, fetchImpl })
      .complete({ model: "m", messages: [], maxTokens: 10 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).code).toBe("upstream_error");
    expect((error as ApiError).details).toMatchObject({ status: 429 });
  });

  it.each([
    ["a body that is not JSON", new Response("<html>gateway</html>", { status: 200 })],
    ["a shape we do not recognise", jsonResponse({ choices: [] })],
    ["no choices at all", jsonResponse({ model: "m" })],
  ])("rejects %s as an upstream error", async (_label, response) => {
    const { fetchImpl } = capture(response);
    const error = await createDeepSeekClient({ apiKey: KEY, fetchImpl })
      .complete({ model: "m", messages: [], maxTokens: 10 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
  });

  it("turns a transport failure into a 502 rather than letting it escape", async () => {
    const failing = vi.fn(() => Promise.reject(new Error("socket hang up")));
    const error = await createDeepSeekClient({
      apiKey: KEY,
      fetchImpl: failing as unknown as typeof fetch,
    })
      .complete({ model: "m", messages: [], maxTokens: 10 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toContain("Could not reach DeepSeek");
  });

  it("truncates a large upstream body instead of echoing it into a log", async () => {
    const huge = jsonResponse({ error: { message: "x".repeat(5000) } }, 500);
    const error = await createDeepSeekClient({ apiKey: KEY, fetchImpl: capture(huge).fetchImpl })
      .complete({ model: "m", messages: [], maxTokens: 10 })
      .catch((caught: unknown) => caught);

    const details = (error as ApiError).details as { body: string };
    expect(details.body.length).toBeLessThanOrEqual(500);
  });
});
