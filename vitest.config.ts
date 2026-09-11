import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // vitest.config.ts replaces vite.config.ts, so the aliases must be declared here too.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("./supabase/functions/_shared", import.meta.url)),
    },
  },
  test: {
    // Tests live beside the code they cover, including the Edge Function's.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "supabase/**/*.test.ts"],
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
