/**
 * The orphan-photo sweeper, as a command.
 *
 * Run by a Render cron job (`render.yaml`, `type: cron`) and by hand locally. It is
 * not a service: it starts, does one pass, prints a report and exits, so there is no
 * long-running process to leak and nothing to route traffic to.
 *
 * A dry run is the default. Nothing here deletes anything until `--live` or
 * `SWEEP_DRY_RUN=false` says so, on the principle that the failure mode of a job that
 * deletes too little is a few wasted megabytes, and the failure mode of a job that
 * deletes too much is lost photos.
 *
 * Never imported by `src/index.ts`, and never collected by the service's test suite.
 */
import { loadRootEnvFile } from "../src/env-file";
import { log } from "../src/log";
import { createServiceClient } from "../src/supabase";
import { SWEEP_USAGE, createSweepStore, parseSweepArgs, resolveDryRun, sweep } from "../src/sweep";
import { loadSweepConfig } from "../src/sweep-config";

const envFile = loadRootEnvFile();

async function main(): Promise<void> {
  const args = parseSweepArgs(process.argv.slice(2));
  if (args.help) {
    console.log(SWEEP_USAGE);
    return;
  }

  const config = loadSweepConfig();
  const dryRun = resolveDryRun(args.dryRunFlag, config.SWEEP_DRY_RUN);

  log("info", "sweep starting", {
    dryRun,
    minAgeHours: args.minAgeHours,
    envFile: envFile ?? "(none; using the ambient environment)",
  });

  const client = createServiceClient(
    config.SUPABASE_URL,
    config.SUPABASE_PUBLISHABLE_KEY,
    config.SUPABASE_SERVICE_ROLE_KEY,
  );

  const result = await sweep(createSweepStore(client), {
    dryRun,
    minAgeHours: args.minAgeHours,
  });

  log("info", "sweep finished", {
    dryRun: result.dryRun,
    scanned: result.scanned,
    referencedPaths: result.referenced,
    deleted: result.removed.length,
  });

  // A dry run that found work is not an error, but in a cron log it should be easy to
  // spot, so it gets its own line.
  if (dryRun) {
    log("warn", "dry run — nothing was deleted", {
      wouldDelete: result.plan.deletePaths.length,
    });
  }
}

main().catch((error: unknown) => {
  // A non-zero exit is how Render marks the cron run failed and, depending on the
  // notification settings, tells someone. Silence here would mean a job that has been
  // quietly doing nothing.
  log("error", "sweep failed", {
    reason: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
