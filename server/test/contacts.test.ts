/**
 * The three mailing list routes, through the real Express app with faked stores.
 *
 * The calls that matter here are the ones that must not fail the thing that made
 * them: a saved profile and an invite both finish even when Resend refuses. The
 * admin sync is the opposite, and says so.
 */
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { CallerStore } from "../src/caller-store";
import type { Config } from "../src/config";
import type { EmailSyncStore } from "../src/email-sync";
import type { GmailDraftClient } from "../src/gmail";
import type { CompletionRequest, LlmClient } from "../src/llm";
import type { ContactInput, ResendContactsClient } from "../src/resend-contacts";
import type { TrialStore } from "../src/trial";

const NOW = new Date("2026-03-02T12:00:00Z");
const USER = { id: "user-1", email: "person@one.test" };

const BASE_CONFIG: Config = {
  NODE_ENV: "test",
  PORT: 8787,
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  GEMINI_API_KEY: "gemini-example",
  GEMINI_VISION_MODEL: "gemini-3.8-flash",
  ALLOWED_ORIGINS: ["http://localhost:8080"],
  DAILY_ANALYSIS_LIMIT: 20,
  ADMIN_DAILY_ANALYSIS_LIMIT: 60,
  GLOBAL_DAILY_ANALYSIS_CAP: 400,
  TRIAL_REQUIRE_EMAIL: false,
};

const llm: LlmClient = {
  async complete(request: CompletionRequest) {
    return {
      content: "{}",
      model: request.model,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
      finishReason: "STOP",
    };
  },
};

const trial: TrialStore = {
  async sendCode() {
    return { status: "invalid", code: undefined, email: undefined, invited: false };
  },
  async verifyCode() {
    return "no_code";
  },
  async startScan() {
    return { status: "ok", scans_left: 9, call_id: "call-1" };
  },
  async startAnonymousDevice() {
    return {
      status: "ok",
      device_id: "11111111-1111-4111-8111-111111111111",
      token_version: 0,
      scans_left: 10,
      scans_total: 10,
    };
  },
  async startAnonymousScan() {
    return { status: "ok", scans_left: 9, call_id: "call-1" };
  },
  async linkStatus() {
    return { status: "invalid", invited: false };
  },
  async logCall() {},
  async refundScan() {
    return { refunded: true, scansLeft: 10 };
  },
  async getScansLimit() {
    return 10;
  },
  async logFunnel() {},
};

function fakeContacts(options: { throwOnUpsert?: boolean } = {}): {
  contacts: ResendContactsClient;
  upserted: ContactInput[];
} {
  const upserted: ContactInput[] = [];
  return {
    upserted,
    contacts: {
      async upsert(contact) {
        if (options.throwOnUpsert === true) throw new Error("Resend refused");
        upserted.push(contact);
        return "updated";
      },
    },
  };
}

function buildApp(options: {
  isAdmin?: boolean;
  email?: string | null;
  contacts?: ResendContactsClient | null;
  sync?: EmailSyncStore;
  secret?: string | undefined;
  productEmails?: boolean;
  added?: string[];
}) {
  const added = options.added ?? [];
  const store: CallerStore = {
    async countCallsSince() {
      return 0;
    },
    async recordCall() {},
    async timeZone() {
      return "UTC";
    },
    async emailPreferences() {
      return { productEmails: options.productEmails ?? true, firstName: "Aman" };
    },
    async globalAnalysesToday() {
      return 0;
    },
    async emailVerified() {
      return true;
    },
    async loadPhotos() {
      return [];
    },
    async isAdmin() {
      return options.isAdmin ?? false;
    },
    async hasAllowedEmail() {
      return false;
    },
    async addAllowedEmail(email) {
      added.push(email);
    },
    async issueTrialLink(email) {
      return { email, firstName: null, version: 0 };
    },
    async markTrialLinkSent() {},
  };

  const gmail: GmailDraftClient = {
    async createDraft() {
      return "draft-1";
    },
  };

  const sync: EmailSyncStore = options.sync ?? {
    async page() {
      return [];
    },
    async counts() {
      return { eligible: 0, excluded: 0, unsubscribed: 0 };
    },
    async record() {},
  };

  const config: Config = {
    ...BASE_CONFIG,
    ...(options.secret === undefined ? {} : { EMAIL_SYNC_SECRET: options.secret }),
  };

  return createApp({
    config,
    llm,
    async verifyToken() {
      return { id: USER.id, email: options.email === undefined ? USER.email : options.email };
    },
    forCaller: () => store,
    gmail,
    inviteSender: "aman@example.com",
    trial,
    email: null,
    contacts: options.contacts === undefined ? null : options.contacts,
    emailSync: sync,
    now: () => NOW,
  });
}

