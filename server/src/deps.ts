/**
 * Wires the real implementations together. The only module that knows about both
 * Supabase and DeepSeek.
 */
import type { AppDeps } from "./app";
import { createTokenVerifier } from "./auth";
import { createCallerStore } from "./caller-store";
import type { Config } from "./config";
import { createDeepSeekClient } from "./deepseek";
import { createAuthClient, createCallerClient } from "./supabase";

export function createProductionDeps(config: Config): AppDeps {
  const authClient = createAuthClient(config);
  const llm = createDeepSeekClient({ apiKey: config.DEEPSEEK_API_KEY });

  return {
    config,
    llm,
    verifyToken: createTokenVerifier(authClient),
    forCaller: (user, accessToken) =>
      createCallerStore(createCallerClient(config, accessToken), user.id),
  };
}
