/**
 * The sweeper's configuration, kept apart from `config.ts` on purpose.
 *
 * `config.ts` is read by the web service at boot and every variable in it is
 * mandatory there. Putting `SUPABASE_SERVICE_ROLE_KEY` in that schema would force the
 * request-serving service to hold a key that bypasses RLS — the exact thing the
 * service was designed not to have.
 *
 * So the key lives here, read by one job and by nothing else, and the web service
 * cannot even boot with the wrong configuration because it never looks at this file.
 */
import { z } from "zod";
import { httpUrl } from "./config";

export const sweepEnvSchema = z.object({
  SUPABASE_URL: httpUrl,
  /** Needed because PostgREST and Storage reject a request with no `apikey`. */
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1, "required"),
  /**
   * The one secret in this project that bypasses RLS. Read here and nowhere else:
   * the sweeper must see every meal, not just one user's.
   */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "required"),
  /**
   * A string rather than a coerced boolean, because `z.coerce.boolean()` turns the
   * string "false" into `true` — which would silently make the safe default unsafe.
   * `resolveDryRun` owns the interpretation and refuses anything it does not know.
   */
  SWEEP_DRY_RUN: z.string().optional(),
});

export type SweepConfig = z.infer<typeof sweepEnvSchema>;

const EXPECTED = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SWEEP_DRY_RUN (optional, defaults to a dry run)",
];

export function loadSweepConfig(env: NodeJS.ProcessEnv = process.env): SweepConfig {
  const parsed = sweepEnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid sweep configuration:\n${problems}\n\nExpected:\n${EXPECTED.map((name) => `  ${name}`).join("\n")}\n\nSUPABASE_SERVICE_ROLE_KEY comes from Supabase's dashboard under Project Settings -> API. It is read by the sweeper only — never by the parse-meal service.`,
    );
  }
  return parsed.data;
}
