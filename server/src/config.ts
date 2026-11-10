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
import { ADMIN_DAILY_ANALYSIS_LIMIT, DAILY_ANALYSIS_LIMIT } from "../../shared/meal-parse";

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

/**
 * A whole number that may be absent.
 *
 * Empty counts as absent, because that is how a dashboard leaves a variable it has been given no
 * value. Anything else must be a whole number: a typo stops the boot with the variable named,
 * rather than being read as the default, which is the same rule the sweeper's `SWEEP_DRY_RUN`
 * switch follows and for the same reason.
 */
const optionalWholeNumber = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === "" ? undefined : Number(value)))
  .refine((value) => value === undefined || (Number.isInteger(value) && value >= 0), {
    message: "must be a whole number, or absent",
  });

/**
 * A whole number that defaults when it is absent.
 *
 * Zero is refused rather than accepted as "no analyses": a limit of zero is a service nobody can
 * use, and it is far more likely to be a typo or an empty dashboard field than a decision. The
 * default comes from the shared contract, so the number the app shows before any environment is set
 * is the number in the code.
 */
const wholeNumberOrDefault = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === "" ? fallback : Number(value)))
    .refine((value) => Number.isInteger(value) && value >= 1, {
      message: "must be a whole number of at least 1",
    });

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
  /**
   * How much thinking a *text-only* analysis may do, in tokens.
   *
   * Absent means the model's own minimum. A Gemini 3 model documents thinking as a level rather
   * than as a token range, so the absence of this variable is what selects
   * `thinkingLevel: "low"` in `server/src/gemini.ts`; setting it sends `thinkingBudget` instead.
   * Photo analyses get neither, because the photo is the hard part of the job.
   */
  TEXT_THINKING_BUDGET: optionalWholeNumber,
  /** Comma-separated. Anything absent from this list is refused by CORS. */
  ALLOWED_ORIGINS: commaSeparated,

  /**
   * How many meal analyses one ordinary account gets per local day.
   *
   * The service enforces this number, `/analysis-limit` reports it so the Settings card cannot
   * promise something the service does not honour, and the 429 body carries it so a refusal says
   * which number it was. Absent means the shared default, which is the same value the browser falls
   * back to when it cannot reach this service at all.
   */
  DAILY_ANALYSIS_LIMIT: wholeNumberOrDefault(DAILY_ANALYSIS_LIMIT),
  /** The same ceiling for an admin account. A permission, not a bypass. */
  ADMIN_DAILY_ANALYSIS_LIMIT: wholeNumberOrDefault(ADMIN_DAILY_ANALYSIS_LIMIT),

  /**
   * The free trial. All four secrets are optional on purpose: with any of them
   * missing the trial endpoints answer "Trial unavailable right now" rather than
   * running unprotected. The per-mailbox and global-daily limits no longer live
   * here: they are read from the trial_settings table in the database, which only
   * service_role writes. TRIAL_SERVER_SECRET is the value the service passes as
   * p_server_secret to the trial_* database functions; the matching copy lives in
   * Supabase Vault under the name 'trial_server_secret', and the two must agree.
   */
  TURNSTILE_SECRET: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  TRIAL_TOKEN_SECRET: z.string().min(1).optional(),
  TRIAL_SERVER_SECRET: z.string().min(1).optional(),

  /**
   * The admin invite feature's Google credentials, and the only secrets this service holds.
   *
   * Optional on purpose. The parse-meal route is what people use every day, and it must start
   * without these: /invite says the feature is not configured instead of the whole service
   * refusing to boot over a feature nobody is using at that moment.
   *
   * None of them may appear in a response, a log or an error. `server/src/gmail.ts` scrubs them
   * from every string it logs, and the only thing this file ever does with them is pass them on.
   */
  GMAIL_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GMAIL_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  GMAIL_OAUTH_REFRESH_TOKEN: z.string().min(1).optional(),
  /** The mailbox the drafts are created in. Shown on the admin page; not a secret. */
  INVITE_SENDER_ADDRESS: z.string().min(1).optional(),
});

export type Config = z.infer<typeof envSchema>;

const EXPECTED = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "GEMINI_API_KEY",
  "GEMINI_VISION_MODEL",
  "ALLOWED_ORIGINS",
  "PORT (optional, defaults to 8787)",
  "DAILY_ANALYSIS_LIMIT (optional, defaults to 20)",
  "ADMIN_DAILY_ANALYSIS_LIMIT (optional, defaults to 60)",
  "TURNSTILE_SECRET, RESEND_API_KEY, TRIAL_TOKEN_SECRET, TRIAL_SERVER_SECRET",
  "  (all optional; without any of them /try says the trial is unavailable)",
  "GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET, GMAIL_OAUTH_REFRESH_TOKEN,",
  "  INVITE_SENDER_ADDRESS (all optional; without them /invite says it is not set up)",
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

/**
 * Whether the trial can run at all.
 *
 * The trial needs all three secrets: Turnstile to prove the visitor is a person,
 * Resend to send the code, and the HMAC secret to sign the trial token. With any of
 * them missing the trial endpoints answer "Trial unavailable right now" rather than
 * running with one of the protections silently absent.
 */
export function trialAvailable(config: Config): boolean {
  return (
    config.TURNSTILE_SECRET !== undefined &&
    config.RESEND_API_KEY !== undefined &&
    config.TRIAL_TOKEN_SECRET !== undefined &&
    config.TRIAL_SERVER_SECRET !== undefined
  );
}
