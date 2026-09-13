/**
 * The two Gmail names, read from the repo's `.env`.
 *
 * `.env` is already the one place local secrets live, and it is gitignored. This is the third
 * consumer of it, after the Vite frontend (`VITE_*` only) and the `server/` service.
 *
 * Nothing here is prefixed `VITE_`, deliberately: Vite inlines those into the browser bundle, so
 * a `VITE_` name must never hold a secret. `GMAIL_APP_PASSWORD` is read by this process and
 * nothing else.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** `<repo>/.env`, from this file's location. */
const ENV_PATH = fileURLToPath(new URL("../../../.env", import.meta.url));

export interface GmailConfig {
  /** The Gmail address the draft is created in, and the `From:` of the draft. */
  address: string;
  /** A Gmail app password. Never printed, never logged, never in an error message. */
  appPassword: string;
}

/** Names only — a missing variable is reported by name, never by dumping the environment. */
class MissingEnvError extends Error {}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new MissingEnvError(
      `${name} is not set. Add it to .env at the repo root (see .env.example).`,
    );
  }
  return value.trim();
}

export function loadGmailConfig(): GmailConfig {
  // Node's own reader, so there is no second .env parser to keep in step with the server's.
  // Absent is not fatal: on a machine that exports the names another way, this is a no-op.
  if (existsSync(ENV_PATH)) {
    process.loadEnvFile(ENV_PATH);
  }

  return { address: required("GMAIL_ADDRESS"), appPassword: required("GMAIL_APP_PASSWORD") };
}
