/**
 * Everything the capture sheet does before and after it talks to the parse service:
 * resizing, hashing, uploading and the request itself.
 *
 * The pure parts — the resize arithmetic, the request body, the response schema — are
 * separated from the browser-only parts so they can be unit tested in jsdom without a
 * canvas, and so the request the service receives is visible in one place.
 */
import { z } from "zod";
import {
  MEAL_PHOTO_BUCKET,
  mealPhotoPath,
  sha256HexOfBytes,
  type MealType,
  type MealSource,
} from "@shared/meal-parse";
import { supabase } from "@/integrations/supabase/client";

/** Long edge of the image actually sent to the model, in pixels. */
export const MAX_EDGE = 1024;
/** JPEG quality for the same. 0.8 is the point where food still reads clearly. */
export const JPEG_QUALITY = 0.8;

/**
 * The types the browser can decode and the bucket accepts.
 *
 * The two lists agree by design: `meal-photos` allows jpeg, png and webp, so an image
 * the browser cannot decode is one the bucket would refuse anyway. Failing here gives
 * a message a person can act on instead of a storage error code.
 *
 * HEIC is the case that matters. iPhones shoot in it, browsers cannot decode it, and
 * the bucket does not accept it — so an iPhone user who picks a photo from Files rather
 * than taking one can hit this with nothing to go on.
 */
const SUPPORTED_PHOTO_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

/** Thrown when a photo cannot be read, with a message worth showing the user. */
export class UndecodablePhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UndecodablePhotoError";
  }
}

export function isSupportedPhotoType(type: string): boolean {
  return SUPPORTED_PHOTO_TYPES.has(type.trim().toLowerCase());
}

/** Names the file and says what to do about it, rather than reporting a decoder. */
export function undecodablePhotoMessage(fileName: string): string {
  if (/\.(heic|heif)$/i.test(fileName)) {
    return `${fileName} is a HEIC photo. Browsers cannot open those and the photo bucket does not accept them, so it cannot be analysed. On an iPhone, share the photo as a JPEG instead — or tap Take a photo, which converts automatically. You can also describe the meal in the Type tab.`;
  }
  return `${fileName} is not a photo this browser can read. Use a JPEG, PNG or WebP, or describe the meal in the Type tab.`;
}

export interface Dimensions {
  width: number;
  height: number;
}

/**
 * Scales a photo down so its longest edge is `maxEdge`, never enlarging it. A
 * 4000 px phone photo becomes 1024 px, which is both cheaper to send and no worse
 * for the model: the tokens an image costs scale with its size.
 */
export function fitWithin({ width, height }: Dimensions, maxEdge = MAX_EDGE): Dimensions {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    // At least one pixel, so a pathological aspect ratio cannot produce a zero.
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export interface PreparedPhoto {
  blob: Blob;
  /** SHA-256 of the resized bytes, which is what the fingerprint uses. */
  sha256: string;
  width: number;
  height: number;
  /** Bytes as uploaded, for the debug panel. */
  bytes: number;
}

/**
 * Resizes to JPEG and hashes the result.
 *
 * The hash is taken over the *resized* bytes on purpose: those are the bytes that
 * get uploaded and the bytes the model sees, so two captures of the same photo
 * produce the same hash and the duplicate check works. Hashing the original would
 * hash something that never leaves the device.
 *
 * `imageOrientation: "from-image"` is what applies the EXIF rotation, so a photo
 * taken in portrait is not sent sideways.
 */
export async function preparePhoto(file: File | Blob, maxEdge = MAX_EDGE): Promise<PreparedPhoto> {
  const fileName = file instanceof File ? file.name : "that photo";

  // Checked before decoding, because the decoder's own message says nothing useful.
  if (file.type !== "" && !isSupportedPhotoType(file.type)) {
    throw new UndecodablePhotoError(undecodablePhotoMessage(fileName));
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // A file whose type looked fine but which the browser still cannot read — a HEIC
    // served as application/octet-stream, a truncated download, a RAW file.
    throw new UndecodablePhotoError(undecodablePhotoMessage(fileName));
  }

  try {
    const target = fitWithin({ width: bitmap.width, height: bitmap.height }, maxEdge);
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;

    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot provide a 2D canvas context.");
    context.drawImage(bitmap, 0, 0, target.width, target.height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY);
    });
    if (!blob) throw new Error("The browser could not encode the resized photo.");

    return {
      blob,
      sha256: await sha256HexOfBytes(await blob.arrayBuffer()),
      width: target.width,
      height: target.height,
      bytes: blob.size,
    };
  } finally {
    bitmap.close();
  }
}

