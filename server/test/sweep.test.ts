/**
 * The sweeper's rules, tested against a fake store.
 *
 * The point of these tests is not coverage. It is that two sentences are true and
 * stay true:
 *
 *   - a photo a meal references is never deleted,
 *   - a photo that cannot be proven old enough is never deleted.
 *
 * Both are properties of a pure function, so they can be tested exhaustively rather
 * than sampled, and no test in this file touches the network or the service role key.
 */
import { describe, expect, it, vi } from "vitest";
import {
  SWEEP_MIN_AGE_HOURS,
  createSweepStore,
  parseSweepArgs,
  planSweep,
  resolveDryRun,
  sweep,
  type StoredObject,
  type SweepLog,
  type SweepStore,
} from "../src/sweep";

const NOW = new Date("2026-09-11T04:00:00.000Z");

/** `hoursAgo` is relative to NOW, so the fixtures read as ages rather than dates. */
function objectAt(path: string, hoursAgo: number | null): StoredObject {
  return {
    path,
    createdAt: hoursAgo === null ? null : new Date(NOW.getTime() - hoursAgo * 3_600_000),
  };
}

describe("planSweep", () => {
  it("deletes an unreferenced object older than the grace period", () => {
    const plan = planSweep({
      objects: [objectAt("u1/orphan.jpg", 25)],
      referenced: new Set(),
      now: NOW,
    });

    expect(plan.deletePaths).toEqual(["u1/orphan.jpg"]);
  });

  it("keeps a referenced object however old it is", () => {
    const plan = planSweep({
      objects: [objectAt("u1/kept.jpg", 24 * 365)],
      referenced: new Set(["u1/kept.jpg"]),
      now: NOW,
    });

    expect(plan.deletePaths).toEqual([]);
    expect(plan.keepReferenced).toEqual(["u1/kept.jpg"]);
  });

  it("keeps an unreferenced object inside the grace period", () => {
    const plan = planSweep({
      objects: [objectAt("u1/inflight.jpg", 23.5)],
      referenced: new Set(),
      now: NOW,
    });

    expect(plan.deletePaths).toEqual([]);
    expect(plan.keepTooNew).toEqual(["u1/inflight.jpg"]);
  });

  it("keeps an object whose age it cannot establish", () => {
    // The failure that matters: a missing timestamp must read as "do not know",
    // never as "old enough".
    const plan = planSweep({
      objects: [objectAt("u1/unknown.jpg", null)],
      referenced: new Set(),
      now: NOW,
    });

    expect(plan.deletePaths).toEqual([]);
    expect(plan.keepAgeUnknown).toEqual(["u1/unknown.jpg"]);
  });

  it("treats a reference as outranking an unprovable age", () => {
    const plan = planSweep({
      objects: [objectAt("u1/both.jpg", null)],
      referenced: new Set(["u1/both.jpg"]),
      now: NOW,
    });

    expect(plan.keepReferenced).toEqual(["u1/both.jpg"]);
    expect(plan.keepAgeUnknown).toEqual([]);
  });

  it("is exactly on the boundary at the grace period", () => {
    const plan = planSweep({
      objects: [objectAt("u1/edge.jpg", SWEEP_MIN_AGE_HOURS)],
      referenced: new Set(),
      now: NOW,
    });

    // At the boundary the object is not *older* than the period, so it survives.
    expect(plan.deletePaths).toEqual([]);
    expect(plan.keepTooNew).toEqual(["u1/edge.jpg"]);
  });

  it("sorts a mixed bucket into the four outcomes without loss", () => {
    const plan = planSweep({
      objects: [
        objectAt("u1/referenced-old.jpg", 100),
        objectAt("u1/orphan-old.jpg", 100),
        objectAt("u1/orphan-old-2.jpg", 48),
        objectAt("u1/fresh.jpg", 2),
        objectAt("u2/dateless.jpg", null),
      ],
      referenced: new Set(["u1/referenced-old.jpg"]),
      now: NOW,
    });

    expect(plan.deletePaths).toEqual(["u1/orphan-old.jpg", "u1/orphan-old-2.jpg"]);
    expect(plan.keepReferenced).toEqual(["u1/referenced-old.jpg"]);
    expect(plan.keepTooNew).toEqual(["u1/fresh.jpg"]);
    expect(plan.keepAgeUnknown).toEqual(["u2/dateless.jpg"]);
  });

  it("honours a longer grace period", () => {
    const plan = planSweep({
      objects: [objectAt("u1/week-old.jpg", 24 * 3)],
      referenced: new Set(),
      now: NOW,
      minAgeHours: 24 * 7,
    });

    expect(plan.deletePaths).toEqual([]);
  });

  it("deletes nothing from an empty bucket", () => {
    const plan = planSweep({ objects: [], referenced: new Set(), now: NOW });
    expect(plan).toEqual({
      deletePaths: [],
      keepReferenced: [],
      keepTooNew: [],
      keepAgeUnknown: [],
    });
  });
});

