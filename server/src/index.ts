/**
 * Boot. Configuration is validated here, before the socket opens, so a missing
 * variable is a startup failure with a message naming it rather than a 500 on the
 * first request.
 */
import { createApp } from "./app";
import { loadConfig, type Config } from "./config";
import { createProductionDeps } from "./deps";
import { loadRootEnvFile } from "./env-file";
import { log } from "./log";

// Before the config is read, so `npm run dev` sees the same .env the frontend does.
// On Render there is no file and the panel's variables are already in the environment.
const envFile = loadRootEnvFile();

function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const config = loadConfigOrExit();

const app = createApp(createProductionDeps(config));

const server = app.listen(config.PORT, () => {
  log("info", "parse-meal listening", {
    port: config.PORT,
    env: config.NODE_ENV,
    allowedOrigins: config.ALLOWED_ORIGINS.join(","),
    envFile: envFile ?? "(none; using the ambient environment)",
  });
});

/** Render sends SIGTERM on deploy; finish in-flight requests rather than dropping them. */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log("info", "shutting down", { signal });
    server.close(() => process.exit(0));
  });
}
