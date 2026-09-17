/**
 * The HTTP contract, exercised end to end through Express with every collaborator
 * faked. No Supabase project, no model provider, and — asserted explicitly — no
 * network at all, so the suite cannot spend a token even by accident.
 */
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { VerifiedUser } from "../src/auth";
import type { CallerStore, LlmCallRecord } from "../src/caller-store";
import type { Config } from "../src/config";
import { ApiError } from "../src/errors";
import type { GmailDraftClient } from "../src/gmail";
import type { CompletionRequest, LlmClient } from "../src/llm";
import { MAX_LLM_CALLS_PER_DAY, RETRY_INSTRUCTION_NOT_JSON } from "../src/parse-meal";
import { SUBJECT } from "../../shared/invite-email";

const USER: VerifiedUser = { id: "user-1", email: "aman@example.com" };
const TOKEN = "a-valid-access-token";
const NOW = new Date("2026-03-02T12:00:00Z");
const EATEN_AT = "2026-03-02T12:05:00.000Z";

const CONFIG: Config = {
  NODE_ENV: "test",
  PORT: 8787,
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  GEMINI_API_KEY: "gemini-example",
  GEMINI_VISION_MODEL: "gemini-3.8-flash",
  ALLOWED_ORIGINS: ["http://localhost:8080"],
};

/** Macros agree with the calories: 4*10 + 4*54 + 9*6 = 310 against a claimed 300. */
const GOOD_ITEM = {
  name: "Oatmeal with banana",
  quantity: 1,
  unit: "bowl",
  grams: 250,
  calories: 300,
  protein_g: 10,
  carbs_g: 54,
  fat_g: 6,
  fiber_g: 8,
  sugar_g: 12,
  sodium_mg: 150,
  confidence: 0.8,
};

const goodReply = JSON.stringify({ items: [GOOD_ITEM] });

interface HarnessOptions {
  /** Model replies, consumed in order; the last one repeats. */
  replies?: string[];
  /**
   * Finish reasons, consumed in order alongside `replies`. Defaults to SAFETY for an
   * empty reply and STOP otherwise, which is what the real client does.
   */
  finishReasons?: string[];
  usedToday?: number;
  timeZone?: string;
  /** null makes the verifier reject the token. */
  user?: VerifiedUser | null;
  recordThrows?: boolean;
  /** What `is_admin()` would answer for this caller. */
  isAdmin?: boolean;
  /** What the invite list already holds for the address being invited. */
  alreadyInvited?: boolean;
  /** Makes the insert into allowed_emails fail, as a policy refusal would. */
  addEmailThrows?: boolean;
  /** Makes the Gmail draft fail, as a revoked refresh token would. */
  draftThrows?: boolean;
  /** Overrides for the invite feature's configuration. */
  gmail?: GmailDraftClient | null;
  inviteSender?: string | null;
  /** Makes the model client fail the way an unreachable upstream does. */
  llmThrows?: boolean;
  body?: unknown;
}

