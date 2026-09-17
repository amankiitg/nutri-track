/**
 * The HTTP layer: CORS, auth, validation, and one place that turns a thrown error
 * into a response.
 *
 * Everything it needs is a parameter, so a test can build the app with a fake
 * verifier, a fake store and a fake model client and exercise the real routing,
 * status codes and headers.
 */
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { bearerToken, type TokenVerifier, type VerifiedUser } from "./auth";
import type { CallerStore } from "./caller-store";
import type { Config } from "./config";
import type { GmailDraftClient } from "./gmail";
import { invite } from "./invite";
import type { LlmClient } from "./llm";
import { ApiError, isApiError } from "./errors";
import { log } from "./log";
import { parseMeal } from "./parse-meal";
import { assertPathsOwnedBy, inviteRequestSchema, parseMealRequestSchema } from "./schemas";

export interface AppDeps {
  config: Config;
  llm: LlmClient;
  verifyToken: TokenVerifier;
  /** Builds the caller-scoped store. Each call carries that caller's token. */
  forCaller: (user: VerifiedUser, accessToken: string) => CallerStore;
  /** Null when the invite feature is not configured; /invite then says so. */
  gmail: GmailDraftClient | null;
  /** The mailbox the drafts are created in. Null when the feature is not configured. */
  inviteSender: string | null;
  now?: () => Date;
}

/** Turns Zod's issues into something a client can act on. */
function validationError(error: z.ZodError): ApiError {
  return new ApiError(400, "invalid_request", "The request body is not valid.", {
    details: error.issues.map((issue) => ({
      path: issue.path.join(".") || "(root)",
      message: issue.message,
    })),
  });
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  // Render terminates TLS upstream, so trust its header for req.ip and the logs.
  app.set("trust proxy", true);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "128kb" }));

  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header: a same-origin request, curl, or a health check.
        if (!origin) {
          callback(null, true);
          return;
        }
        if (deps.config.ALLOWED_ORIGINS.includes(origin)) {
          callback(null, true);
          return;
        }
        // Refused before any handler runs. The browser will not see this body,
        // because there will be no CORS headers to let it read the response — the
        // message is for whoever is looking at curl or the logs.
        callback(new ApiError(403, "forbidden", `Origin ${origin} is not an allowed origin.`));
      },
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      maxAge: 86_400,
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/parse-meal", async (req: Request, res: Response) => {
    const token = bearerToken(req.get("authorization"));
    const user = await deps.verifyToken(token);

    const parsed = parseMealRequestSchema.safeParse(req.body);
    if (!parsed.success) throw validationError(parsed.error);

    assertPathsOwnedBy(user.id, parsed.data.photoPaths);

    const outcome = await parseMeal(parsed.data, user.id, {
      config: deps.config,
      llm: deps.llm,
      store: deps.forCaller(user, token),
      ...(deps.now ? { now: deps.now } : {}),
    });

    log("info", "parsed a meal", {
      userId: user.id,
      source: outcome.source,
      items: outcome.items.length,
      attempts: outcome.attempts,
      model: outcome.model,
    });

    res.json(outcome);
  });

  /**
   * Invite someone: one action, two halves, no drift.
   *
   * Admin-only, and enforced here rather than by hiding the button in the UI. `is_admin()` is
   * asked with the caller's own token, so `auth.uid()` inside it is the caller and the answer
   * cannot be influenced by the request body. The insert is gated a second time by the
   * `allowed_emails` policy, which also admits only an admin — so a bug in this check still does
   * not let a stranger add an address.
   */
  app.post("/invite", async (req: Request, res: Response) => {
    const token = bearerToken(req.get("authorization"));
    const user = await deps.verifyToken(token);

    const parsed = inviteRequestSchema.safeParse(req.body);
    if (!parsed.success) throw validationError(parsed.error);

    const store = deps.forCaller(user, token);
    if (!(await store.isAdmin())) {
      throw new ApiError(403, "forbidden", "Only an admin can invite people.");
    }

    if (deps.gmail === null || deps.inviteSender === null) {
      throw new ApiError(503, "internal_error", "Inviting is not set up on the server yet.");
    }

    const outcome = await invite(parsed.data, {
      store,
      gmail: deps.gmail,
      senderAddress: deps.inviteSender,
    });

    // The address itself is not logged. Who was invited is recorded in `allowed_emails`, which is
    // where that belongs; a log line would be a third copy of it that nobody ever purges.
    log("info", "invite drafted", {
      adminId: user.id,
      alreadyInvited: outcome.alreadyInvited,
    });

    res.json(outcome);
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: "invalid_request", message: "No such route." } });
  });
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (isApiError(error)) {
      for (const [name, value] of Object.entries(error.headers)) res.setHeader(name, value);
      if (error.status >= 500) {
        log("error", error.message, { code: error.code, path: req.path });
      }
      res.status(error.status).json({
        error: { code: error.code, message: error.message, details: error.details ?? null },
      });
      return;
    }

    // Anything else is a bug. Log it in full; tell the client nothing.
    log("error", "unhandled error", {
      path: req.path,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      stack: error instanceof Error ? (error.stack ?? null) : null,
    });
    res.status(500).json({
      error: { code: "internal_error", message: "Something went wrong.", details: null },
    });
  });

  return app;
}
