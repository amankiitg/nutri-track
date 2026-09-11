import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type PluginOption, type UserConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const srcDir = fileURLToPath(new URL("./src", import.meta.url));
/** A URL that resolves to this machine, or to nothing at all, rather than to a host. */
const LOCAL_URL = /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])([:/]|$)/i;

/**
 * Why a production build may not carry a local parse-meal URL.
 *
 * Vite inlines `VITE_*` values into the bundle, so a build made with a localhost value
 * ships an app that posts to a port on whatever device opens it. Nothing downstream can
 * detect that afterwards — the request fails identically to the service being down — so
 * this is the last point at which the mistake is still visible.
 *
 * Returns a message describing the problem, or null when the value is fine.
 */
function productionUrlProblem(value: string | undefined): string | null {
  const detail = `  VITE_PARSE_MEAL_URL = ${value === undefined || value === "" ? "(not set)" : value}`;
  const how = [
    "Build with the deployed URL instead:",
    "  npm run build:cloudflare",
    "Or set VITE_PARSE_MEAL_URL to the deployed https URL before building.",
  ].join("\n");

  if (value === undefined || value.trim() === "") {
    return [
      "Refusing to build for production: VITE_PARSE_MEAL_URL is not set, so the bundle",
      "would ship with no parse-meal endpoint at all.",
      detail,
      "",
      how,
    ].join("\n");
  }
  if (LOCAL_URL.test(value)) {
    return [
      "Refusing to build for production with a local parse-meal URL.",
      detail,
      "Vite inlines this into the bundle, so the deployed app would post to a port on",
      "whatever device opens it, and the failure would look like the service being down.",
      "",
      how,
    ].join("\n");
  }
  if (!value.startsWith("https://")) {
    return [
      "Refusing to build for production with a non-https parse-meal URL.",
      detail,
      "A page served over https cannot post to http, so the browser would block every",
      "request before it left the device.",
      "",
      how,
    ].join("\n");
  }
  return null;
}
/**
 * Standalone Vite config for NutriTrack.
 *
 * This replaces @lovable.dev/vite-tanstack-config, which used to supply the
 * TanStack Start plugin, Tailwind, tsconfig paths, the Nitro build, VITE_* env
 * inlining and the React/TanStack dedupe list. Everything it did that this app
 * actually needs is spelled out below.
 */
export default defineConfig(async ({ command, mode }): Promise<UserConfig> => {
  const plugins: PluginOption[] = [];

  const { tanstackStart } = await import("@tanstack/react-start/plugin/vite");
  plugins.push(
    tanstackStart({
      // Point TanStack Start at src/server.ts, our SSR error wrapper.
      server: { entry: "server" },
      importProtection: {
        behavior: "error",
        client: { files: ["**/server/**"], specifiers: ["server-only"] },
      },
    }),
  );

  // Nitro only produces a deployable server bundle, so it is build-only.
  if (command === "build") {
    const { nitro } = await import("nitro/vite");
    plugins.push(
      nitro({
        // Deploy target. Use "node-server" if you would rather host the SSR
        // bundle yourself (e.g. on Render) than on Cloudflare.
        preset: "cloudflare-module",
        cloudflare: {
          // Only the name. Nitro generates `main`, `assets`, `compatibility_flags`
          // and `no_bundle` itself, and *ignores* any of those set here with a
          // warning — so this is the one field worth stating, and nothing else.
          //
          // Left unset, Nitro derives the name from the git remote, which makes the
          // Worker's URL a function of the repository name. That URL is what Supabase's
          // Site URL and Google's authorized origins are pinned to, so it should not
          // move if the repository is ever renamed.
          wrangler: { name: "nutritrack" },
        },
      }),
    );
  }

  plugins.push(viteReact(), tailwindcss(), tsConfigPaths({ projects: ["./tsconfig.json"] }));

  // Vite exposes VITE_* itself; inlining them here keeps `import.meta.env.*`
  // working the same way it did under the Lovable config.
  const env = loadEnv(mode, projectRoot, "VITE_");
  const envDefine: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    envDefine[`import.meta.env.${key}`] = JSON.stringify(value);
  }

  // Only the production build, which is the one that gets deployed. `build:dev` is for
  // looking at a local bundle and is expected to point at a local service.
  if (command === "build" && mode === "production") {
    const problem = productionUrlProblem(env["VITE_PARSE_MEAL_URL"]);
    if (problem !== null) throw new Error(`\n\n${problem}\n`);
  }

  // `npm run build:dev` builds with NODE_ENV=development.
  const isDevBuild = command === "build" && mode === "development";

  return {
    define: envDefine,
    ...(isDevBuild
      ? {
          environments: {
            client: { define: { "process.env.NODE_ENV": JSON.stringify("development") } },
          },
        }
      : {}),
    css: { transformer: "lightningcss" },
    resolve: {
      alias: { "@": srcDir },
      dedupe: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "@tanstack/react-query",
        "@tanstack/query-core",
      ],
    },
    optimizeDeps: {
      include: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
      ],
      ignoreOutdatedRequests: true,
    },
    server: { host: "::", port: 8080 },
    plugins,
  };
});