const auth = { authorization: "Bearer a-valid-access-token" };

describe("POST /contacts/join", () => {
  it("puts the caller on the list with the address from the token", async () => {
    const fake = fakeContacts();
    const app = buildApp({ contacts: fake.contacts, productEmails: false });

    const response = await request(app).post("/contacts/join").set(auth).send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(fake.upserted).toEqual([
      { email: "person@one.test", firstName: "Aman", productEmails: false },
    ]);
  });

  it("still answers ok when Resend refuses, so the saved profile stands", async () => {
    const fake = fakeContacts({ throwOnUpsert: true });
    const app = buildApp({ contacts: fake.contacts });

    const response = await request(app).post("/contacts/join").set(auth).send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it("is a no-op without a configured audience", async () => {
    const app = buildApp({ contacts: null });
    const response = await request(app).post("/contacts/join").set(auth).send({});
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });
});

describe("POST /contacts/unsubscribe", () => {
  it("turns the caller's contact off and sends nothing else", async () => {
    const fake = fakeContacts();
    const app = buildApp({ contacts: fake.contacts });

    const response = await request(app).post("/contacts/unsubscribe").set(auth).send({});

    expect(response.status).toBe(200);
    expect(fake.upserted).toEqual([
      { email: "person@one.test", firstName: null, productEmails: false },
    ]);
  });

  it("still answers ok when Resend refuses", async () => {
    const app = buildApp({ contacts: fakeContacts({ throwOnUpsert: true }).contacts });
    const response = await request(app).post("/contacts/unsubscribe").set(auth).send({});
    expect(response.status).toBe(200);
  });
});

describe("POST /contacts/sync", () => {
  it("refuses a caller who is not an admin, before touching anything", async () => {
    const fake = fakeContacts();
    const app = buildApp({ contacts: fake.contacts, secret: "sync-secret" });

    const response = await request(app).post("/contacts/sync").set(auth).send({});

    expect(response.status).toBe(403);
    expect(fake.upserted).toEqual([]);
  });

  it("answers the four counts and records what it did", async () => {
    const recorded: unknown[] = [];
    const sync: EmailSyncStore = {
      async page() {
        return [];
      },
      async counts() {
        return { eligible: 4, excluded: 3, unsubscribed: 1 };
      },
      async record(state) {
        recorded.push(state);
      },
    };
    const app = buildApp({ contacts: fakeContacts().contacts, isAdmin: true, secret: "s", sync });

    const response = await request(app).post("/contacts/sync").set(auth).send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ contacts: 0, failed: 0, excluded: 3, unsubscribed: 1 });
    expect(recorded).toEqual([{ contacts: 0, excluded: 3, unsubscribed: 1 }]);
  });

  it("rate limits a second press inside a minute", async () => {
    const app = buildApp({ contacts: fakeContacts().contacts, isAdmin: true, secret: "s" });

    const first = await request(app).post("/contacts/sync").set(auth).send({});
    const second = await request(app).post("/contacts/sync").set(auth).send({});

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
  });

  it("says it is not set up when the secret is absent", async () => {
    const app = buildApp({ contacts: fakeContacts().contacts, isAdmin: true, secret: undefined });
    const response = await request(app).post("/contacts/sync").set(auth).send({});
    expect(response.status).toBe(503);
  });
});

describe("POST /invite", () => {
  it("adds the address even when the contact upsert fails", async () => {
    const added: string[] = [];
    const fake = fakeContacts({ throwOnUpsert: true });
    const app = buildApp({ contacts: fake.contacts, isAdmin: true, added });

    const response = await request(app)
      .post("/invite")
      .set(auth)
      .send({ email: "New.Person@Example.com", firstName: "New" });

    expect(response.status).toBe(200);
    expect(added).toEqual(["new.person@example.com"]);

    // The upsert is fire and forget, so the request finishing first is the point.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.upserted).toEqual([]);
  });
});
