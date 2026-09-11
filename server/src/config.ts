/**
 * Configuration, read once at boot and validated before the server listens.
 *
 * A missing or malformed variable must stop the process with a message naming the
 * variable, rather than surfacing as a 500 on the first request an hour later.
 * `loadConfig` takes the environment as an argument so tests can exercise it
 * without touching `process.env`.
 *
 * There is no SUPABASE_SERVICE_ROLE_KEY here on purpose. The service never needs
 * to bypass RLS: it verifies the caller's JWT and then holds that same token, so
 * every read and write is authorised as that user. A secret that is never read
 * cannot leak.
 */
import { z } from "zod";

/** An origin or URL we can hand to `cors` and `fetch`. Shared with the sweeper's config. */
export const httpUrl = z
  .string()
  .min(1, "required")
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an absolute http(s) URL");

const commaSeparated = z
  .string()
  .min(1, "required")
  .transform((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
  )
  .pipe(z.array(httpUrl).min(1, "list at least one origin"));

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Render injects PORT; the default is for local development. */
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),

  SUPABASE_URL: httpUrl,
  /** Public by design — the same value the browser bundle carries. */
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1, "required"),

  GEMINI_API_KEY: z.string().min(1, "required"),
  /**
   * One model, not two. Gemini Flash is multimodal, so the same id reads a photo
   * and a typed description; there is no separate text model to keep in sync.
   */
  GEMINI_VISION_MODEL: z.string().min(1, "required"),
  /** Comma-separated. Anything absent from this list is refused by CORS. */
  ALLOWED_ORIGINS: commaSeparated,
});

export type Config = z.infer<typeof envSchema>;

const EXPECTED = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "GEMINI_API_KEY",
  "GEMINI_VISION_MODEL",
  "ALLOWED_ORIGINS",
  "PORT (optional, defaults to 8787)",
];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${problems}\n\nExpected:\n${EXPECTED.map((name) => `  ${name}`).join("\n")}\n\nCopy .env.example to .env and fill it in.`,
    );
  }
  return parsed.data;
}
