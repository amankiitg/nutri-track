import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const VALID: Record<string, string> = {
  NODE_ENV: "test",
  PORT: "9999",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  GEMINI_API_KEY: "gemini-example",
  GEMINI_VISION_MODEL: "gemini-3.8-flash",
  ALLOWED_ORIGINS: "http://localhost:8080, https://nutritrack.example.com",
};

function without(name: string): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...VALID };
  delete copy[name];
  return copy;
}

describe("loadConfig", () => {
  it("reads and coerces a complete environment", () => {
    const config = loadConfig(VALID);
    expect(config).toEqual({
      NODE_ENV: "test",
      PORT: 9999,
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
      GEMINI_API_KEY: "gemini-example",
      GEMINI_VISION_MODEL: "gemini-3.8-flash",
      ALLOWED_ORIGINS: ["http://localhost:8080", "https://nutritrack.example.com"],
      // Absent means the shared defaults, which is what a deployment that has never heard of these
      // variables gets. The trial limits no longer live here at all: they are read from the
      // trial_settings table in the database.
      DAILY_ANALYSIS_LIMIT: 20,
      ADMIN_DAILY_ANALYSIS_LIMIT: 60,
    });
  });

  describe("the analysis limits", () => {
    it("default to twenty and sixty", () => {
      const config = loadConfig(VALID);
      expect(config.DAILY_ANALYSIS_LIMIT).toBe(20);
      expect(config.ADMIN_DAILY_ANALYSIS_LIMIT).toBe(60);
    });

    it("read a whole number when one is set", () => {
      const config = loadConfig({
        ...VALID,
        DAILY_ANALYSIS_LIMIT: "5",
        ADMIN_DAILY_ANALYSIS_LIMIT: "500",
      });
      expect(config.DAILY_ANALYSIS_LIMIT).toBe(5);
      expect(config.ADMIN_DAILY_ANALYSIS_LIMIT).toBe(500);
    });

    it("treat an empty value as absent, which is how a dashboard leaves a variable", () => {
      expect(loadConfig({ ...VALID, DAILY_ANALYSIS_LIMIT: "" }).DAILY_ANALYSIS_LIMIT).toBe(20);
    });

    it("refuse zero and refuse a typo, rather than starting with a limit nobody can use", () => {
      // Zero would be a service nobody can use, and it is far more likely a slip than a decision.
      expect(() => loadConfig({ ...VALID, DAILY_ANALYSIS_LIMIT: "0" })).toThrow(
        /DAILY_ANALYSIS_LIMIT/,
      );
      expect(() => loadConfig({ ...VALID, ADMIN_DAILY_ANALYSIS_LIMIT: "sixty" })).toThrow(
        /ADMIN_DAILY_ANALYSIS_LIMIT/,
      );
    });
  });

  it("defaults the port, which Render injects at deploy time anyway", () => {
    expect(loadConfig(without("PORT")).PORT).toBe(8787);
  });

  it("ignores variables it does not know about", () => {
    const config = loadConfig({ ...VALID, SOMETHING_ELSE: "ignored", VITE_SUPABASE_URL: "x" });
    expect(config.PORT).toBe(9999);
  });

  describe("TEXT_THINKING_BUDGET", () => {
    it("is absent by default, which is what selects the model's own minimum", () => {
      expect(loadConfig(VALID).TEXT_THINKING_BUDGET).toBeUndefined();
    });

    it("reads a whole number, including zero", () => {
      expect(loadConfig({ ...VALID, TEXT_THINKING_BUDGET: "0" }).TEXT_THINKING_BUDGET).toBe(0);
      expect(loadConfig({ ...VALID, TEXT_THINKING_BUDGET: "512" }).TEXT_THINKING_BUDGET).toBe(512);
    });

    it("treats an empty value as absent, which is how a dashboard leaves it", () => {
      expect(
        loadConfig({ ...VALID, TEXT_THINKING_BUDGET: "" }).TEXT_THINKING_BUDGET,
      ).toBeUndefined();
    });

    it.each(["low", "1.5", "-1", "many"])(
      "stops the boot on %s rather than reading it as the default",
      (value) => {
        expect(() => loadConfig({ ...VALID, TEXT_THINKING_BUDGET: value })).toThrow(
          /TEXT_THINKING_BUDGET/,
        );
      },
    );
  });

  it.each([
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "GEMINI_API_KEY",
    "GEMINI_VISION_MODEL",
    "ALLOWED_ORIGINS",
  ])("refuses to boot without %s, and says which one", (name) => {
    expect(() => loadConfig(without(name))).toThrow(new RegExp(`- ${name}:`));
  });

  it("lists every expected variable in the failure message", () => {
    let message = "";
    try {
      loadConfig({});
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    for (const name of [
      "SUPABASE_URL",
      "SUPABASE_PUBLISHABLE_KEY",
      "GEMINI_API_KEY",
      "GEMINI_VISION_MODEL",
      "ALLOWED_ORIGINS",
    ]) {
      expect(message).toContain(name);
    }
  });

  it("reads the trial server secret when one is set, and is absent by default", () => {
    expect(loadConfig(VALID).TRIAL_SERVER_SECRET).toBeUndefined();
    expect(
      loadConfig({ ...VALID, TRIAL_SERVER_SECRET: "vault-agreed-secret" }).TRIAL_SERVER_SECRET,
    ).toBe("vault-agreed-secret");
  });

  it("never asks for the service role key", () => {
    // The invariant this whole design rests on: the service never bypasses RLS, so
    // that key must not be part of its configuration. If it ever creeps back in,
    // this test is the alarm.
    let message = "";
    try {
      loadConfig({});
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).not.toContain("SERVICE_ROLE");
    expect(() => loadConfig({ ...VALID, SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x" })).not.toThrow();
  });

  it.each([["0"], ["70000"], ["not-a-port"], ["-1"]])("rejects PORT=%s", (port) => {
    expect(() => loadConfig({ ...VALID, PORT: port })).toThrow();
  });

  it.each([["example.supabase.co"], [""], ["ftp://example.com"]])(
    "rejects SUPABASE_URL=%s",
    (url) => {
      expect(() => loadConfig({ ...VALID, SUPABASE_URL: url })).toThrow();
    },
  );

  it("rejects an empty origin list and a non-http origin", () => {
    expect(() => loadConfig({ ...VALID, ALLOWED_ORIGINS: "" })).toThrow();
    expect(() => loadConfig({ ...VALID, ALLOWED_ORIGINS: " , " })).toThrow();
    expect(() => loadConfig({ ...VALID, ALLOWED_ORIGINS: "ws://localhost:8080" })).toThrow();
  });

  it("accepts a single origin with no comma", () => {
    expect(
      loadConfig({ ...VALID, ALLOWED_ORIGINS: "http://localhost:8080" }).ALLOWED_ORIGINS,
    ).toEqual(["http://localhost:8080"]);
  });

  it("rejects an unknown NODE_ENV rather than guessing", () => {
    expect(() => loadConfig({ ...VALID, NODE_ENV: "staging" })).toThrow();
  });
});
