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
import type { EmailClient } from "./resend";
import { assertPathsOwnedBy, inviteRequestSchema, parseMealRequestSchema } from "./schemas";
import { clientIp, parseTrialMeal, TRIAL_UNAVAILABLE_MESSAGE, type TrialStore } from "./trial";
import { signTrialToken, verifyTrialToken } from "./trial-token";
import { verifyTurnstile } from "./turnstile";

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
  /** The trial store, over the anon client. Always built; the routes gate on config. */
  trial: TrialStore;
  /** Null without RESEND_API_KEY; the trial route says the trial is unavailable. */
  email: EmailClient | null;
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

const trialSendCodeSchema = z.object({
  email: z.string().min(3).max(254),
  firstName: z.string().max(60).optional().default(""),
  turnstileToken: z.string().min(1),
});

const trialVerifyCodeSchema = z.object({
  email: z.string().min(3).max(254),
  code: z.string().min(1).max(10),
});

const trialParseSchema = z
  .object({
    token: z.string().min(1),
    text: z.string().trim().max(2000).nullish(),
    photos: z
      .array(z.object({ base64: z.string().min(1), mimeType: z.string().min(1) }))
      .max(3)
      .default([]),
    eatenAt: z.string().datetime({ offset: true }).optional(),
    mealType: z.enum(["breakfast", "lunch", "dinner", "snack"]).nullish(),
  })
  .superRefine((value, ctx) => {
    if (!value.text && value.photos.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["text"],
        message: "provide a description or at least one photo",
      });
    }
  });