export interface UploadedPhoto {
  path: string;
  sha256: string;
}

/** Uploads one prepared photo to the caller's own folder and returns its path. */
export async function uploadMealPhoto(
  userId: string,
  photo: PreparedPhoto,
): Promise<UploadedPhoto> {
  const path = mealPhotoPath(userId, crypto.randomUUID());
  const { error } = await supabase.storage.from(MEAL_PHOTO_BUCKET).upload(path, photo.blob, {
    contentType: "image/jpeg",
    upsert: false,
  });
  if (error) {
    // Storage's own words are about buckets and policies, which is not a thing anyone
    // can act on from a dinner table. They go to the console, where a person debugging
    // will look, and the screen gets the one sentence that helps.
    console.error("meal photo upload failed", { path, message: error.message });
    throw new Error(
      "Could not upload the photo, so nothing was logged. Check your connection and try again.",
    );
  }
  return { path, sha256: photo.sha256 };
}

/** The body the parse service expects, built in one place and unit tested. */
export interface ParseRequestInput {
  source: MealSource;
  text?: string | null;
  photoPaths: readonly string[];
  eatenAt: Date;
  mealType?: MealType | null;
  hint?: string | null;
}

export function buildParseRequest(input: ParseRequestInput): Record<string, unknown> {
  return {
    source: input.source,
    text: input.text ?? null,
    photoPaths: [...input.photoPaths],
    // ISO with the offset, which is what the service's schema requires.
    eatenAt: input.eatenAt.toISOString(),
    mealType: input.mealType ?? null,
    hint: input.hint ?? null,
  };
}

/**
 * The service's reply, validated rather than trusted. It is a different runtime on
 * the other side of a network hop, so it is as external as the model's own output.
 */
export const parseResponseSchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      quantity: z.number().nullable(),
      unit: z.string().nullable(),
      grams: z.number().nullable(),
      calories: z.number(),
      protein_g: z.number(),
      carbs_g: z.number(),
      fat_g: z.number(),
      fiber_g: z.number().nullable(),
      sugar_g: z.number().nullable(),
      sodium_mg: z.number().nullable(),
      confidence: z.number(),
      needs_review: z.boolean(),
      review_reasons: z.array(z.string()),
    }),
  ),
  meal_type: z.enum(["breakfast", "lunch", "dinner", "snack"]),
  source: z.enum(["photo", "voice", "text"]),
  model: z.string(),
  attempts: z.number(),
});

export type ParseResponse = z.infer<typeof parseResponseSchema>;

/** The endpoint the browser posts to. A URL, not a secret, hence the VITE_ prefix. */
export function parseMealUrl(): string {
  const url = import.meta.env["VITE_PARSE_MEAL_URL"];
  if (!url) {
    throw new Error(
      "VITE_PARSE_MEAL_URL is not set. Copy .env.example to .env, or point it at the deployed service.",
    );
  }
  return url;
}

/**
 * How long the browser waits before deciding the service is not coming back.
 *
 * This is a ceiling on a hang, not a deadline for a normal parse, so it sits above
 * the service's own worst case rather than near the typical one. The service allows
 * each model call 60 s and runs a second attempt when the first reply is unusable,
 * so a genuinely slow meal can legitimately take 120 s. Timing out below that would
 * abort requests that were about to succeed, and each abort costs the user two of
 * their sixty daily calls when they retry. 150 s leaves room for the photo download
 * and the upload either side of the model and still ends in a message rather than an
 * indefinite spinner.
 */
export const PARSE_TIMEOUT_MS = 150_000;