interface FakeStoreState {
  objects: StoredObject[];
  referenced: Set<string>;
  removed: string[];
  listError?: Error;
  referenceError?: Error;
}

function fakeStore(state: FakeStoreState): SweepStore {
  return {
    listObjects: async () => {
      if (state.listError) throw state.listError;
      return state.objects;
    },
    referencedPaths: async () => {
      if (state.referenceError) throw state.referenceError;
      return state.referenced;
    },
    removeObjects: async (paths) => {
      state.removed.push(...paths);
      return [...paths];
    },
  };
}

function silent(): SweepLog {
  return () => {};
}

describe("sweep", () => {
  it("deletes nothing in a dry run, and reports what it would have deleted", async () => {
    const state: FakeStoreState = {
      objects: [objectAt("u1/orphan.jpg", 100)],
      referenced: new Set(),
      removed: [],
    };

    const result = await sweep(fakeStore(state), { dryRun: true, now: NOW, log: silent() });

    expect(state.removed).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.plan.deletePaths).toEqual(["u1/orphan.jpg"]);
    expect(result.dryRun).toBe(true);
  });

  it("deletes only the orphans when live", async () => {
    const state: FakeStoreState = {
      objects: [
        objectAt("u1/kept.jpg", 100),
        objectAt("u1/orphan.jpg", 100),
        objectAt("u1/fresh.jpg", 1),
      ],
      referenced: new Set(["u1/kept.jpg"]),
      removed: [],
    };

    const result = await sweep(fakeStore(state), { dryRun: false, now: NOW, log: silent() });

    expect(state.removed).toEqual(["u1/orphan.jpg"]);
    expect(result.removed).toEqual(["u1/orphan.jpg"]);
    expect(result.scanned).toBe(3);
    expect(result.referenced).toBe(1);
  });

  it("deletes nothing at all when the reference set cannot be read", async () => {
    // The dangerous failure: a partial or missing reference set makes other people's
    // photos look like orphans. The sweep must abort before removing anything.
    const state: FakeStoreState = {
      objects: [objectAt("u1/actually-referenced.jpg", 100)],
      referenced: new Set(),
      removed: [],
      referenceError: new Error("Supabase meals select of photo_paths failed: timeout"),
    };

    await expect(sweep(fakeStore(state), { dryRun: false, now: NOW })).rejects.toThrow(
      /photo_paths failed/,
    );
    expect(state.removed).toEqual([]);
  });

  it("deletes nothing when the bucket cannot be listed", async () => {
    const state: FakeStoreState = {
      objects: [],
      referenced: new Set(),
      removed: [],
      listError: new Error("Supabase storage list failed: 503"),
    };

    await expect(sweep(fakeStore(state), { dryRun: false, now: NOW })).rejects.toThrow(/503/);
    expect(state.removed).toEqual([]);
  });

  it("warns when it had to keep objects of unknown age", async () => {
    const state: FakeStoreState = {
      objects: [objectAt("u1/dateless.jpg", null)],
      referenced: new Set(),
      removed: [],
    };
    const log = vi.fn();

    await sweep(fakeStore(state), { dryRun: false, now: NOW, log });

    expect(log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("no readable timestamp"),
      expect.objectContaining({ count: 1 }),
    );
  });

  it("names each path it would delete, so a dry run is reviewable", async () => {
    const state: FakeStoreState = {
      objects: [objectAt("u1/a.jpg", 100), objectAt("u1/b.jpg", 100)],
      referenced: new Set(),
      removed: [],
    };
    const log = vi.fn();

    await sweep(fakeStore(state), { dryRun: true, now: NOW, log });

    const named = log.mock.calls
      .filter((call) => call[1] === "would delete")
      .map((call) => (call[2] as { path: string }).path);
    expect(named).toEqual(["u1/a.jpg", "u1/b.jpg"]);
  });

  it("says 'deleting' rather than 'would delete' when live", async () => {
    const state: FakeStoreState = {
      objects: [objectAt("u1/a.jpg", 100)],
      referenced: new Set(),
      removed: [],
    };
    const log = vi.fn();

    await sweep(fakeStore(state), { dryRun: false, now: NOW, log });

    const messages = log.mock.calls.map((call) => call[1]);
    expect(messages).toContain("deleting");
    expect(messages).not.toContain("would delete");
  });
});

