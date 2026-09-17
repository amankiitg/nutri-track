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
import { createAuthClient, createCallerClient } from "./supabase";

export function createProductionDeps(config: Config): AppDeps {
  const authClient = createAuthClient(config);
  const llm = createGeminiClient({ apiKey: config.GEMINI_API_KEY });

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

  return {
    config,
    llm,
    gmail,
    inviteSender: config.INVITE_SENDER_ADDRESS ?? null,
    verifyToken: createTokenVerifier(authClient),
    forCaller: (user, accessToken) =>
      createCallerStore(createCallerClient(config, accessToken), user.id),
  };
}