/** The four trial secrets, or a 503. After this returns, each value is present. */
function requireTrialSecrets(config: Config): { turnstile: string; token: string } {
  const { TURNSTILE_SECRET, RESEND_API_KEY, TRIAL_TOKEN_SECRET, TRIAL_SERVER_SECRET } = config;
  if (
    TURNSTILE_SECRET === undefined ||
    RESEND_API_KEY === undefined ||
    TRIAL_TOKEN_SECRET === undefined ||
    TRIAL_SERVER_SECRET === undefined
  ) {
    throw new ApiError(503, "internal_error", TRIAL_UNAVAILABLE_MESSAGE);
  }
  return { turnstile: TURNSTILE_SECRET, token: TRIAL_TOKEN_SECRET };
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  // Render terminates TLS upstream, so trust its header for req.ip and the logs.
  app.set("trust proxy", true);
  app.disable("x-powered-by");
  // The trial parse carries resized photos as base64, which a 128kb body cap would
  // refuse. This larger, route-scoped parser runs first so the rest of the service
  // keeps its small cap.
  app.use("/trial/parse", express.json({ limit: "8mb" }));
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

  /**
   * What the caller is allowed today, so the app never hardcodes it.
   *
   * The Settings card has to print "of 20 left today", and the admin page has to print a per-user
   * number. Both used to come from a constant compiled into the browser, which meant an operator
   * changing `DAILY_ANALYSIS_LIMIT` on the server would move the enforcement and leave the promise on
   * screen behind. This is the one place that answers the question, and it answers it from the same
   * configuration `parse-meal` enforces.
   *
   * It needs a token like every other route: the answer depends on who is asking, because an admin
   * gets a different number. Nothing secret is in the body.
   */
  app.get("/analysis-limit", async (req: Request, res: Response) => {
    const token = bearerToken(req.get("authorization"));
    const user = await deps.verifyToken(token);

    const admin = await deps.forCaller(user, token).isAdmin();
    const daily = deps.config.DAILY_ANALYSIS_LIMIT;
    const adminLimit = deps.config.ADMIN_DAILY_ANALYSIS_LIMIT;

    res.json({ daily, admin: adminLimit, limit: admin ? adminLimit : daily });
  });

  app.post("/parse-meal", async (req: Request, res: Response) => {
    const token = bearerToken(req.get("authorization"));
    const user = await deps.verifyToken(token);

    const parsed = parseMealRequestSchema.safeParse(req.body);
    if (!parsed.success) throw validationError(parsed.error);

    assertPathsOwnedBy(user.id, parsed.data.photoPaths);

    const outcome = await parseMeal(parsed.data, {
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
    });

    // The address itself is not logged. Who was invited is recorded in `allowed_emails`, which is
    // where that belongs; a log line would be a third copy of it that nobody ever purges.
    log("info", "invite drafted", {
      adminId: user.id,
      alreadyInvited: outcome.alreadyInvited,
    });

    res.json(outcome);
  });

  /**
   * Step 1 of the trial: verify a person, send a code, and never create an account.
   *
   * Turnstile is verified server-side *before* trial_send_code is called, and that
   * ordering is load-bearing: the secret gate means this route is the only way to ask
   * for a code, so the anti-bot check must run first or a script that is not a person
   * could mint codes. The code is generated and hashed inside the database function,
   * so this service only ever sees the plaintext long enough to email it.
   */
  app.post("/trial/send-code", async (req: Request, res: Response) => {
    const secrets = requireTrialSecrets(deps.config);
    const parsed = trialSendCodeSchema.safeParse(req.body);
    if (!parsed.success) throw validationError(parsed.error);

    const ip = clientIp(req.headers, req.ip);
    const human = await verifyTurnstile(secrets.turnstile, parsed.data.turnstileToken, ip);
    if (!human) {
      throw new ApiError(403, "forbidden", "Could not verify you are a person. Try again.");
    }

    const result = await deps.trial.sendCode(parsed.data.email, parsed.data.firstName, ip);

    if (result.status === "sent") {
      if (deps.email === null || result.code === undefined || result.email === undefined) {
        throw new ApiError(503, "internal_error", TRIAL_UNAVAILABLE_MESSAGE);
      }
      await deps.email.send({
        to: result.email,
        subject: "Your NutriTrack trial code",
        text: "Your NutriTrack trial code is " + result.code + ". It expires in 10 minutes.",
      });
      log("info", "trial code sent", { codePresent: true });
      res.json({ status: "sent", email: result.email });
      return;
    }
    if (result.status === "already_access") {
      res.json({ status: "already_access", email: result.email ?? parsed.data.email });
      return;
    }
    if (result.status === "invalid") {
      throw new ApiError(400, "invalid_request", "That address is not valid.");
    }
    if (result.status === "rate_limited") {
      throw new ApiError(429, "trial_busy", "Trial is busy right now. Request an invite instead.");
    }
    throw new ApiError(400, "invalid_request", "Could not start the trial.");
  });

  /** Step 2: prove the code, receive a signed trial token. */
  app.post("/trial/verify-code", async (req: Request, res: Response) => {
    const secrets = requireTrialSecrets(deps.config);
    const parsed = trialVerifyCodeSchema.safeParse(req.body);
    if (!parsed.success) throw validationError(parsed.error);

    const status = await deps.trial.verifyCode(parsed.data.email, parsed.data.code);
    if (status === "ok") {
      const token = signTrialToken(parsed.data.email, secrets.token);
      res.json({ status: "ok", token });
      return;
    }
    res.json({ status });
  });

  /** Step 3: a scan. The photo is analysed in memory and never stored. */
  app.post("/trial/parse", async (req: Request, res: Response) => {
    const secrets = requireTrialSecrets(deps.config);
    const parsed = trialParseSchema.safeParse(req.body);
    if (!parsed.success) throw validationError(parsed.error);

    const verified = verifyTrialToken(parsed.data.token, secrets.token);
    if (!verified.ok) {
      throw new ApiError(
        401,
        "unauthorized",
        verified.reason === "expired"
          ? "Your trial has expired. Start again."
          : "That trial link is not valid.",
      );
    }

    const ip = clientIp(req.headers, req.ip);
    const eatenAt = parsed.data.eatenAt === undefined ? new Date() : new Date(parsed.data.eatenAt);

    const outcome = await parseTrialMeal(
      {
        email: verified.email,
        ip,
        text: parsed.data.text ?? null,
        photos: parsed.data.photos.map((photo) => ({
          base64: photo.base64,
          mimeType: photo.mimeType,
        })),
        mealType: parsed.data.mealType ?? null,
        eatenAt,
      },
      { config: deps.config, llm: deps.llm, trial: deps.trial },
    );

    log("info", "parsed a trial meal", {
      items: outcome.items.length,
      attempts: outcome.attempts,
      model: outcome.model,
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
