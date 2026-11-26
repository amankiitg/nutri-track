/**
 * Wires the real implementations together. The only module that knows about both
 * Supabase and the model provider.
 */
import type { AppDeps } from "./app";
import { createTokenVerifier } from "./auth";
import { createCallerStore } from "./caller-store";
import { contactsApiKey, type Config } from "./config";
import { createEmailSyncStore } from "./email-sync";
import { createGmailDraftClient } from "./gmail";
import { createGeminiClient } from "./gemini";
import { createResendClient } from "./resend";
import { createResendContactsClient } from "./resend-contacts";
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
  // routes gate on their secrets before using it. It carries the trial server secret,
  // which the database functions compare against the Vault copy. The email client is
  // null without RESEND_API_KEY; only the email flow needs it, and only when
  // TRIAL_REQUIRE_EMAIL is true.
  const trial = createTrialStore(authClient, config.TRIAL_SERVER_SECRET);
  const email =
    config.RESEND_API_KEY !== undefined ? createResendClient(config.RESEND_API_KEY) : null;

  // The mailing list needs a contacts key and an audience id. With either missing it is null,
  // which makes the three contact routes say "not set up" rather than fail halfway. The contacts
  // key is separate from the sending key, because a sending-only key gets 401 from the Contacts
  // API; RESEND_API_KEY is the fallback for a key that already has full access. Building the
  // client does not read the key; only a request that uses it does.
  const contactsKey = contactsApiKey(config);
  const contacts =
    contactsKey !== undefined && config.RESEND_AUDIENCE_ID !== undefined
      ? createResendContactsClient({
          apiKey: contactsKey,
          audienceId: config.RESEND_AUDIENCE_ID,
        })
      : null;

  // Always built, and inert without the secret: the database function compares the
  // argument against Vault, so a missing copy is a refusal rather than an open door.
  // The routes check for the secret first and answer 503 for that reason.
  const emailSync = createEmailSyncStore(authClient, config.EMAIL_SYNC_SECRET);

  return {
    config,
    llm,
    gmail,
    inviteSender: config.INVITE_SENDER_ADDRESS ?? null,
    trial,
    email,
    contacts,
    emailSync,
    verifyToken: createTokenVerifier(authClient),
    forCaller: (user, accessToken) =>
      createCallerStore(createCallerClient(config, accessToken), user.id),
  };
}
