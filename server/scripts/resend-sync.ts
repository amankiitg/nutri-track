/**
 * The nightly mailing list sync.
 *
 * Same work the admin page's "Sync now" button does, from the same functions, so
 * there is one definition of what a sync is. It runs on Render because that is where
 * RESEND_API_KEY and the secret live; a laptop copy would need both exported, and the
 * point of the cron is that nobody has to.
 *
 * No service-role key: the audience is read through a secret-gated function.
 * No email is sent: the client only creates contacts and marks them unsubscribed.
 *
 * Exit status: 0 when every contact was accepted, 1 when any was refused or the run
 * could not start. A failed contact does not stop the run, so one bad address is a
 * line in the log and a failed run marker rather than a half synced list.
 */
import { createEmailSyncStore, syncAudience } from "../src/email-sync";
import { loadEmailSyncConfig } from "../src/email-sync-config";
import { loadRootEnvFile } from "../src/env-file";
import { log } from "../src/log";
import { createResendContactsClient } from "../src/resend-contacts";
import { createAuthClient } from "../src/supabase";

async function main(): Promise<void> {
  // Local runs read the same .env the service does. On Render there is no file and
  // the dashboard variables are already in the environment.
  const envFile = loadRootEnvFile();
  const config = loadEmailSyncConfig();

  const client = createAuthClient({
    SUPABASE_URL: config.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: config.SUPABASE_PUBLISHABLE_KEY,
  });
  const store = createEmailSyncStore(client, config.EMAIL_SYNC_SECRET);
  const contacts = createResendContactsClient({
    apiKey: config.RESEND_API_KEY,
    audienceId: config.RESEND_AUDIENCE_ID,
  });

  log("info", "mailing list sync starting", { envFile: envFile ?? "(none; ambient environment)" });

  const result = await syncAudience({ store, contacts });
  log("info", "mailing list sync finished", {
    contacts: result.contacts,
    failed: result.failed,
    excluded: result.excluded,
    unsubscribed: result.unsubscribed,
  });

  if (result.failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  // The error's own message names a variable or a table, never an address or a key.
  log("error", "mailing list sync failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