describe("resolveDryRun", () => {
  it("defaults to a dry run when nothing says otherwise", () => {
    expect(resolveDryRun(null, undefined)).toBe(true);
    expect(resolveDryRun(null, "")).toBe(true);
    expect(resolveDryRun(null, "   ")).toBe(true);
  });

  it("reads the environment value", () => {
    expect(resolveDryRun(null, "false")).toBe(false);
    expect(resolveDryRun(null, "FALSE")).toBe(false);
    expect(resolveDryRun(null, "0")).toBe(false);
    expect(resolveDryRun(null, "true")).toBe(true);
  });

  it("lets the command line outrank the environment", () => {
    // Which is what makes `npm run sweep:live` work locally without editing .env, and
    // `--dry-run` work against a service that has been flipped live.
    expect(resolveDryRun(false, "true")).toBe(false);
    expect(resolveDryRun(true, "false")).toBe(true);
  });

  it("refuses to guess at anything it does not recognise", () => {
    // A typo must stop the job. Guessing here is what would delete photos.
    expect(() => resolveDryRun(null, "flase")).toThrow(/SWEEP_DRY_RUN/);
    expect(() => resolveDryRun(null, "yes please")).toThrow(/Refusing to guess/);
  });
});

describe("parseSweepArgs", () => {
  it("reports silence rather than a default, so the environment can decide", () => {
    expect(parseSweepArgs([])).toEqual({
      dryRunFlag: null,
      minAgeHours: SWEEP_MIN_AGE_HOURS,
      help: false,
    });
  });

  it("accepts both spellings of the switch", () => {
    expect(parseSweepArgs(["--live"]).dryRunFlag).toBe(false);
    expect(parseSweepArgs(["--dry-run"]).dryRunFlag).toBe(true);
  });

  it("takes the grace period with a space or an equals", () => {
    expect(parseSweepArgs(["--older-than-hours", "48"]).minAgeHours).toBe(48);
    expect(parseSweepArgs(["--older-than-hours=48"]).minAgeHours).toBe(48);
  });

  it("rejects a grace period that is not a sensible number of hours", () => {
    expect(() => parseSweepArgs(["--older-than-hours"])).toThrow(/needs a number/);
    expect(() => parseSweepArgs(["--older-than-hours", "soon"])).toThrow(/at least 1/);
    expect(() => parseSweepArgs(["--older-than-hours", "0"])).toThrow(/at least 1/);
    expect(() => parseSweepArgs(["--older-than-hours", "-5"])).toThrow(/at least 1/);
  });

  it("refuses an argument it does not understand", () => {
    expect(() => parseSweepArgs(["--destroy-everything"])).toThrow(/Unknown argument/);
  });

  it("recognises a request for help", () => {
    expect(parseSweepArgs(["--help"]).help).toBe(true);
    expect(parseSweepArgs(["-h"]).help).toBe(true);
  });
});

