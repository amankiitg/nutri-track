/**
 * The request body for POST /parse-meal.
 *
 * Validated strictly: this is the one payload the browser controls, and the shape it
 * carries decides which model is called and which photos are read. `photoPaths` are
 * additionally checked against the caller's user id in the route, so a crafted body
 * cannot make the service read someone else's photo.
 */
import { z } from "zod";
import { MAX_PHOTOS, MEAL_SOURCES, MEAL_TYPES } from "../../shared/meal-parse";
import { ApiError } from "./errors";

export const parseMealRequestSchema = z
  .object({
    source: z.enum(MEAL_SOURCES),
    /** The transcript, or what the user typed. */
    text: z.string().trim().max(2000).nullish(),
    /** Storage paths of photos already uploaded by the capture sheet. */
    photoPaths: z.array(z.string().min(1).max(500)).max(MAX_PHOTOS).default([]),
    /** ISO 8601 with an offset, as `new Date().toISOString()` produces. */
    eatenAt: z.string().datetime({ offset: true }),
    /** Omitted when the client wants the service to guess from the time of day. */
    mealType: z.enum(MEAL_TYPES).nullish(),
    /** "That is not right, it was…" — an extra steer for a second attempt. */
    hint: z.string().trim().max(300).nullish(),
  })
  .superRefine((value, ctx) => {
    const hasText = Boolean(value.text);
    const hasPhotos = value.photoPaths.length > 0;

    if (!hasText && !hasPhotos) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["text"],
        message: "provide a transcript or description, or at least one photo",
      });
    }
    if (value.source === "photo" && !hasPhotos) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["photoPaths"],
        message: 'source is "photo", so at least one photo path is required',
      });
    }
    if (value.source !== "photo" && !hasText) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["text"],
        message: `source is "${value.source}", so text is required`,
      });
    }
  });

export type ParseMealRequest = z.infer<typeof parseMealRequestSchema>;

/**
 * Storage paths are `<user id>/<capture id>/<n>.jpg`, which the bucket policies
 * already enforce. This repeats the check in the service so a mismatch is a clear
 * 403 rather than an empty download, and rejects traversal outright.
 */
export function assertPathsOwnedBy(userId: string, paths: readonly string[]): void {
  for (const path of paths) {
    const segments = path.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new ApiError(403, "forbidden", "A photo path is not a valid storage path.");
    }
    if (segments[0] !== userId) {
      throw new ApiError(403, "forbidden", "A photo path does not belong to the caller.");
    }
  }
}
