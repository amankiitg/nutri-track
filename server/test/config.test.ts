import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const VALID: Record<string, string> = {
  NODE_ENV: "test",
  PORT: "9999",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  DEEPSEEK_API_KEY: "sk-example",
  DEEPSEEK_VISION_MODEL: "vision-model",
  DEEPSEEK_TEXT_MODEL: "text-model",
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
      DEEPSEEK_API_KEY: "sk-example",
      DEEPSEEK_VISION_MODEL: "vision-model",
      DEEPSEEK_TEXT_MODEL: "text-model",
      ALLOWED_ORIGINS: ["http://localhost:8080", "https://nutritrack.example.com"],
    });
  });

  it("defaults the port, which Render injects at deploy time anyway", () => {
    expect(loadConfig(without("PORT")).PORT).toBe(8787);
  });

  it("ignores variables it does not know about", () => {
    const config = loadConfig({ ...VALID, SOMETHING_ELSE: "ignored", VITE_SUPABASE_URL: "x" });
    expect(config.PORT).toBe(9999);
  });

  it.each([
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_VISION_MODEL",
    "DEEPSEEK_TEXT_MODEL",
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
      "DEEPSEEK_API_KEY",
      "DEEPSEEK_VISION_MODEL",
      "DEEPSEEK_TEXT_MODEL",
      "ALLOWED_ORIGINS",
    ]) {
      expect(message).toContain(name);
    }
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
