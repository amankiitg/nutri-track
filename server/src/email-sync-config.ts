/**
 * The mailing list cron's configuration, kept apart from `config.ts`.
 *
 * The web service starts without these: the invite path and the Settings switch
 * merely skip the Resend call when the audience is not configured. The nightly job
 * has nothing else to do, so it refuses to start without all five, naming the one
 * that is missing.
 *
 * There is no SUPABASE_SERVICE_ROLE_KEY here, and there must never be. The job reads
 * the audience through email_sync_page(), a security definer function gated by
 * EMAIL_SYNC_SECRET. The matching Vault row is 'email_sync_server_secret'.
 */
import { z } from "zod";
import { httpUrl } from "./config";

export const emailSyncEnvSchema = z.object({
  SUPABASE_URL: httpUrl,
  /** Public by design. PostgREST rejects a request with no `apikey` header. */
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1, "required"),
  /** The same key the web service uses for trial codes. */
  RESEND_API_KEY: z.string().min(1, "required"),
  /** The audience named "NutriTrack list". Not a secret; found in Resend's URL. */
  RESEND_AUDIENCE_ID: z.string().min(1, "required"),
  /** The value compared against Vault's 'email_sync_server_secret'. */
  EMAIL_SYNC_SECRET: z.string().min(1, "required"),
});

export type EmailSyncConfig = z.infer<typeof emailSyncEnvSchema>;

const EXPECTED = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "RESEND_API_KEY",
  "RESEND_AUDIENCE_ID",
  "EMAIL_SYNC_SECRET",
];

export function loadEmailSyncConfig(env: NodeJS.ProcessEnv = process.env): EmailSyncConfig {
  const parsed = emailSyncEnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid mailing list sync configuration:\n${problems}\n\nExpected:\n${EXPECTED.map((name) => `  ${name}`).join("\n")}\n\nThis job runs on Render, where these live in the service's environment. EMAIL_SYNC_SECRET must match the Supabase Vault secret named 'email_sync_server_secret'. It reads no service-role key.`,
    );
  }
  return parsed.data;
}