function buildHarness(options: HarnessOptions = {}) {
  const completions: CompletionRequest[] = [];
  const recorded: LlmCallRecord[] = [];
  const addedEmails: string[] = [];
  const checkedEmails: string[] = [];
  const draftedMime: string[] = [];
  /** The order the two halves of an invite happened in. */
  const order: string[] = [];
  const countedSince: Date[] = [];
  const loadedPaths: string[][] = [];
  const verifiedTokens: string[] = [];
  const replies = options.replies ?? [goodReply];
  let replyIndex = 0;

  const llm: LlmClient = {
    async complete(completionRequest) {
      completions.push(completionRequest);
      if (options.llmThrows) {
        throw new ApiError(502, "upstream_error", "Gemini is unreachable");
      }
      const reply = replies[Math.min(replyIndex, replies.length - 1)] ?? "";
      const reason =
        options.finishReasons?.[Math.min(replyIndex, options.finishReasons.length - 1)];
      replyIndex += 1;
      return {
        content: reply,
        model: completionRequest.model,
        promptTokens: 11,
        completionTokens: 22,
        latencyMs: 3,
        finishReason: reason ?? (reply === "" ? "SAFETY" : "STOP"),
      };
    },
  };

  const store: CallerStore = {
    async countCallsSince(since) {
      countedSince.push(since);
      return options.usedToday ?? 0;
    },
    async recordCall(record) {
      if (options.recordThrows) throw new ApiError(502, "upstream_error", "telemetry is down");
      recorded.push(record);
    },
    async timeZone() {
      return options.timeZone ?? "UTC";
    },
    async loadPhotos(paths) {
      loadedPaths.push([...paths]);
      return paths.map(() => ({ base64: "QUJD", mimeType: "image/jpeg" }));
    },
    async isAdmin() {
      return options.isAdmin ?? false;
    },
    async hasAllowedEmail(email) {
      checkedEmails.push(email);
      return options.alreadyInvited ?? false;
    },
    async addAllowedEmail(email) {
      order.push("insert");
      addedEmails.push(email);
      if (options.addEmailThrows) {
        throw new ApiError(502, "upstream_error", "Could not add that address to the invite list.");
      }
    },
  };

  const gmail: GmailDraftClient | null =
    options.gmail === undefined
      ? {
          async createDraft(mime) {
            order.push("draft");
            draftedMime.push(mime.toString("utf8"));
            if (options.draftThrows) {
              throw new ApiError(502, "upstream_error", "Could not create the draft in Gmail.");
            }
            return "draft-1";
          },
        }
      : options.gmail;

  const app = createApp({
    config: CONFIG,
    llm,
    async verifyToken(token) {
      verifiedTokens.push(token);
      if (options.user === null)
        throw new ApiError(401, "unauthorized", "Invalid or expired access token.");
      return options.user ?? USER;
    },
    forCaller: () => store,
    gmail,
    inviteSender: options.inviteSender === undefined ? "aman@example.com" : options.inviteSender,
    now: () => NOW,
  });

  return {
    app,
    completions,
    recorded,
    countedSince,
    loadedPaths,
    verifiedTokens,
    addedEmails,
    checkedEmails,
    draftedMime,
    order,
  };
}

describe("POST /invite", () => {
  const body = { email: "Priya@Example.com", firstName: "  Priya  " };

  it("refuses a caller who is not an admin, and does nothing at all", async () => {
    const { app, addedEmails, draftedMime } = buildHarness({ isAdmin: false });

    const response = await request(app)
      .post("/invite")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send(body);

    expect(response.status).toBe(403);
    // The point of the test: hiding the button in the UI is not the check. Neither half ran.
    expect(addedEmails).toEqual([]);
    expect(draftedMime).toEqual([]);
  });

  it("drafts the email before adding the address, so a failure cannot grant access", async () => {
    const { app, order, addedEmails } = buildHarness({ isAdmin: true });

    const response = await request(app)
      .post("/invite")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send(body);

    expect(response.status).toBe(200);
    expect(order).toEqual(["draft", "insert"]);
    // Normalised, because allowed_emails stores lower(trim(...)) and an invite stored any other
    // way is one that looks added and can never match.
    expect(addedEmails).toEqual(["priya@example.com"]);
    expect(response.body).toEqual({
      email: "priya@example.com",
      firstName: "Priya",
      draftId: "draft-1",
      alreadyInvited: false,
    });
  });

  it("leaves the address off the list when the draft fails", async () => {
    const { app, addedEmails, order } = buildHarness({ isAdmin: true, draftThrows: true });

    const response = await request(app)
      .post("/invite")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send(body);

    expect(response.status).toBe(502);
    expect(order).toEqual(["draft"]);
    expect(addedEmails).toEqual([]);
  });

  it("uses the shared invite body, not a second copy of it", async () => {
    const { app, draftedMime } = buildHarness({ isAdmin: true });

    await request(app).post("/invite").set("Authorization", `Bearer ${TOKEN}`).send(body);

    const mime = draftedMime[0] ?? "";
    expect(mime).toContain(SUBJECT);
    expect(mime).toContain("priya@example.com");
    expect(mime).toContain("multipart/alternative");
  });

  it("rejects a body that is not an email address", async () => {
    const { app, addedEmails, draftedMime } = buildHarness({ isAdmin: true });

    const response = await request(app)
      .post("/invite")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ email: "priya at example.com", firstName: "Priya" });

    expect(response.status).toBe(400);
    expect(addedEmails).toEqual([]);
    expect(draftedMime).toEqual([]);
  });

  it("says the feature is not set up rather than half-working", async () => {
    const { app, addedEmails, draftedMime } = buildHarness({
      isAdmin: true,
      gmail: null,
      inviteSender: null,
    });

    const response = await request(app)
      .post("/invite")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send(body);

    expect(response.status).toBe(503);
    expect(addedEmails).toEqual([]);
    expect(draftedMime).toEqual([]);
  });
});

