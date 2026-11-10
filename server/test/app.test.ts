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
import { dailyLimitMessage, RETRY_INSTRUCTION_NOT_JSON } from "../src/parse-meal";
import type { EmailClient } from "../src/resend";
import type { TrialLinkStatus, TrialScanResult, TrialStore } from "../src/trial";
import { ADMIN_DAILY_ANALYSIS_LIMIT, DAILY_ANALYSIS_LIMIT } from "../../shared/meal-parse";
import { APPROVED_SUBJECT, SUBJECT, TRIAL_LINE } from "../../shared/invite-email";
import { signTrialToken, TRIAL_TOKEN_TTL_SECONDS, verifyTrialToken } from "../src/trial-token";

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
  // The defaults, which is what a deployment without the variables gets. The trial
  // limits live in the database's trial_settings table, not here.
  DAILY_ANALYSIS_LIMIT,
  ADMIN_DAILY_ANALYSIS_LIMIT,
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
  /** What trial_link_status answers, for the personal-link routes. */
  linkStatus?: TrialLinkStatus;
  /** What trial_scan_start answers. */
  scanResult?: TrialScanResult;
  /** The token version admin_trial_link_issue returns. */
  linkVersion?: number;
  /** Makes issuing a trial link fail, as a refused admin check would. */
  issueThrows?: boolean;
  /** Overrides for the invite feature's configuration. */
  gmail?: GmailDraftClient | null;
  inviteSender?: string | null;
  /** Overrides the whole configuration, for the limit variables. */
  config?: Config;
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
  const issuedLinks: Array<{ email: string; firstName: string | null }> = [];
  const markedLinks: string[] = [];
  const linkStatusCalls: Array<{ email: string; version: number | null }> = [];
  const scanCalls: Array<{ email: string; version: number }> = [];
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
    async issueTrialLink(email, firstName) {
      order.push("issue");
      issuedLinks.push({ email, firstName });
      if (options.issueThrows) {
        throw new ApiError(502, "upstream_error", "Could not create the trial link. Try again.");
      }
      return { email, firstName, version: options.linkVersion ?? 0 };
    },
    async markTrialLinkSent(email) {
      order.push("mark");
      markedLinks.push(email);
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

  // The trial store is a fake: no test here drives the trial, and the real one would
  // need the migration applied. It is present because AppDeps requires it, and the
  // routes gate on the trial secrets before they touch it.
  const trial: TrialStore = {
    async sendCode() {
      return { status: "invalid", code: undefined, email: undefined };
    },
    async verifyCode() {
      return "no_code";
    },
    async startScan(email, _ip, version) {
      scanCalls.push({ email, version });
      return options.scanResult ?? { status: "ok", scans_left: 9, call_id: "call-1" };
    },
    async linkStatus(email, version) {
      linkStatusCalls.push({ email, version });
      return options.linkStatus ?? { status: "invalid" };
    },
    async logCall() {},
    async getScansLimit() {
      return 10;
    },
  };
  const email: EmailClient | null = null;

  const app = createApp({
    config: options.config ?? CONFIG,
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
    trial,
    email,
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
    issuedLinks,
    markedLinks,
    linkStatusCalls,
    scanCalls,
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
      trialLinkSent: false,
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

  it("drafts the invite from the app's verified alias", async () => {
    // The draft sits in the mailbox INVITE_SENDER_ADDRESS names and is sent as the app, so the
    // From is the alias and not whichever mailbox the draft happens to live in.
    const { app, draftedMime } = buildHarness({ isAdmin: true });

    await request(app).post("/invite").set("Authorization", `Bearer ${TOKEN}`).send(body);

    const mime = draftedMime[0] ?? "";
    expect(mime).toContain("From: NutriTrack <invites@tracknutri.app>");
    // The address the drafts are created in is a different thing, and not the From.
    expect(mime).not.toContain("From: aman@example.com");
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

  describe("the approved variant", () => {
    // Approving somebody writes the list row in Postgres, in the same request that
    // decides it. This call exists only to tell them, so it must never write again.
    const approved = { email: "friend@example.com", firstName: "Hope", kind: "approved" };

    it("drafts the welcome instead, and touches nothing else", async () => {
      const { app, addedEmails, draftedMime, order } = buildHarness({ isAdmin: true });

      const response = await request(app)
        .post("/invite")
        .set("Authorization", `Bearer ${TOKEN}`)
        .send(approved);

      expect(response.status).toBe(200);
      expect(order).toEqual(["draft"]);
      expect(addedEmails).toEqual([]);
      expect(response.body).toEqual({
        email: "friend@example.com",
        firstName: "Hope",
        draftId: "draft-1",
        alreadyInvited: true,
        trialLinkSent: false,
      });
      const mime = draftedMime[0] ?? "";
      expect(mime).toContain("You're in: welcome to NutriTrack");
      expect(mime).toContain("Hi Hope,");
      expect(mime).toContain("From: NutriTrack <invites@tracknutri.app>");
    });

    it("says Hi there when the request came in without a name", async () => {
      const { app, draftedMime } = buildHarness({ isAdmin: true });

      await request(app)
        .post("/invite")
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({ email: "friend@example.com", firstName: "", kind: "approved" });

      const mime = draftedMime[0] ?? "";
      expect(mime).toContain("Hi there,");
      expect(mime).not.toContain("Hi ,");
    });

    it("still needs an admin, because it is the same route", async () => {
      const { app, draftedMime } = buildHarness({ isAdmin: false });

      const response = await request(app)
        .post("/invite")
        .set("Authorization", `Bearer ${TOKEN}`)
        .send(approved);

      expect(response.status).toBe(403);
      expect(draftedMime).toEqual([]);
    });
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
    const { app, loadedPaths } = buildHarness({ usedToday: DAILY_ANALYSIS_LIMIT });
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
    const { app, completions, recorded } = buildHarness({ usedToday: DAILY_ANALYSIS_LIMIT });
    const response = await post(app, TYPED_MEAL);

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe("rate_limited");
    // Twenty, not sixty: the number a normal account is refused at, and the same number the body
    // carries so the app does not have to guess which refusal it received.
    expect(response.body.error.details).toMatchObject({
      limit: 20,
      used: DAILY_ANALYSIS_LIMIT,
    });
    expect(response.body.error.message).toBe(dailyLimitMessage(20));
    // The sentence names what still works, because a refusal is only useful if it leaves a way in.
    expect(response.body.error.message).toContain("typing the numbers yourself");
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
    expect(completions).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("gives an admin a different ceiling, refused at sixty", async () => {
    // Nineteen used: an ordinary account is fine, an admin is fine too. Fifty-nine used: only the
    // admin is fine. This is the whole difference, and it is one number rather than a code path.
    const ordinaryAt59 = buildHarness({ usedToday: 59, isAdmin: false });
    expect((await post(ordinaryAt59.app, TYPED_MEAL)).status).toBe(429);

    const adminAt59 = buildHarness({ usedToday: 59, isAdmin: true });
    expect((await post(adminAt59.app, TYPED_MEAL)).status).toBe(200);

    const adminAt60 = buildHarness({ usedToday: ADMIN_DAILY_ANALYSIS_LIMIT, isAdmin: true });
    const refused = await post(adminAt60.app, TYPED_MEAL);
    expect(refused.status).toBe(429);
    expect(refused.body.error.details).toMatchObject({ limit: 60 });
    expect(refused.body.error.message).toBe(dailyLimitMessage(60));
  });

  it("still allows the last call within the allowance", async () => {
    const { app } = buildHarness({ usedToday: DAILY_ANALYSIS_LIMIT - 1 });
    const response = await post(app, TYPED_MEAL);
    expect(response.status).toBe(200);
  });

  it("follows the configured limit rather than the compiled one", async () => {
    // The env var is the authority: a deployment that sets 5 must refuse the sixth call even though
    // the shared default is 20.
    const { app } = buildHarness({ usedToday: 5, config: { ...CONFIG, DAILY_ANALYSIS_LIMIT: 5 } });
    const response = await post(app, TYPED_MEAL);
    expect(response.status).toBe(429);
    expect(response.body.error.details).toMatchObject({ limit: 5 });
    expect(response.body.error.message).toBe(dailyLimitMessage(5));
  });
});

/**
 * The number the app prints, asked of the service that enforces it.
 *
 * Before this route the browser had a constant, so an operator setting `DAILY_ANALYSIS_LIMIT=10`
 * moved the enforcement and left "of 20 left today" on the screen. These pin that the answer comes
 * from the configuration, is per-caller, and needs a token.
 */
describe("GET /analysis-limit", () => {
  const get = (app: ReturnType<typeof createApp>, token: string | null = TOKEN) => {
    const agent = request(app).get("/analysis-limit");
    if (token !== null) agent.set("Authorization", `Bearer ${token}`);
    return agent;
  };

  it("answers with the configured limits for an ordinary account", async () => {
    const { app } = buildHarness();
    const response = await get(app);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ daily: 20, admin: 60, limit: 20 });
  });

  it("answers with the admin ceiling for an admin, and both numbers for the panel", async () => {
    const { app } = buildHarness({ isAdmin: true });
    const response = await get(app);

    // `limit` is the caller's own, which is what Settings prints. `daily` and `admin` are what the
    // admin page needs, because it prints a number per row rather than just its own.
    expect(response.body).toEqual({ daily: 20, admin: 60, limit: 60 });
  });

  it("follows the configured values rather than the compiled defaults", async () => {
    const { app } = buildHarness({
      isAdmin: true,
      config: { ...CONFIG, DAILY_ANALYSIS_LIMIT: 10, ADMIN_DAILY_ANALYSIS_LIMIT: 99 },
    });
    const response = await get(app);
    expect(response.body).toEqual({ daily: 10, admin: 99, limit: 99 });
  });

  it("refuses a caller with no token, because the answer depends on who is asking", async () => {
    const { app } = buildHarness();
    const response = await get(app, null);
    expect(response.status).toBe(401);
  });
});

describe("GET /trial/settings", () => {
  it("answers 503 when the trial secrets are not configured", async () => {
    const { app } = buildHarness();
    const response = await request(app).get("/trial/settings");
    expect(response.status).toBe(503);
    expect(response.body.error.message).toBe("Trial unavailable right now");
  });

  it("relays the scan limit from the store when the trial is configured", async () => {
    const { app } = buildHarness({
      config: {
        ...CONFIG,
        TURNSTILE_SECRET: "turnstile-secret",
        RESEND_API_KEY: "resend-key",
        TRIAL_TOKEN_SECRET: "token-secret",
        TRIAL_SERVER_SECRET: "server-secret",
      },
    });
    const response = await request(app).get("/trial/settings");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ scans_limit: 10 });
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

/* -------------------------------------------------------------------------- */
/* Personal trial links                                                        */
/* -------------------------------------------------------------------------- */

const TOKEN_SECRET = "token-secret";
const TRIAL_CONFIG: Config = {
  ...CONFIG,
  TURNSTILE_SECRET: "turnstile-secret",
  RESEND_API_KEY: "resend-key",
  TRIAL_TOKEN_SECRET: TOKEN_SECRET,
  TRIAL_SERVER_SECRET: "server-secret",
};

function linkToken(
  email: string,
  options: { version?: number; firstName?: string; at?: Date } = {},
) {
  return signTrialToken(email, TOKEN_SECRET, (options.at ?? NOW).getTime(), {
    version: options.version ?? 0,
    firstName: options.firstName ?? null,
  });
}

const OK_LINK: TrialLinkStatus = {
  status: "ok",
  email: "priya@example.com",
  first_name: "Priya",
  token_version: 2,
  scans_left: 10,
  scans_total: 10,
};

describe("POST /trial/link", () => {
  it("answers ok with the name and scans for a valid link, checking its version", async () => {
    const { app, linkStatusCalls } = buildHarness({ config: TRIAL_CONFIG, linkStatus: OK_LINK });
    const response = await request(app)
      .post("/trial/link")
      .send({ token: linkToken("priya@example.com", { version: 2, firstName: "Priya" }) });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      email: "priya@example.com",
      firstName: "Priya",
      scansLeft: 10,
      scansTotal: 10,
    });
    expect(linkStatusCalls).toEqual([{ email: "priya@example.com", version: 2 }]);
  });

  it("answers expired for a link past its 30 days, without asking the database", async () => {
    const { app, linkStatusCalls } = buildHarness({ config: TRIAL_CONFIG, linkStatus: OK_LINK });
    const signedLongAgo = new Date(NOW.getTime() - TRIAL_TOKEN_TTL_SECONDS * 1000 - 1000);
    const response = await request(app)
      .post("/trial/link")
      .send({ token: linkToken("priya@example.com", { at: signedLongAgo }) });

    expect(response.body).toEqual({
      status: "expired",
      message: "This trial link has expired. Email invites@tracknutri.app for a new one.",
    });
    expect(linkStatusCalls).toEqual([]);
  });

  it("answers expired for a tampered link", async () => {
    const { app, linkStatusCalls } = buildHarness({ config: TRIAL_CONFIG, linkStatus: OK_LINK });
    const [, signature] = linkToken("priya@example.com").split(".");
    const forged = Buffer.from(
      JSON.stringify({ email: "someone-else@example.com", exp: NOW.getTime() / 1000 + 60, v: 0 }),
    ).toString("base64url");
    const response = await request(app)
      .post("/trial/link")
      .send({ token: `${forged}.${signature}` });

    expect(response.body.status).toBe("expired");
    expect(linkStatusCalls).toEqual([]);
  });

  it("answers expired for a revoked link", async () => {
    const { app } = buildHarness({ config: TRIAL_CONFIG, linkStatus: { status: "revoked" } });
    const response = await request(app)
      .post("/trial/link")
      .send({ token: linkToken("priya@example.com", { version: 1 }) });
    expect(response.body.status).toBe("expired");
  });

  it("sends somebody who already has an account to sign in", async () => {
    const { app } = buildHarness({
      config: TRIAL_CONFIG,
      linkStatus: { status: "already_access", email: "priya@example.com" },
    });
    const response = await request(app)
      .post("/trial/link")
      .send({ token: linkToken("priya@example.com") });
    expect(response.body).toEqual({ status: "already_access", email: "priya@example.com" });
  });

  it("answers 503 when the trial is not configured", async () => {
    const { app } = buildHarness();
    const response = await request(app).post("/trial/link").send({ token: "x.y" });
    expect(response.status).toBe(503);
  });
});

describe("POST /trial/parse with a personal link", () => {
  const scanBody = (token: string) => ({ token, text: "dal and rice", photos: [] });

  it("passes the token's version to the scan", async () => {
    const { app, scanCalls } = buildHarness({ config: TRIAL_CONFIG });
    const response = await request(app)
      .post("/trial/parse")
      .send(scanBody(linkToken("priya@example.com", { version: 3 })));
    expect(response.status).toBe(200);
    expect(scanCalls).toEqual([{ email: "priya@example.com", version: 3 }]);
  });

  it("refuses a revoked link with the expired sentence and calls no model", async () => {
    const { app, completions } = buildHarness({
      config: TRIAL_CONFIG,
      scanResult: { status: "revoked", scans_left: 0 },
    });
    const response = await request(app)
      .post("/trial/parse")
      .send(scanBody(linkToken("priya@example.com")));
    expect(response.status).toBe(401);
    expect(response.body.error).toMatchObject({
      code: "trial_link_expired",
      message: "This trial link has expired. Email invites@tracknutri.app for a new one.",
    });
    expect(completions).toEqual([]);
  });

  it("refuses a scan once the address has an account", async () => {
    const { app, completions } = buildHarness({
      config: TRIAL_CONFIG,
      scanResult: { status: "already_access", scans_left: 0 },
    });
    const response = await request(app)
      .post("/trial/parse")
      .send(scanBody(linkToken("priya@example.com")));
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("trial_already_access");
    expect(completions).toEqual([]);
  });

  it("refuses a tampered token before the database is asked", async () => {
    const { app, scanCalls } = buildHarness({ config: TRIAL_CONFIG });
    const response = await request(app)
      .post("/trial/parse")
      .send(scanBody(linkToken("priya@example.com").slice(0, -2) + "zz"));
    expect(response.status).toBe(401);
    expect(scanCalls).toEqual([]);
  });
});

describe("POST /trial/link/issue", () => {
  const issue = (app: Parameters<typeof request>[0], body: object) =>
    request(app).post("/trial/link/issue").set("Authorization", `Bearer ${TOKEN}`).send(body);

  it("refuses somebody who is not an admin, and issues nothing", async () => {
    const { app, issuedLinks } = buildHarness({ config: TRIAL_CONFIG, isAdmin: false });
    const response = await issue(app, { email: "priya@example.com", firstName: "Priya" });
    expect(response.status).toBe(403);
    expect(issuedLinks).toEqual([]);
  });

  it("refuses a request with no session", async () => {
    const { app } = buildHarness({ config: TRIAL_CONFIG, user: null });
    const response = await issue(app, { email: "priya@example.com" });
    expect(response.status).toBe(401);
  });

  it("returns a tracknutri.app/t/ link whose token names the address, version and name, and records it", async () => {
    const { app, issuedLinks, markedLinks } = buildHarness({
      config: TRIAL_CONFIG,
      isAdmin: true,
      linkVersion: 2,
    });
    const response = await issue(app, { email: "priya@example.com", firstName: "Priya" });

    expect(response.status).toBe(200);
    const url = String(response.body.url);
    expect(url.startsWith("https://tracknutri.app/t/")).toBe(true);
    const token = url.slice("https://tracknutri.app/t/".length);
    expect(verifyTrialToken(token, TOKEN_SECRET, NOW.getTime())).toEqual({
      ok: true,
      email: "priya@example.com",
      version: 2,
      firstName: "Priya",
    });
    // Valid for 30 days from issue, and not a moment longer.
    const expiresAt = NOW.getTime() + TRIAL_TOKEN_TTL_SECONDS * 1000;
    expect(verifyTrialToken(token, TOKEN_SECRET, expiresAt - 1000).ok).toBe(true);
    expect(verifyTrialToken(token, TOKEN_SECRET, expiresAt).ok).toBe(false);
    expect(issuedLinks).toEqual([{ email: "priya@example.com", firstName: "Priya" }]);
    expect(markedLinks).toEqual(["priya@example.com"]);
  });

  it("answers 503 when the trial has no token secret", async () => {
    const { app } = buildHarness({ isAdmin: true });
    const response = await issue(app, { email: "priya@example.com" });
    expect(response.status).toBe(503);
  });
});

/**
 * The decoded parts of a drafted MIME message: what a mail client would show. A quoted-printable
 * body wraps long lines with `=` and escapes `=` itself, so a token cannot be read off the raw
 * bytes; this undoes both encodings MailComposer uses.
 */
function mimeParts(mime: string): { type: string; body: string }[] {
  const boundary = /boundary="?([^";\r\n]+)"?/.exec(mime)?.[1];
  if (boundary === undefined) return [];
  return mime
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((chunk) => {
      const split = chunk.search(/\r?\n\r?\n/);
      const headers = chunk.slice(0, split);
      const raw = chunk.slice(split).trim();
      const type = /content-type:\s*([^;\r\n]+)/i.exec(headers)?.[1]?.trim() ?? "";
      const encoding = /content-transfer-encoding:\s*(\S+)/i.exec(headers)?.[1]?.toLowerCase();
      let body = raw;
      if (encoding === "quoted-printable") {
        const bytes = raw
          .replace(/=\r?\n/g, "")
          .replace(/=([0-9A-F]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
        body = Buffer.from(bytes, "latin1").toString("utf8");
      } else if (encoding === "base64") {
        body = Buffer.from(raw.replace(/\s+/g, ""), "base64").toString("utf8");
      }
      return { type, body };
    });
}

function trialTokensIn(body: string): string[] {
  return [...body.matchAll(/https:\/\/tracknutri\.app\/t\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g)].map(
    (m) => m[1] ?? "",
  );
}

describe("the invite drafts carry a personal trial link", () => {
  const body = { email: "Priya@Example.com", firstName: "Priya" };

  for (const kind of ["invite", "approved"] as const) {
    it(`puts a valid link in the HTML and the text of the ${kind} email, and records it after the draft`, async () => {
      const { app, draftedMime, order, markedLinks } = buildHarness({
        config: TRIAL_CONFIG,
        isAdmin: true,
        linkVersion: 1,
      });
      const response = await request(app)
        .post("/invite")
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({ ...body, kind });

      expect(response.status).toBe(200);
      expect(response.body.trialLinkSent).toBe(true);
      const mime = draftedMime[0] ?? "";
      expect(mime).toContain(kind === "invite" ? SUBJECT : "welcome to NutriTrack");

      const parts = mimeParts(mime);
      const html = parts.find((part) => part.type === "text/html")?.body ?? "";
      const text = parts.find((part) => part.type === "text/plain")?.body ?? "";
      expect(html).toContain(TRIAL_LINE);
      expect(text).toContain(TRIAL_LINE);

      const tokens = [...trialTokensIn(html), ...trialTokensIn(text)];
      expect(tokens).toHaveLength(2);
      expect(new Set(tokens).size).toBe(1);
      expect(verifyTrialToken(tokens[0] ?? "", TOKEN_SECRET, NOW.getTime())).toEqual({
        ok: true,
        email: "priya@example.com",
        version: 1,
        firstName: "Priya",
      });

      // Issued before the draft (the email needs the URL), recorded only once the draft exists.
      expect(order.indexOf("issue")).toBeLessThan(order.indexOf("draft"));
      expect(order.indexOf("mark")).toBeGreaterThan(order.indexOf("draft"));
      expect(markedLinks).toEqual(["priya@example.com"]);
    });
  }

  it("still drafts the invite, without the line, when the link cannot be issued", async () => {
    const { app, draftedMime, addedEmails, markedLinks } = buildHarness({
      config: TRIAL_CONFIG,
      isAdmin: true,
      issueThrows: true,
    });
    const response = await request(app)
      .post("/invite")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body.trialLinkSent).toBe(false);
    const parts = mimeParts(draftedMime[0] ?? "");
    expect(parts.map((part) => part.body).join("\n")).not.toContain(TRIAL_LINE);
    expect(addedEmails).toEqual(["priya@example.com"]);
    expect(markedLinks).toEqual([]);
  });

  it("drafts without the line when the trial has no token secret", async () => {
    const { app, draftedMime, issuedLinks } = buildHarness({ isAdmin: true });
    await request(app).post("/invite").set("Authorization", `Bearer ${TOKEN}`).send(body);
    expect(issuedLinks).toEqual([]);
    expect(
      mimeParts(draftedMime[0] ?? "")
        .map((part) => part.body)
        .join("\n"),
    ).not.toContain(TRIAL_LINE);
  });

  it("names the approval subject on the approval", () => {
    expect(APPROVED_SUBJECT).toContain("welcome to NutriTrack");
  });
});
