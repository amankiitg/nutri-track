/**
 * Wires the real implementations together. The only module that knows about both
 * Supabase and the model provider.
 */
import type { AppDeps } from "./app";
import { createTokenVerifier } from "./auth";
import { createCallerStore } from "./caller-store";
import type { Config } from "./config";
import { createGmailDraftClient } from "./gmail";
import { createGeminiClient } from "./gemini";
import { createResendClient } from "./resend";
import { createAuthClient, createCallerClient } from "./supabase";
import { createTrialStore } from "./trial";

export function createProductionDeps(config: Config): AppDeps {
  const authClient = createAuthClient(config);
  const llm = createGeminiClient({
    apiKey: config.GEMINI_API_KEY,
    textThinkingBudget: config.TEXT_THINKING_BUDGET,
  });

  // Built only when all three are present. A half-configured invite feature is worse than an
  // absent one: it would fail on the first admin who tried it. `null` makes /invite say the
  // feature is not set up, and leaves the parse route, which everyone uses daily, untouched.
  const gmail =
    config.GMAIL_OAUTH_CLIENT_ID !== undefined &&
    config.GMAIL_OAUTH_CLIENT_SECRET !== undefined &&
    config.GMAIL_OAUTH_REFRESH_TOKEN !== undefined
      ? createGmailDraftClient({
          clientId: config.GMAIL_OAUTH_CLIENT_ID,
          clientSecret: config.GMAIL_OAUTH_CLIENT_SECRET,
          refreshToken: config.GMAIL_OAUTH_REFRESH_TOKEN,
        })
      : null;

  // The trial store talks to PostgREST as anon; it is always built, because the trial
  // routes gate on trialAvailable(config) before using it. It carries the trial server
  // secret, which the database functions compare against the Vault copy. The email
  // client is null without RESEND_API_KEY, which is one of the things trialAvailable
  // requires.
  const trial = createTrialStore(authClient, config.TRIAL_SERVER_SECRET);
  const email =
    config.RESEND_API_KEY !== undefined ? createResendClient(config.RESEND_API_KEY) : null;

  return {
    config,
    llm,
    gmail,
    inviteSender: config.INVITE_SENDER_ADDRESS ?? null,
    trial,
    email,
    verifyToken: createTokenVerifier(authClient),
    forCaller: (user, accessToken) =>
      createCallerStore(createCallerClient(config, accessToken), user.id),
  };
}