const post = (app: ReturnType<typeof createApp>, body: unknown, token: string | null = TOKEN) => {
  const agent = request(app).post("/parse-meal");
  if (token !== null) agent.set("Authorization", `Bearer ${token}`);
  return agent.send(body as object);
};

const TYPED_MEAL = { source: "text", text: "oatmeal with a banana", eatenAt: EATEN_AT };
const PHOTO_MEAL = {
  source: "photo",
  photoPaths: [`${USER.id}/capture-1/0.jpg`],
  eatenAt: EATEN_AT,
};

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // If any code path reaches for the network, this fails the test rather than
  // silently spending money.
  fetchSpy = vi.fn(() => Promise.reject(new Error("the test suite must not touch the network")));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /health", () => {
  it("answers for Render's health check", async () => {
    const { app } = buildHarness();
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it("404s anything else", async () => {
    const { app } = buildHarness();
    const response = await request(app).get("/nope");
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("invalid_request");
  });
});

describe("CORS", () => {
  it("allows an origin from ALLOWED_ORIGINS", async () => {
    const { app } = buildHarness();
    const response = await request(app).get("/health").set("Origin", "http://localhost:8080");
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:8080");
  });

  it("refuses any other origin", async () => {
    const { app } = buildHarness();
    const response = await request(app).get("/health").set("Origin", "https://evil.example.com");
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("forbidden");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers a preflight without needing a token", async () => {
    const { app } = buildHarness();
    const response = await request(app)
      .options("/parse-meal")
      .set("Origin", "http://localhost:8080")
      .set("Access-Control-Request-Method", "POST");
    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-headers"]).toContain("Authorization");
  });

  it("allows a request with no Origin header, such as curl", async () => {
    const { app } = buildHarness();
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
  });
});

describe("authentication", () => {
  it("rejects a request with no Authorization header", async () => {
    const { app, completions } = buildHarness();
    const response = await post(app, TYPED_MEAL, null);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("unauthorized");
    expect(completions).toHaveLength(0);
  });

  it.each([["Token abc"], ["Bearer"], ["Basic abc"]])("rejects the header %s", async (header) => {
    const { app } = buildHarness();
    const response = await request(app)
      .post("/parse-meal")
      .set("Authorization", header)
      .send(TYPED_MEAL);
    expect(response.status).toBe(401);
  });

  it("rejects a token the verifier does not accept", async () => {
    const { app, completions } = buildHarness({ user: null });
    const response = await post(app, TYPED_MEAL);
    expect(response.status).toBe(401);
    expect(completions).toHaveLength(0);
  });

  it("verifies the token from the header and passes the user id down", async () => {
    const { app, verifiedTokens } = buildHarness();
    const response = await post(app, TYPED_MEAL);
    expect(response.status).toBe(200);
    expect(verifiedTokens).toEqual([TOKEN]);
  });
});