/**
 * Why a parse did not produce items.
 *
 * The distinction is what makes an honest message possible. "The service is down",
 * "your phone has no signal" and "the service said no" all look the same from a
 * `catch` block — one string from a thrown `TypeError` — but they call for different
 * sentences and a different next move from the user.
 */
export type ParseFailureKind =
  /** The request never reached an answer: no signal, DNS, or a refused origin. */
  | "unreachable"
  /** We gave up waiting. */
  | "timeout"
  /** The user pressed Cancel. */
  | "cancelled"
  /** The service answered, and the answer was an error. */
  | "service";

export interface ParseFailureOptions {
  code?: string | null;
  status?: number | null;
  retryAfterSeconds?: number | null;
  details?: unknown;
}

/**
 * A parse that failed, carrying enough for the UI to say something true about it.
 *
 * `details` is kept rather than discarded because it is where the service puts the
 * machine-readable half of its refusals — the daily limit and how many were used, for
 * instance — and the Settings screen is built on exactly that.
 */
export class ParseFailure extends Error {
  readonly kind: ParseFailureKind;
  readonly code: string | null;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  readonly details: unknown;

  constructor(kind: ParseFailureKind, message: string, options: ParseFailureOptions = {}) {
    super(message);
    this.name = "ParseFailure";
    this.kind = kind;
    this.code = options.code ?? null;
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.details = options.details ?? null;
  }
}

/** The error envelope the service returns, or null when the body is not one. */
export function parseApiError(
  text: string,
): { code: string; message: string; details: unknown } | null {
  try {
    const parsed = z
      .object({
        error: z.object({
          code: z.string().optional(),
          message: z.string(),
          details: z.unknown().optional(),
        }),
      })
      .safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    return {
      code: parsed.data.error.code ?? "unknown",
      message: parsed.data.error.message,
      details: parsed.data.error.details ?? null,
    };
  } catch {
    return null;
  }
}

/** Digs the human-readable message out of the service's error envelope. */
export function messageFromErrorBody(text: string): string | null {
  return parseApiError(text)?.message ?? null;
}

/**
 * Rounds a wait to something a person would say out loud.
 *
 * Deliberately coarse. "in about 7 hours" is a decision; "in 6 hours 47 minutes" is
 * a number pretending to be one, and it is wrong by the time the screen has rendered.
 */
export function describeWait(seconds: number): string {
  if (seconds <= 90) return "in a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in about ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours === 1) return "in about an hour";
  if (hours < 20) return `in about ${hours} hours`;
  return "tomorrow";
}

/**
 * What to say about a failed parse, from the phone's point of view.
 *
 * The service's own message is used whenever there is one, because it knows things
 * this file cannot: that the model declined, that the photos could not be read. Only
 * the cases the service cannot describe — it never heard the request — are written
 * here. The one exception is the daily limit, where the service supplies the reset
 * time in `details` and the sentence is better for using it.
 */
export function describeParseFailure(failure: ParseFailure): string {
  switch (failure.kind) {
    case "unreachable":
      return "Could not reach the meal service. Check your connection — the meal has not been logged.";
    case "timeout":
      return `The meal service did not answer within ${Math.round(PARSE_TIMEOUT_MS / 1000)} seconds, so this was given up on. Nothing was logged. Try again, or type what you ate instead.`;
    case "cancelled":
      return "Analysis cancelled. Nothing was logged.";
    case "service":
      if (failure.code === "rate_limited") {
        const when =
          failure.retryAfterSeconds === null ? "tomorrow" : describeWait(failure.retryAfterSeconds);
        return `${failure.message} They come back ${when}. You can still type a meal — it is only the reading of photos that is limited.`;
      }
      return failure.message;
  }
}

/**
 * Turns anything thrown by a capture into a failure the UI can report.
 *
 * A plain `Error` keeps its own message, because by the time one reaches here it is
 * already written for a person: an expired session, a photo that would not upload.
 * Only the fetch path needs a kind, and it sets its own.
 */
