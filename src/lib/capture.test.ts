import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSupportedPhotoType, undecodablePhotoMessage } from "./capture";
import { MAX_EDGE } from "./capture";
import { buildParseRequest, fitWithin, messageFromErrorBody, parseResponseSchema } from "./capture";
import {
  describeParseFailure,
  describeWait,
  firstAbortOf,
  ParseFailure,
  parseApiError,
  requestParseMeal,
  toParseFailure,
} from "./capture";

describe("fitWithin", () => {
  it("leaves an image that is already small enough alone", () => {
    expect(fitWithin({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
  });

  it("caps the long edge of a photo straight off a phone", () => {
    expect(fitWithin({ width: 4032, height: 3024 })).toEqual({ width: 1024, height: 768 });
  });

  it("caps a portrait photo by its height", () => {
    expect(fitWithin({ width: 3024, height: 4032 })).toEqual({ width: 768, height: 1024 });
  });

  it("is a no-op exactly at the limit, and does not upscale past it", () => {
    expect(fitWithin({ width: MAX_EDGE, height: 500 })).toEqual({ width: MAX_EDGE, height: 500 });
    expect(fitWithin({ width: 100, height: 100 })).toEqual({ width: 100, height: 100 });
  });

  it("never rounds a dimension down to zero", () => {
    const squashed = fitWithin({ width: 8000, height: 3 });
    expect(squashed.height).toBeGreaterThanOrEqual(1);
    expect(squashed.width).toBe(1024);
  });

  it("preserves the aspect ratio within a pixel", () => {
    const source = { width: 4000, height: 2500 };
    const scaled = fitWithin(source);
    expect(scaled.width / scaled.height).toBeCloseTo(source.width / source.height, 2);
  });
});

describe("buildParseRequest", () => {
  const eatenAt = new Date("2026-03-02T12:05:00.000Z");

  it("sends an ISO instant with an offset, which is what the service requires", () => {
    const body = buildParseRequest({ source: "text", text: "two eggs", photoPaths: [], eatenAt });
    expect(body["eatenAt"]).toBe("2026-03-02T12:05:00.000Z");
  });

  it("sends null rather than omitting the optional fields", () => {
    const body = buildParseRequest({ source: "text", text: "two eggs", photoPaths: [], eatenAt });
    expect(body).toMatchObject({ mealType: null, hint: null });
  });

  it("keeps the photos that were uploaded", () => {
    const body = buildParseRequest({
      source: "photo",
      photoPaths: ["user-1/a.jpg", "user-1/b.jpg"],
      eatenAt,
    });
    expect(body["photoPaths"]).toEqual(["user-1/a.jpg", "user-1/b.jpg"]);
  });

  it("passes a hint through when there is one", () => {
    const body = buildParseRequest({
      source: "text",
      text: "rice",
      photoPaths: [],
      eatenAt,
      hint: "small portion",
    });
    expect(body["hint"]).toBe("small portion");
  });
});

describe("parseResponseSchema", () => {
  const valid = {
    items: [
      {
        name: "Oatmeal",
        quantity: 1,
        unit: "bowl",
        grams: 250,
        calories: 300,
        protein_g: 10,
        carbs_g: 54,
        fat_g: 6,
        fiber_g: 8,
        sugar_g: 12,
        sodium_mg: 150,
        confidence: 0.8,
        needs_review: false,
        review_reasons: [],
      },
    ],
    meal_type: "breakfast",
    source: "text",
    model: "gemini-3.8-flash",
    attempts: 1,
  };

  it("accepts a reply of the shape the service promises", () => {
    expect(parseResponseSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts nulls in the optional nutrient fields", () => {
    const nullable = {
      ...valid,
      items: [{ ...valid.items[0], grams: null, fiber_g: null, sugar_g: null, sodium_mg: null }],
    };
    expect(parseResponseSchema.safeParse(nullable).success).toBe(true);
  });

  it("rejects an unknown meal type", () => {
    expect(parseResponseSchema.safeParse({ ...valid, meal_type: "brunch" }).success).toBe(false);
  });

  it("rejects a reply whose item is missing needs_review", () => {
    const { needs_review: _dropped, ...item } = valid.items[0]!;
    expect(parseResponseSchema.safeParse({ ...valid, items: [item] }).success).toBe(false);
  });
});

describe("photo types the browser and the bucket both accept", () => {
  it("accepts what the bucket allows", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp"]) {
      expect(isSupportedPhotoType(type)).toBe(true);
    }
  });

  it("rejects HEIC, which iPhones shoot and browsers cannot read", () => {
    expect(isSupportedPhotoType("image/heic")).toBe(false);
    expect(isSupportedPhotoType("image/heif")).toBe(false);
  });

  it("is tolerant of casing and padding, because browsers vary", () => {
    expect(isSupportedPhotoType("  IMAGE/JPEG ")).toBe(true);
  });

  it("names HEIC as HEIC and says what to do about it", () => {
    const message = undecodablePhotoMessage("IMG_6114.HEIC");
    expect(message).toContain("HEIC");
    expect(message).toContain("JPEG");
    // It has to point somewhere, or the user is simply stuck.
    expect(message).toContain("Type tab");
  });

  it("gives a different message for a file that is simply not a photo", () => {
    const message = undecodablePhotoMessage("notes.pdf");
    expect(message).not.toContain("HEIC");
    expect(message).toContain("JPEG, PNG or WebP");
  });
});

describe("messageFromErrorBody", () => {
  it("reads the service's error envelope", () => {
    const body = JSON.stringify({ error: { code: "rate_limited", message: "Too many today." } });
    expect(messageFromErrorBody(body)).toBe("Too many today.");
  });

  it("returns null for a body that is not the envelope, so the caller can fall back", () => {
    expect(messageFromErrorBody("<html>502</html>")).toBeNull();
    expect(messageFromErrorBody(JSON.stringify({ nope: true }))).toBeNull();
  });
});

describe("parseApiError", () => {
  it("keeps the code and the details, which the envelope carries and the UI needs", () => {
    const body = JSON.stringify({
      error: {
        code: "rate_limited",
        message: "You have used all 60 meal analyses for today.",
        details: { limit: 60, used: 60, retry_after_seconds: 25_200 },
      },
    });
    expect(parseApiError(body)).toEqual({
      code: "rate_limited",
      message: "You have used all 60 meal analyses for today.",
      details: { limit: 60, used: 60, retry_after_seconds: 25_200 },
    });
  });

  it("survives an envelope with no code or details", () => {
    const body = JSON.stringify({ error: { message: "No such route." } });
    expect(parseApiError(body)).toEqual({
      code: "unknown",
      message: "No such route.",
      details: null,
    });
  });
});

describe("describeWait", () => {
  it.each([
    [5, "in a minute"],
    [90, "in a minute"],
    [600, "in about 10 minutes"],
    [3_600, "in about an hour"],
    [25_200, "in about 7 hours"],
    [90_000, "tomorrow"],
  ])("says %i seconds as %s", (seconds, expected) => {
    expect(describeWait(seconds)).toBe(expected);
  });
});

describe("firstAbortOf", () => {
  it("aborts when any one of its signals does", () => {
    const first = new AbortController();
    const second = new AbortController();
    const combined = firstAbortOf([first.signal, second.signal]);

    expect(combined.aborted).toBe(false);
    second.abort();
    expect(combined.aborted).toBe(true);
  });

  it("is already aborted when a signal it was given already was", () => {
    const gone = new AbortController();
    gone.abort();
    expect(firstAbortOf([gone.signal]).aborted).toBe(true);
  });
});

describe("requestParseMeal: what the phone is told when it fails", () => {
  beforeEach(() => {
    // Stubbed rather than read from .env: that file is gitignored, so a test that
    // depended on it would pass here and fail anywhere else.
    vi.stubEnv("VITE_PARSE_MEAL_URL", "https://meals.example.com/parse-meal");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const GOOD_BODY = {
    items: [],
    meal_type: "lunch",
    source: "text",
    model: "gemini-test",
    attempts: 1,
  };

  function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  }

  /** A fetch that never settles until its signal is aborted. */
  const hanging = (_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted.", "AbortError")),
      );
    });

  it("returns the validated reply when the service answers well", async () => {
    const result = await requestParseMeal(
      "token",
      {},
      { fetchImpl: async () => jsonResponse(GOOD_BODY) },
    );
    expect(result.model).toBe("gemini-test");
    expect(result.items).toEqual([]);
  });

  it("calls a request that never arrived unreachable, in words that are not the browser's", async () => {
    // This is the case that used to reach the screen as "Failed to fetch": a phone with
    // no signal, a service that is down, and a refused origin are indistinguishable
    // from inside a catch block, and none of the three is named by that message.
    const error = await requestParseMeal(
      "token",
      {},
      {
        fetchImpl: () => Promise.reject(new TypeError("Failed to fetch")),
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ParseFailure);
    expect((error as ParseFailure).kind).toBe("unreachable");
    const shown = describeParseFailure(error as ParseFailure);
    expect(shown).toContain("Could not reach the meal service");
    expect(shown).not.toContain("Failed to fetch");
  });

  it("ends a request that never answers, instead of spinning forever", async () => {
    const error = await requestParseMeal(
      "token",
      {},
      {
        fetchImpl: hanging as unknown as typeof fetch,
        timeoutMs: 20,
      },
    ).catch((caught: unknown) => caught);

    expect((error as ParseFailure).kind).toBe("timeout");
    expect(describeParseFailure(error as ParseFailure)).toContain("Nothing was logged");
  });

  it("reports the user's own cancel as a cancel, not as a failure of the service", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const error = await requestParseMeal(
      "token",
      {},
      {
        fetchImpl: hanging as unknown as typeof fetch,
        signal: controller.signal,
        timeoutMs: 5_000,
      },
    ).catch((caught: unknown) => caught);

    expect((error as ParseFailure).kind).toBe("cancelled");
    expect(describeParseFailure(error as ParseFailure)).toContain("cancelled");
  });

  it("carries the daily limit's reset time out of the envelope and into the sentence", async () => {
    const body = {
      error: {
        code: "rate_limited",
        message: "You have used all 60 meal analyses for today.",
        details: { limit: 60, used: 60, retry_after_seconds: 25_200 },
      },
    };
    const error = await requestParseMeal(
      "token",
      {},
      {
        fetchImpl: async () => jsonResponse(body, 429, { "Retry-After": "25200" }),
      },
    ).catch((caught: unknown) => caught);

    const failure = error as ParseFailure;
    expect(failure.kind).toBe("service");
    expect(failure.code).toBe("rate_limited");
    expect(failure.status).toBe(429);
    // Read from the header, which is what a browser can always see, rather than from
    // the body, which a CORS refusal would have hidden.
    expect(failure.retryAfterSeconds).toBe(25_200);

    const shown = describeParseFailure(failure);
    expect(shown).toContain("You have used all 60 meal analyses for today.");
    expect(shown).toContain("in about 7 hours");
    expect(shown).toContain("type a meal");
  });

  it("shows the service's own message for an ordinary failure, since it knows more", async () => {
    const body = {
      error: { code: "upstream_error", message: "The meal reader is busy at the moment." },
    };
    const error = await requestParseMeal(
      "token",
      {},
      {
        fetchImpl: async () => jsonResponse(body, 503),
      },
    ).catch((caught: unknown) => caught);

    expect(describeParseFailure(error as ParseFailure)).toBe(
      "The meal reader is busy at the moment.",
    );
  });

  it.each([
    ["a body that is not JSON", new Response("<html>502</html>", { status: 200 })],
    ["a reply of the wrong shape", jsonResponse({ items: "not an array" })],
  ])("reports %s as a service failure rather than crashing", async (_label, response) => {
    const error = await requestParseMeal(
      "token",
      {},
      {
        fetchImpl: async () => response,
      },
    ).catch((caught: unknown) => caught);
    expect((error as ParseFailure).kind).toBe("service");
  });

  it("still falls back to the status code when the service says nothing useful", async () => {
    const error = await requestParseMeal(
      "token",
      {},
      {
        fetchImpl: async () => new Response("<html>502</html>", { status: 502 }),
      },
    ).catch((caught: unknown) => caught);
    expect((error as ParseFailure).message).toContain("502");
  });
});

describe("toParseFailure", () => {
  it("keeps a plain error's message, which is already written for a person", () => {
    const failure = toParseFailure(new Error("Your session has expired. Sign in again."));
    expect(describeParseFailure(failure)).toBe("Your session has expired. Sign in again.");
  });

  it("passes a ParseFailure through untouched", () => {
    const original = new ParseFailure("timeout", "too slow");
    expect(toParseFailure(original)).toBe(original);
  });
});