describe("request validation", () => {
  it("rejects a body with neither text nor photos, naming the field", async () => {
    const { app, completions } = buildHarness();
    const response = await post(app, { source: "text", eatenAt: EATEN_AT });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
    expect(response.body.error.details[0].path).toBe("text");
    expect(completions).toHaveLength(0);
  });

  it("rejects source: photo with no photos", async () => {
    const { app } = buildHarness();
    const response = await post(app, { source: "photo", eatenAt: EATEN_AT });
    expect(response.status).toBe(400);
    expect(response.body.error.details.some((d: { path: string }) => d.path === "photoPaths")).toBe(
      true,
    );
  });

  it("rejects more than three photos", async () => {
    const { app } = buildHarness();
    const response = await post(app, {
      source: "photo",
      photoPaths: ["a/1.jpg", "a/2.jpg", "a/3.jpg", "a/4.jpg"].map((p) => `${USER.id}/${p}`),
      eatenAt: EATEN_AT,
    });
    expect(response.status).toBe(400);
  });

  it("rejects eatenAt without an offset", async () => {
    const { app } = buildHarness();
    const response = await post(app, { ...TYPED_MEAL, eatenAt: "2026-03-02T12:05:00" });
    expect(response.status).toBe(400);
  });

  it("rejects an unknown meal type", async () => {
    const { app } = buildHarness();
    const response = await post(app, { ...TYPED_MEAL, mealType: "brunch" });
    expect(response.status).toBe(400);
  });

  it("refuses a photo path belonging to someone else", async () => {
    const { app, completions, loadedPaths } = buildHarness();
    const response = await post(app, {
      source: "photo",
      photoPaths: ["someone-else/capture-1/0.jpg"],
      eatenAt: EATEN_AT,
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("forbidden");
    expect(completions).toHaveLength(0);
    expect(loadedPaths).toHaveLength(0);
  });

  it("refuses a path that tries to climb out of the bucket", async () => {
    const { app } = buildHarness();
    const response = await post(app, {
      source: "photo",
      photoPaths: [`${USER.id}/../other/0.jpg`],
      eatenAt: EATEN_AT,
    });
    expect(response.status).toBe(403);
  });
});

describe("a successful parse", () => {
  it("returns normalised items and the meal type guessed from the profile's clock", async () => {
    const { app } = buildHarness();
    const response = await post(app, TYPED_MEAL);

    expect(response.status).toBe(200);
    expect(response.body.attempts).toBe(1);
    expect(response.body.meal_type).toBe("lunch");
    expect(response.body.source).toBe("text");
    expect(response.body.model).toBe("gemini-3.8-flash");
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({
      name: "Oatmeal with banana",
      calories: 300,
      needs_review: false,
      review_reasons: [],
    });
  });

  it("honours a meal type the client already decided", async () => {
    const { app } = buildHarness();
    const response = await post(app, { ...TYPED_MEAL, mealType: "breakfast" });
    expect(response.body.meal_type).toBe("breakfast");
  });

  it("describes the job in the prompt and the shape in the response schema", async () => {
    const { app, completions } = buildHarness();
    await post(app, { ...TYPED_MEAL, hint: "it was a small bowl" });

    const messages = completions[0]?.messages ?? [];
    expect(messages[0]?.role).toBe("system");
    expect(String(messages[0]?.content)).toContain("nutrition estimator");
    // The field list lives in the response schema, not in the prompt, so there is no
    // second copy of the contract to drift from the first.
    expect(String(messages[0]?.content)).not.toContain("protein_g");
    expect(completions[0]?.responseSchema).toMatchObject({
      type: "object",
      required: ["items"],
    });

    const userMessage = messages[1];
    expect(userMessage?.role).toBe("user");
    expect(String(userMessage?.content)).toContain("oatmeal with a banana");
    expect(String(userMessage?.content)).toContain("it was a small bowl");
  });

  it("does not call the model twice when the first reply is good", async () => {
    const { app, completions, recorded } = buildHarness();
    await post(app, TYPED_MEAL);
    expect(completions).toHaveLength(1);
    expect(recorded).toEqual([
      {
        model: "gemini-3.8-flash",
        promptTokens: 11,
        completionTokens: 22,
        latencyMs: 3,
        status: "ok",
      },
    ]);
  });

  it("returns an empty list when the model finds nothing, rather than failing", async () => {
    const { app } = buildHarness({ replies: [JSON.stringify({ items: [] })] });
    const response = await post(app, { ...TYPED_MEAL, text: "a glass of water" });
    expect(response.status).toBe(200);
    expect(response.body.items).toEqual([]);
  });

  it("flags an item whose macros disagree with its calories", async () => {
    const mismatched = { ...GOOD_ITEM, calories: 900, protein_g: 1, carbs_g: 1, fat_g: 1 };
    const { app } = buildHarness({ replies: [JSON.stringify({ items: [mismatched] })] });
    const response = await post(app, TYPED_MEAL);

    expect(response.status).toBe(200);
    expect(response.body.items[0].needs_review).toBe(true);
    expect(response.body.items[0].review_reasons[0]).toContain("Calories do not match");
  });
});

describe("photos", () => {
  it("sends the images as raw bytes, which the provider encodes", async () => {
    const { app, completions, loadedPaths } = buildHarness();
    const response = await post(app, PHOTO_MEAL);

    expect(response.status).toBe(200);
    expect(loadedPaths).toEqual([[`${USER.id}/capture-1/0.jpg`]]);

    const content = completions[0]?.messages[1]?.content;
    expect(Array.isArray(content)).toBe(true);
    // Not a data URL: the provider decides the wire encoding, so nothing above this
    // layer has to know that Gemini wants inline_data.
    expect(content).toContainEqual({ type: "image", base64: "QUJD", mimeType: "image/jpeg" });
  });

  it("uses the same multimodal model as a text-only meal", async () => {
    const { app } = buildHarness();
    const response = await post(app, PHOTO_MEAL);
    expect(response.body.model).toBe("gemini-3.8-flash");
  });

  it("sends a caption alongside the photos when there is one", async () => {
    const { app, completions } = buildHarness();
    await post(app, { ...PHOTO_MEAL, text: "half of it was rice" });
    const content = completions[0]?.messages[1]?.content;
    expect(Array.isArray(content) ? content[0] : null).toMatchObject({
      type: "text",
      text: expect.stringContaining("half of it was rice"),
    });
  });

  it("does not read photos when the rate limit is already reached", async () => {
    const { app, loadedPaths } = buildHarness({ usedToday: MAX_LLM_CALLS_PER_DAY });
    await post(app, PHOTO_MEAL);
    expect(loadedPaths).toHaveLength(0);
  });
});

describe("the rate limit", () => {
  it("counts calls since the start of the local day", async () => {
    const { app, countedSince } = buildHarness({ timeZone: "America/New_York" });
    await post(app, TYPED_MEAL);
    // NOW is 12:00Z on 2 March, which is 07:00 in New York, so the window opened at
    // 00:00 EST that morning: 05:00Z.
    expect(countedSince[0]?.toISOString()).toBe("2026-03-02T05:00:00.000Z");
  });

  it("refuses the call once the day's allowance is used, and says when to retry", async () => {
    const { app, completions, recorded } = buildHarness({ usedToday: MAX_LLM_CALLS_PER_DAY });
    const response = await post(app, TYPED_MEAL);

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe("rate_limited");
    expect(response.body.error.details).toMatchObject({ limit: MAX_LLM_CALLS_PER_DAY, used: 60 });
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
    expect(completions).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("still allows the last call within the allowance", async () => {
    const { app } = buildHarness({ usedToday: MAX_LLM_CALLS_PER_DAY - 1 });
    const response = await post(app, TYPED_MEAL);
    expect(response.status).toBe(200);
  });
});

describe("the single retry", () => {
  it("retries prose with the exact instruction, then succeeds", async () => {
    const { app, completions, recorded } = buildHarness({
      replies: ["Sure! Here is the JSON you asked for.", goodReply],
    });
    const response = await post(app, TYPED_MEAL);

    expect(response.status).toBe(200);
    expect(response.body.attempts).toBe(2);
    expect(completions).toHaveLength(2);
    expect(completions[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: RETRY_INSTRUCTION_NOT_JSON,
    });
    expect(recorded.map((row) => row.status)).toEqual(["invalid_json", "ok"]);
  });

  it("echoes the bad reply back so the instruction has a referent", async () => {
    const bad = "I think it is oatmeal.";
    const { app, completions } = buildHarness({ replies: [bad, goodReply] });
    await post(app, TYPED_MEAL);
    expect(completions[1]?.messages.at(-2)).toEqual({ role: "assistant", content: bad });
  });

  it("names the offending field when the JSON was valid but the shape was not", async () => {
    const { app, completions, recorded } = buildHarness({
      replies: [JSON.stringify({ items: [{ calories: 100 }] }), goodReply],
    });
    const response = await post(app, TYPED_MEAL);

    expect(response.status).toBe(200);
    const instruction = completions[1]?.messages.at(-1)?.content;
    expect(String(instruction)).toContain("did not match the required schema");
    expect(String(instruction)).toContain("items.0.name");
    expect(recorded.map((row) => row.status)).toEqual(["invalid_schema", "ok"]);
  });

  it("gives up after exactly one retry", async () => {
    const { app, completions, recorded } = buildHarness({
      replies: ["not json", "still not json"],
    });
    const response = await post(app, TYPED_MEAL);

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("unparseable_response");
    expect(completions).toHaveLength(2);
    expect(recorded.map((row) => row.status)).toEqual(["invalid_json", "invalid_json"]);
  });

  it("does not retry a transport failure, which is not the model's fault", async () => {
    const { app, completions, recorded } = buildHarness({ llmThrows: true });
    const response = await post(app, TYPED_MEAL);

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("upstream_error");
    // One attempt, not two: retrying a dead socket just doubles the wait.
    expect(completions).toHaveLength(1);
    expect(recorded.map((row) => row.status)).toEqual(["error"]);
  });
});

describe("a model that declines", () => {
  /** SAFETY with no content: Gemini refused and returned no candidates. */
  const declined = [""];

  it("does not spend a second call on a refusal", async () => {
    const { app, completions, recorded } = buildHarness({ replies: declined });
    const response = await post(app, TYPED_MEAL);

    // One attempt. The old behaviour retried, which cost the user a second call out
    // of their sixty and could not have produced a different answer.
    expect(completions).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("unparseable_response");
    expect(response.body.error.details.reason).toBe("refusal");
    expect(response.body.error.details.finishReason).toBe("SAFETY");
  });

  it("says the reader declined, and does not advise a note that would also be refused", async () => {
    const { app } = buildHarness({ replies: declined });
    const response = await post(app, TYPED_MEAL);
    const message: string = response.body.error.message;

    expect(message).toContain("declined");
    expect(message).toContain("type what you ate");
    // The old wording sent the user round a loop that cannot terminate: the note would
    // be refused for the same reason the photo was.
    expect(message).not.toContain("short note");
  });

  it("still retries an empty reply that was truncated rather than refused", async () => {
    // MAX_TOKENS is a bad answer, not a refusal, and a second attempt is worth trying.
    const { app, completions } = buildHarness({
      replies: ["", goodReply],
      finishReasons: ["MAX_TOKENS", "STOP"],
    });
    const response = await post(app, TYPED_MEAL);

    expect(response.status).toBe(200);
    expect(completions).toHaveLength(2);
  });

  it("prefers the refusal wording when it is the retry that is refused", async () => {
    const { app, completions } = buildHarness({
      replies: ["not json", ""],
      finishReasons: ["STOP", "SAFETY"],
    });
    const response = await post(app, TYPED_MEAL);

    expect(completions).toHaveLength(2);
    expect(response.body.error.details.reason).toBe("refusal");
    expect(response.body.error.message).toContain("declined");
    expect(response.body.error.message).not.toContain("short note");
  });

  it("still offers the ordinary advice when a retry simply produced junk", async () => {
    const { app } = buildHarness({ replies: ["not json", "still not json"] });
    const response = await post(app, TYPED_MEAL);

    expect(response.body.error.message).toContain("short note");
    expect(response.body.error.message).not.toContain("declined");
  });
});

describe("telemetry failures", () => {
  it("still returns the meal when logging the call fails", async () => {
    const { app } = buildHarness({ recordThrows: true });
    const response = await post(app, TYPED_MEAL);
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
  });
});

describe("the network", () => {
  it("is never touched by any request in this suite", async () => {
    const { app } = buildHarness();
    await post(app, TYPED_MEAL);
    await post(app, PHOTO_MEAL);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
