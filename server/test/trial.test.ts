/**
 * The trial: the scan refusals, the client IP read, the store over a fake client,
 * and the in-memory parse.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "../src/config";
import { ApiError } from "../src/errors";
import type { CompletionRequest, LlmClient } from "../src/llm";
import {
  clientIp,
  createTrialStore,
  parseTrialMeal,
  trialScanError,
  type TrialStore,
} from "../src/trial";

const CONFIG = {
  NODE_ENV: "test",
  PORT: 8787,
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  GEMINI_API_KEY: "gemini-example",
  GEMINI_VISION_MODEL: "gemini-3.8-flash",
  ALLOWED_ORIGINS: ["http://localhost:8080"],
  DAILY_ANALYSIS_LIMIT: 20,
  ADMIN_DAILY_ANALYSIS_LIMIT: 60,
  TRIAL_SERVER_SECRET: "trial-server-secret-example",
} satisfies Config;

const goodReply = JSON.stringify({
  items: [{ name: "Dal tadka", calories: 200, protein_g: 10, carbs_g: 20, fat_g: 10 }],
});

function fakeLlm(): LlmClient {
  return {
    async complete(request: CompletionRequest) {
      return {
        content: goodReply,
        model: request.model,
        promptTokens: 11,
        completionTokens: 22,
        latencyMs: 3,
        finishReason: "STOP",
      };
    },
  };
}

describe("trialScanError", () => {
  it("turns no scans left into the exhausted sentence, using the database's own total", () => {
    const error = trialScanError({ status: "no_scans_left", scans_left: 0, scans_total: 10 });
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(403);
    expect(error.code).toBe("trial_exhausted");
    expect(error.message).toBe("You've used your 10 free scans. Join to keep tracking.");
  });

  it("turns the global budget into a busy sentence", () => {
    const error = trialScanError({ status: "busy", scans_left: 7 });
    expect(error.status).toBe(429);
    expect(error.code).toBe("trial_busy");
    expect(error.message).toBe("Trial is busy today. Request an invite instead.");
  });

  it("turns the per-IP ceiling into a busy sentence too", () => {
    const error = trialScanError({ status: "rate_limited", scans_left: 7 });
    expect(error.status).toBe(429);
    expect(error.code).toBe("trial_busy");
  });
});

describe("clientIp", () => {
  it("prefers cf-connecting-ip", () => {
    expect(clientIp({ "cf-connecting-ip": "203.0.113.7" })).toBe("203.0.113.7");
  });

  it("falls back to the first hop of x-forwarded-for", () => {
    expect(clientIp({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" })).toBe("198.51.100.1");
  });

  it("falls back to the socket address, and to null when nothing is there", () => {
    expect(clientIp({}, "192.0.2.9")).toBe("192.0.2.9");
    expect(clientIp({})).toBeNull();
  });
});

describe("parseTrialMeal", () => {
  const base = {
    email: "trial@example.com",
    version: 0,
    ip: "203.0.113.7",
    text: "dal and rice",
    photos: [],
    mealType: null as null,
    eatenAt: new Date("2026-03-02T12:05:00Z"),
  };

  it("consumes a scan and records the call against the reserved row", async () => {
    const started: Array<{ email: string; ip: string | null; version: number }> = [];
    const logged: Array<{ callId: string; model: string }> = [];
    const trial: TrialStore = {
      async sendCode() {
        return { status: "sent", code: "123456", email: "x@example.com", invited: false };
      },
      async verifyCode() {
        return "ok";
      },
      async startScan(email, ip, version) {
        started.push({ email, ip, version });
        return { status: "ok", scans_left: 9, scans_total: 10, call_id: "call-123" };
      },
      async logCall(callId, record) {
        logged.push({ callId, model: record.model });
      },
      async getScansLimit() {
        return 10;
      },
      async linkStatus() {
        return { status: "invalid", invited: false };
      },
    };

    const outcome = await parseTrialMeal(base, { config: CONFIG, llm: fakeLlm(), trial });
    expect(outcome.items).toHaveLength(1);
    expect(outcome.scans_left).toBe(9);
    expect(started).toEqual([{ email: "trial@example.com", ip: "203.0.113.7", version: 0 }]);
    // The reserved row's id is what the post-model record() fills in.
    expect(logged).toEqual([{ callId: "call-123", model: "gemini-3.8-flash" }]);
  });

  it("throws the exhausted error when the scan is refused", async () => {
    const trial: TrialStore = {
      async sendCode() {
        return { status: "sent", code: "123456", email: "x@example.com", invited: false };
      },
      async verifyCode() {
        return "ok";
      },
      async startScan() {
        return { status: "no_scans_left", scans_left: 0, scans_total: 10 };
      },
      async logCall() {},
      async getScansLimit() {
        return 10;
      },
      async linkStatus() {
        return { status: "invalid", invited: false };
      },
    };

    await expect(
      parseTrialMeal(base, { config: CONFIG, llm: fakeLlm(), trial }),
    ).rejects.toMatchObject({
      code: "trial_exhausted",
      status: 403,
    });
  });
});

describe("createTrialStore", () => {
  const SECRET = "trial-server-secret-example";

  function fakeClient(rpcResult: unknown): {
    client: SupabaseClient;
    rpc: ReturnType<typeof vi.fn>;
  } {
    const rpc = vi.fn(async () => ({ data: rpcResult, error: null }));
    return { client: { rpc } as unknown as SupabaseClient, rpc };
  }

  it("returns the code status verbatim, which is how expiry and the attempt limit reach the caller", async () => {
    const { client } = fakeClient("expired");
    const store = createTrialStore(client, SECRET);
    expect(await store.verifyCode("trial@example.com", "123456")).toBe("expired");

    const attempts = fakeClient("attempts_exceeded");
    expect(
      await createTrialStore(attempts.client, SECRET).verifyCode("trial@example.com", "123456"),
    ).toBe("attempts_exceeded");
  });

  it("passes the secret and the caller's fields to the database function", async () => {
    const { client, rpc } = fakeClient({ status: "ok", scans_left: 4 });
    const store = createTrialStore(client, SECRET);
    const result = await store.startScan("trial@example.com", "203.0.113.7", 2);
    expect(result).toEqual({ status: "ok", scans_left: 4 });
    expect(rpc).toHaveBeenCalledWith("trial_scan_start", {
      p_server_secret: SECRET,
      p_email: "trial@example.com",
      p_ip: "203.0.113.7",
      p_version: 2,
    });
  });

  it("records a call by the reserved row id, not by inserting", async () => {
    const { client, rpc } = fakeClient(null);
    const store = createTrialStore(client, SECRET);
    await store.logCall("call-123", {
      model: "gemini-3.8-flash",
      promptTokens: 11,
      completionTokens: 22,
      latencyMs: 3,
      status: "ok",
    });
    expect(rpc).toHaveBeenCalledWith("trial_log_call", {
      p_server_secret: SECRET,
      p_call_id: "call-123",
      p_model: "gemini-3.8-flash",
      p_prompt_tokens: 11,
      p_completion_tokens: 22,
      p_latency_ms: 3,
      p_status: "ok",
    });
  });

  it("turns a database failure into the shared message, not a leak", async () => {
    const failing = {
      rpc: vi.fn(async () => ({ data: null, error: { message: "permission denied" } })),
    } as unknown as SupabaseClient;
    const store = createTrialStore(failing, SECRET);
    await expect(store.verifyCode("trial@example.com", "123456")).rejects.toMatchObject({
      code: "upstream_error",
    });
  });

  it("reads the scan limit with the secret, which is how the page learns it", async () => {
    const { client, rpc } = fakeClient(10);
    const store = createTrialStore(client, SECRET);
    expect(await store.getScansLimit()).toBe(10);
    expect(rpc).toHaveBeenCalledWith("trial_scans_limit", { p_server_secret: SECRET });
  });
});