describe("createSweepStore", () => {
  /**
   * The store is where the one unscoped query lives, so its shape is worth asserting:
   * no `user_id` filter, and both keys sent.
   */
  it("reads every meal, not one user's, and sends both keys", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const rows: { photo_paths: string[] | null }[] = [
      { photo_paths: ["u1/a.jpg", "u1/b.jpg"] },
      { photo_paths: null },
      { photo_paths: [] },
      { photo_paths: ["u2/c.jpg"] },
    ];

    const client = {
      from: () => ({
        select: () => ({
          order: () => ({
            range: async () => ({ data: rows, error: null }),
          }),
        }),
      }),
      storage: {
        from: () => ({
          list: async () => ({ data: [], error: null }),
          remove: async () => ({ data: [], error: null }),
        }),
      },
    } as never;

    const store = createSweepStore(client);
    const referenced = await store.referencedPaths();

    expect([...referenced].sort()).toEqual(["u1/a.jpg", "u1/b.jpg", "u2/c.jpg"]);
    expect(calls).toEqual([]);
  });

  it("walks nested folders and keeps the full path", async () => {
    const tree: Record<string, { name: string; id: string | null; created_at: string | null }[]> = {
      "": [{ name: "u1", id: null, created_at: null }],
      u1: [{ name: "photo.jpg", id: "abc", created_at: "2026-09-01T00:00:00.000Z" }],
    };

    const client = {
      storage: {
        from: () => ({
          list: async (prefix: string) => ({ data: tree[prefix] ?? [], error: null }),
        }),
      },
    } as never;

    const objects = await createSweepStore(client).listObjects();

    expect(objects.map((object) => object.path)).toEqual(["u1/photo.jpg"]);
    expect(objects[0]?.createdAt?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("reports a missing timestamp as null rather than as now", async () => {
    const client = {
      storage: {
        from: () => ({
          list: async (prefix: string) => ({
            data:
              prefix === ""
                ? [{ name: "u1", id: null, created_at: null }]
                : [{ name: "photo.jpg", id: "abc", created_at: null }],
            error: null,
          }),
        }),
      },
    } as never;

    const objects = await createSweepStore(client).listObjects();

    // Null, not a Date: an object with no timestamp must read as unknown age, and
    // `null` is the only value `planSweep` treats that way.
    expect(objects).toEqual([{ path: "u1/photo.jpg", createdAt: null }]);
  });

  it("treats an unparseable timestamp as unknown rather than as 1970", async () => {
    const client = {
      storage: {
        from: () => ({
          list: async (prefix: string) => ({
            data:
              prefix === ""
                ? [{ name: "u1", id: null, created_at: null }]
                : [{ name: "photo.jpg", id: "abc", created_at: "not a date" }],
            error: null,
          }),
        }),
      },
    } as never;

    const objects = await createSweepStore(client).listObjects();

    expect(objects).toEqual([{ path: "u1/photo.jpg", createdAt: null }]);
  });

  it("surfaces a storage error instead of returning a short list", async () => {
    const client = {
      storage: {
        from: () => ({
          list: async () => ({ data: null, error: { message: "bucket not found" } }),
        }),
      },
    } as never;

    await expect(createSweepStore(client).listObjects()).rejects.toThrow(/bucket not found/);
  });

  it("surfaces a reference error instead of returning a short set", async () => {
    const client = {
      from: () => ({
        select: () => ({
          order: () => ({
            range: async () => ({ data: null, error: { message: "permission denied" } }),
          }),
        }),
      }),
      storage: {
        from: () => ({
          list: async () => ({ data: [], error: null }),
          remove: async () => ({ data: [], error: null }),
        }),
      },
    } as never;

    await expect(createSweepStore(client).referencedPaths()).rejects.toThrow(/permission denied/);
  });
});
