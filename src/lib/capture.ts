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
  if (error) throw new Error(`Could not upload the photo: ${error.message}`);
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
 * Posts the meal and returns the validated reply.
 *
 * The caller's Supabase access token goes in the bearer header, and the service uses
 * that same token for its own calls, so RLS is what authorises everything.
 */
export async function requestParseMeal(
  accessToken: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<ParseResponse> {
  const response = await fetchImpl(parseMealUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    const message = messageFromErrorBody(text) ?? `The service returned HTTP ${response.status}.`;
    throw new Error(message);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("The service returned a body that is not JSON.");
  }

  const parsed = parseResponseSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `The service's reply did not match the expected shape (${issue?.path.join(".") ?? "unknown"}).`,
    );
  }
  return parsed.data;
}

/** Digs the human-readable message out of the service's error envelope. */
export function messageFromErrorBody(text: string): string | null {
  try {
    const parsed = z
      .object({ error: z.object({ message: z.string() }) })
      .safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.error.message : null;
  } catch {
    return null;
  }
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
