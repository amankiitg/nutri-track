/**
 * The sign-in helpers, and the rule that nothing else starts a sign-in.
 *
 * Two kinds of test here. The behaviour ones prove the token is asked for, attached and given
 * back. The source-scan one reads the tree and fails if `signInWithOtp`, `signInWithOAuth` or
 * `auth.resend` appears anywhere but this module, which is what stops the next new screen from
 * quietly re-introducing the bug.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  requestEmailLink,
  startOAuthSignIn,
  resendConfirmation,
  type SignInClient,
} from "./auth-sign-in";

/** A client whose three calls record what they were given. */
function fakeClient() {
  // The parameter types matter: without them TypeScript reads `mock.calls[0]` as the empty
  // tuple, and the assertions below cannot read the arguments back.
  const signInWithOtp = vi.fn(
    async (_params: { email: string; options: Record<string, unknown> }) => ({
      data: {},
      error: null,
    }),
  );
  const signInWithOAuth = vi.fn(
    async (_params: { provider: string; options: Record<string, unknown> }) => ({
      data: { url: "https://example.com" },
      error: null,
    }),
  );
  const resend = vi.fn(async (_params: { type: string; email: string }) => ({
    data: {},
    error: null,
  }));
  const client = { auth: { signInWithOtp, signInWithOAuth, resend } } as unknown as SignInClient;
  return { client, signInWithOtp, signInWithOAuth, resend };
}

describe("the sign-in helpers", () => {
  it("attaches the token to the OTP request and releases it afterwards", async () => {
    const { client, signInWithOtp } = fakeClient();
    const source = { ensure: vi.fn(async () => "token-1"), reset: vi.fn() };

    await requestEmailLink(client, source, {
      email: "a@example.com",
      options: { shouldCreateUser: true, emailRedirectTo: "https://tracknutri.app/auth/welcome" },
    });

    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "a@example.com",
      options: {
        shouldCreateUser: true,
        emailRedirectTo: "https://tracknutri.app/auth/welcome",
        captchaToken: "token-1",
      },
    });
    expect(source.reset).toHaveBeenCalledTimes(1);
  });

  it("sends no token field at all when there is none", async () => {
    const { client, signInWithOtp } = fakeClient();
    const source = { ensure: vi.fn(async () => null), reset: vi.fn() };

    await requestEmailLink(client, source, {
      email: "a@example.com",
      options: { shouldCreateUser: false, emailRedirectTo: "https://tracknutri.app" },
    });

    const sent = signInWithOtp.mock.calls[0]?.[0] as { options: Record<string, unknown> };
    expect(sent.options).not.toHaveProperty("captchaToken");
  });

  it("releases the token even when the call throws", async () => {
    const { client } = fakeClient();
    const reset = vi.fn();
    const source = {
      ensure: vi.fn(async () => "token-1"),
      reset,
    };
    (client.auth.signInWithOtp as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("network"),
    );

    await expect(
      requestEmailLink(client, source, { email: "a@example.com", options: {} }),
    ).rejects.toThrow("network");
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("puts the token inside the Google options object", async () => {
    const { client, signInWithOAuth } = fakeClient();
    const source = { ensure: vi.fn(async () => "token-1"), reset: vi.fn() };

    await startOAuthSignIn(client, source, {
      provider: "google",
      options: { redirectTo: "https://tracknutri.app/auth/callback", skipBrowserRedirect: true },
    });

    const sent = signInWithOAuth.mock.calls[0]?.[0] as { options: Record<string, unknown> };
    expect(sent.options["captchaToken"]).toBe("token-1");
    expect(sent.options["redirectTo"]).toBe("https://tracknutri.app/auth/callback");
  });

  it("carries the token when a confirmation is resent", async () => {
    const { client, resend } = fakeClient();
    const source = { ensure: vi.fn(async () => "token-2"), reset: vi.fn() };

    await resendConfirmation(client, source, { type: "signup", email: "a@example.com" });

    const sent = resend.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent["options"]).toEqual({ captchaToken: "token-2" });
  });
});

describe("the source tree", () => {
  it("starts every sign-in through the helper", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];

    function walk(dir: string): void {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
        if (entry.includes(".test.")) continue;
        if (path.endsWith(join("lib", "auth-sign-in.ts"))) continue;
        if (path.includes(join("integrations", "supabase"))) continue;

        const text = readFileSync(path, "utf8");
        if (/signInWithOtp\s*\(|signInWithOAuth\s*\(|auth\.resend\s*\(/.test(text)) {
          offenders.push(path.slice(root.length + 1));
        }
      }
    }

    walk(root);
    expect(offenders).toEqual([]);
  });
});
