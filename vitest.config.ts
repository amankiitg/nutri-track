import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // vitest.config.ts replaces vite.config.ts, so the aliases must be declared here too.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  test: {
    // Frontend and shared-module tests only. The server/ service is a separate
    // package with its own runner: see `npm run test:server`.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "shared/**/*.test.ts"],
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
