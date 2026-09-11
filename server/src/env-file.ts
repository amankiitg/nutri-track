/**
 * Loads the repository's single `.env` into `process.env`.
 *
 * One `.env` holds every variable, so the service has to read the file the frontend
 * reads. Node does not do this on its own: a production process gets the panel's
 * variables from the platform, and `npm run dev` gets nothing at all, which is how
 * the service came to refuse to boot locally with a perfectly good `.env` sitting one
 * directory up.
 *
 * Values already present in the environment win, which is what keeps a deployment
 * honest: Render's panel is authoritative and a stray file cannot override it.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The `.env` at the repository root, two levels up from both `src/` and `dist/`. */
export function rootEnvPath(): string {
  return fileURLToPath(new URL("../../.env", import.meta.url));
}

/** Returns the path it read, or null when there is no file — as on Render. */
export function loadRootEnvFile(): string | null {
  const path = rootEnvPath();
  if (!existsSync(path)) return null;
  try {
    process.loadEnvFile(path);
    return path;
  } catch {
    return null;
  }
}
