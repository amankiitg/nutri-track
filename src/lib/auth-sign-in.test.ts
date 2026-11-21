/**
 * The sign-in helpers, and the rule that nothing else starts a sign-in.
 *
 * Two kinds of test here. The behaviour ones prove the token is asked for, attached and given
 * back. The source-scan one reads the tree and fails if `signInWithOtp`, `signInWithOAuth`,
 * `auth.resend`, `auth.signInWithPassword` or `auth.resetPasswordForEmail` appears anywhere but this
 * module, which is what stops the next new screen from quietly re-introducing the bug, and what puts
 * the password and reset paths behind the captcha token that every other path already carried.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CAPTCHA_STILL_LOADING,
  CAPTCHA_UNAVAILABLE_CODE,
  requestEmailLink,
  requestPasswordReset,
  startOAuthSignIn,
  resendConfirmation,
  signInWithPassword,
  type SignInClient,
} from "./auth-sign-in";
import { CaptchaUnavailableError } from "./turnstile-token";

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
  const signInWithPasswordCall = vi.fn(
    async (_params: { email: string; password: string; options: Record<string, unknown> }) => ({
      data: { user: null, session: null },
      error: null,
    }),
  );
  const resetPasswordForEmail = vi.fn(
    async (_email: string, _options: Record<string, unknown>) => ({ data: {}, error: null }),
  );
  const client = {
    auth: {
      signInWithOtp,
      signInWithOAuth,
      resend,
      signInWithPassword: signInWithPasswordCall,
      resetPasswordForEmail,
    },
  } as unknown as SignInClient;
  return {
    client,
    signInWithOtp,
    signInWithOAuth,
    resend,
    signInWithPassword: signInWithPasswordCall,
    resetPasswordForEmail,
  };
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

describe("CAPTCHA on and no token", () => {
  const refusing = {
    ensure: async () => {
      throw new CaptchaUnavailableError();
    },
    reset: vi.fn(),
  };

  it("does not send a password sign-in, and says the security check is loading", async () => {
    const { client, signInWithPassword: passwordCall } = fakeClient();

    const answer = await signInWithPassword(client, refusing, {
      email: "a@example.com",
      password: "correct horse battery",
    });

    // Nothing left the screen: a request without a token is one GoTrue refuses, and the person then
    // blames their password.
    expect(passwordCall).not.toHaveBeenCalled();
    expect(answer.error?.message).toBe(CAPTCHA_STILL_LOADING);
    expect((answer.error as { code?: string }).code).toBe(CAPTCHA_UNAVAILABLE_CODE);
  });

  it("does not send a reset either", async () => {
    const { client, resetPasswordForEmail } = fakeClient();

    const answer = await requestPasswordReset(client, refusing, {
      email: "a@example.com",
      redirectTo: "https://tracknutri.app/auth/reset",
    });

    expect(resetPasswordForEmail).not.toHaveBeenCalled();
    expect(answer.error?.message).toBe(CAPTCHA_STILL_LOADING);
  });

  it("does not send a link or a Google hand-off", async () => {
    const { client, signInWithOtp, signInWithOAuth } = fakeClient();

    await requestEmailLink(client, refusing, { email: "a@example.com", options: {} });
    await startOAuthSignIn(client, refusing, { provider: "google", options: {} });

    expect(signInWithOtp).not.toHaveBeenCalled();
    expect(signInWithOAuth).not.toHaveBeenCalled();
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
        // The password and reset calls are matched with their `auth.` prefix, because the helper's
        // own names are what callers use for the wrapped version.
        if (
          /signInWithOtp\s*\(|signInWithOAuth\s*\(|auth\.resend\s*\(|auth\.signInWithPassword\s*\(|auth\.resetPasswordForEmail\s*\(/.test(
            text,
          )
        ) {
          offenders.push(path.slice(root.length + 1));
        }
      }
    }

    walk(root);
    expect(offenders).toEqual([]);
  });
});
