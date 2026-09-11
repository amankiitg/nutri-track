import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type PluginOption, type UserConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const srcDir = fileURLToPath(new URL("./src", import.meta.url));

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