export function toParseFailure(caught: unknown): ParseFailure {
  if (caught instanceof ParseFailure) return caught;
  return new ParseFailure(
    "service",
    caught instanceof Error ? caught.message : "Something went wrong.",
  );
}

export interface ParseRequestOptions {
  fetchImpl?: typeof fetch;
  /** Aborts the request, so Cancel can abandon a parse that is still running. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Whichever of the given signals aborts first.
 *
 * Hand-rolled rather than `AbortSignal.any`, which is newer than the browsers this
 * has to run in: an iPhone on iOS 17.3 would throw a TypeError from inside the fetch
 * path, and a missing method there would be reported as a network failure. Ten lines
 * is a cheaper price than a support-call-shaped bug.
 */
export function firstAbortOf(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/**
 * Posts the meal and returns the validated reply.
 *
 * The caller's Supabase access token goes in the bearer header, and the service uses
 * that same token for its own calls, so RLS is what authorises everything.
 *
 * Every way this can fail is turned into a `ParseFailure` with a kind, because the
 * alternative is what used to happen: the browser's own words reached the screen, and
 * a phone with no signal, a service that was down and a misconfigured origin all said
 * "Failed to fetch".
 */
export async function requestParseMeal(
  accessToken: string,
  body: Record<string, unknown>,
  options: ParseRequestOptions = {},
): Promise<ParseResponse> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? PARSE_TIMEOUT_MS;

  // Two reasons to stop: our own ceiling, and the user pressing Cancel. The timer
  // covers the whole exchange, body included — a server that sends headers and then
  // stalls is exactly the hang this exists to end.
  const timer = new AbortController();
  const deadline = setTimeout(() => timer.abort(), timeoutMs);
  const signal =
    options.signal === undefined ? timer.signal : firstAbortOf([timer.signal, options.signal]);

  let response: Response;
  let text: string;
  try {
    response = await doFetch(parseMealUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    text = await response.text();
  } catch (caught) {
    // The user's own abort is checked first: when both fire, "you cancelled it" is
    // more use than a timeout they did not cause.
    if (options.signal?.aborted === true) {
      throw new ParseFailure("cancelled", "Analysis cancelled.", {});
    }
    if (timer.signal.aborted) {
      throw new ParseFailure("timeout", "The meal service did not answer in time.", {});
    }
    // Everything else here is the request never arriving. A cross-origin request that
    // CORS refused is indistinguishable from one that never left the phone, which is
    // why `ALLOWED_ORIGINS` on the service is worth checking first when this appears.
    throw new ParseFailure("unreachable", "Could not reach the meal service.", {});
  } finally {
    clearTimeout(deadline);
  }

  if (!response.ok) {
    const envelope = parseApiError(text);
    const retryAfter = Number(response.headers.get("Retry-After"));
    throw new ParseFailure(
      "service",
      envelope?.message ?? `The meal service returned HTTP ${response.status}.`,
      {
        code: envelope?.code ?? null,
        status: response.status,
        retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
        details: envelope?.details ?? null,
      },
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ParseFailure("service", "The meal service returned a reply that is not JSON.", {
      status: response.status,
    });
  }

  const parsed = parseResponseSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ParseFailure(
      "service",
      `The meal service's reply did not match the expected shape (${issue?.path.join(".") ?? "unknown"}).`,
      { status: response.status },
    );
  }
  return parsed.data;
}

/**
 * Deletes photos a capture uploaded but never saved.
 *
 * This is the only thing standing between an abandoned capture and a file that lives in
 * the bucket forever, so every path that gives up on a capture has to call it: Discard,
 * Cancel, and closing the sheet. A tab killed outright runs no code at all, which is the
 * case a sweeper would still be needed for.
 *
 * Failures are swallowed on purpose: the user is closing a sheet, and an error about
 * cleanup they cannot act on is worse than a leftover file.
 */
export async function deleteMealPhotos(paths: readonly string[]): Promise<boolean> {
  if (paths.length === 0) return true;
  try {
    const { error } = await supabase.storage.from(MEAL_PHOTO_BUCKET).remove([...paths]);
    return error === null;
  } catch {
    return false;
  }
}
