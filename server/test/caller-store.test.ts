/**
 * The caller store, against a fake Supabase client.
 *
 * The request-path tests use a fake *store*, so they cannot see a wrong column name —
 * which is exactly how `profiles` came to be queried by `id` when the table is keyed
 * by `user_id`. It returned a 502 the first time a real request went through. These
 * tests assert the queries themselves, against the shape the migrations create.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MEAL_PHOTO_BUCKET } from "../../shared/meal-parse";
import { createCallerStore } from "../src/caller-store";

interface Recorded {
  table: string | null;
  columns: string | null;
  filters: Array<[string, unknown]>;
  insert: unknown;
  bucket: string | null;
  downloadPath: string | null;
  head: boolean | null;
}

interface FakeOptions {
  /** What a `select` resolves to. */
  rows?: unknown;
  count?: number;
  timeZoneRow?: unknown;
  downloadBytes?: Uint8Array;
  error?: { message: string } | null;
}

function fakeClient(recorded: Recorded, options: FakeOptions = {}) {
  const filter = (column: string, value: unknown) => {
    recorded.filters.push([column, value]);
    return builder;
  };

  const builder: unknown = {
    select: (columns: string, selectOptions?: { count?: string; head?: boolean }) => {
      recorded.columns = columns;
      if (selectOptions?.head !== undefined) recorded.head = selectOptions.head;
      return builder;
    },
    eq: filter,
    gte: filter,
    maybeSingle: async () => ({
      data: options.timeZoneRow ?? null,
      error: options.error ?? null,
    }),
    insert: async (row: unknown) => {
      recorded.insert = row;
      return { error: options.error ?? null };
    },
    // `await builder` for the count query, which is not finished by maybeSingle.
    then: (resolve: (value: unknown) => unknown) =>
      resolve({ count: options.count ?? 0, data: options.rows ?? null, error: options.error ?? null }),
  };

  const client = {
    from: (table: string) => {
      recorded.table = table;
      return builder;
    },
    storage: {
      from: (bucket: string) => {
        recorded.bucket = bucket;
        return {
          download: async (path: string) => {
            recorded.downloadPath = path;
            if (options.error) return { data: null, error: options.error };
            const bytes = options.downloadBytes ?? new Uint8Array([65, 66, 67]);
            return { data: new Blob([bytes], { type: "image/jpeg" }), error: null };
          },
        };
      },
    },
  };

  return client as unknown as SupabaseClient;
}

function newRecording(): Recorded {
  return {
    table: null,
    columns: null,
    filters: [],
    insert: null,
    bucket: null,
    downloadPath: null,
    head: null,
  };
}

describe("countCallsSince", () => {
  it("counts llm_calls since the given instant, with a count-only request", async () => {
    const recorded = newRecording();
    const store = createCallerStore(fakeClient(recorded, { count: 7 }), "user-1");

    expect(await store.countCallsSince(new Date("2026-03-02T05:00:00.000Z"))).toBe(7);
    expect(recorded.table).toBe("llm_calls");
    expect(recorded.head).toBe(true);
    expect(recorded.filters).toEqual([["created_at", "2026-03-02T05:00:00.000Z"]]);
  });

  it("reports zero rather than null when Supabase returns no count", async () => {
    const store = createCallerStore(fakeClient(newRecording(), { count: undefined as never }), "u");
    expect(await store.countCallsSince(new Date())).toBe(0);
  });

  it("surfaces a query failure instead of silently allowing the call", async () => {
    const store = createCallerStore(
      fakeClient(newRecording(), { error: { message: "permission denied" } }),
      "u",
    );
    await expect(store.countCallsSince(new Date())).rejects.toThrow(/permission denied/);
  });
});

describe("recordCall", () => {
  it("writes the row the llm_calls table expects, with the caller's user_id", async () => {
    const recorded = newRecording();
    const store = createCallerStore(fakeClient(recorded), "user-1");

    await store.recordCall({
      model: "gemini-3.8-flash",
      promptTokens: 1154,
      completionTokens: 545,
      latencyMs: 6084,
      status: "ok",
    });

    expect(recorded.table).toBe("llm_calls");
    expect(recorded.insert).toEqual({
      user_id: "user-1",
      model: "gemini-3.8-flash",
      prompt_tokens: 1154,
      completion_tokens: 545,
      latency_ms: 6084,
      status: "ok",
    });
  });
});

describe("timeZone", () => {
  it("filters profiles by user_id, which is its primary key", async () => {
    const recorded = newRecording();
    const store = createCallerStore(fakeClient(recorded, { timeZoneRow: { timezone: "Europe/Berlin" } }), "user-1");

    expect(await store.timeZone()).toBe("Europe/Berlin");
    expect(recorded.table).toBe("profiles");
    expect(recorded.columns).toBe("timezone");
    // Not "id": profiles has no id column, and asking for one is a 502 at runtime.
    expect(recorded.filters).toEqual([["user_id", "user-1"]]);
  });

  it("falls back to UTC when the profile is missing", async () => {
    const store = createCallerStore(fakeClient(newRecording(), { timeZoneRow: null }), "user-1");
    expect(await store.timeZone()).toBe("UTC");
  });

  it("falls back to UTC when the stored zone is nonsense", async () => {
    const store = createCallerStore(
      fakeClient(newRecording(), { timeZoneRow: { timezone: "Mars/Olympus_Mons" } }),
      "user-1",
    );
    expect(await store.timeZone()).toBe("UTC");
  });
});

describe("loadPhotos", () => {
  it("reads from the bucket the capture sheet uploads to, path for path", async () => {
    const recorded = newRecording();
    const store = createCallerStore(fakeClient(recorded), "user-1");

    const photos = await store.loadPhotos(["user-1/abc.jpg", "user-1/def.jpg"]);

    expect(recorded.bucket).toBe(MEAL_PHOTO_BUCKET);
    expect(recorded.downloadPath).toBe("user-1/def.jpg");
    expect(photos).toHaveLength(2);
    expect(photos[0]).toEqual({ base64: "QUJD", mimeType: "image/jpeg" });
  });

  it("fails loudly when storage refuses, rather than sending a text-only request", async () => {
    const store = createCallerStore(
      fakeClient(newRecording(), { error: { message: "Object not found" } }),
      "user-1",
    );
    await expect(store.loadPhotos(["user-1/abc.jpg"])).rejects.toThrow(/Object not found/);
  });
});
