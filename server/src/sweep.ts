/**
 * The orphan-photo sweeper: the only thing in this repository that reads the
 * Supabase service role key.
 *
 * A capture uploads its photos before the meal is saved, because the model has to
 * read them. Anything that fails between the upload and the save — a crash, a
 * closed tab, a discard, a failed parse the user walks away from — leaves objects in
 * `meal-photos` that no `meals.photo_paths` names. The close-path cleanup in the
 * capture sheet handles the ordinary cases; this job is the backstop for the ones it
 * cannot reach.
 *
 * Two rules decide everything, and both are enforced in `planSweep` so the tests can
 * state them directly:
 *
 *   1. A referenced photo is never deleted, however old it is.
 *   2. An unreferenced photo is deleted only once it is provably older than the
 *      grace period. If its age cannot be established, it is kept.
 *
 * The service role is required here, not merely convenient. The reference set has to
 * be every meal in the database; read through RLS with the caller's token, the query
 * would return only that user's meals and the sweep would conclude that every other
 * user's photos are orphans and delete them. That is the one way this job can do real
 * damage, which is why the reference read fails loudly rather than returning a partial
 * answer.
 *
 * Deletion goes through the Storage API, never SQL: `protect_delete` blocks direct
 * deletes from `storage.objects`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { MEAL_PHOTO_BUCKET } from "../../shared/meal-parse";
import { log as writeLog, type LogFields } from "./log";

/** How old an unreferenced object must be before it is considered abandoned. */
export const SWEEP_MIN_AGE_HOURS = 24;

/** The Storage API takes an array of paths; this keeps one call modest. */
const DELETE_BATCH = 100;

/** Storage `list` returns at most 1000 entries per call. */
const LIST_PAGE = 1000;

/** PostgREST caps a select at 1000 rows, so the reference read pages too. */
const ROW_PAGE = 1000;

/** Paths are `<user_id>/<photo_id>.jpg`; the guard is for anything older or odd. */
const MAX_DEPTH = 3;

/** Bound on per-path log lines, so one strange run cannot flood the log. */
const MAX_LOGGED_PATHS = 200;

export interface StoredObject {
  path: string;
  /** Null when the API did not report it. An unknown age is never deleted. */
  createdAt: Date | null;
}

export interface SweepPlan {
  /** Old, unreferenced, and the only thing this job will ever remove. */
  deletePaths: string[];
  /** Named by a meal. Never touched, however old. */
  keepReferenced: string[];
  /** Unreferenced but younger than the grace period — a capture may be in progress. */
  keepTooNew: string[];
  /** Unreferenced, but with no readable timestamp, so its age is unprovable. */
  keepAgeUnknown: string[];
}

export interface SweepPlanInput {
  objects: readonly StoredObject[];
  referenced: ReadonlySet<string>;
  now: Date;
  minAgeHours?: number;
}

/**
 * Decide what to delete. Pure, and deliberately the only place the rules live.
 *
 * The order of the tests is the order of their authority: a reference outranks
 * everything, then an unprovable age, then the grace period. Only what survives all
 * three is deleted.
 */
export function planSweep(input: SweepPlanInput): SweepPlan {
  const now = input.now.getTime();
  const cutoff = now - (input.minAgeHours ?? SWEEP_MIN_AGE_HOURS) * 60 * 60 * 1000;

  const plan: SweepPlan = {
    deletePaths: [],
    keepReferenced: [],
    keepTooNew: [],
    keepAgeUnknown: [],
  };

  for (const object of input.objects) {
    if (input.referenced.has(object.path)) {
      plan.keepReferenced.push(object.path);
      continue;
    }
    if (object.createdAt === null) {
      plan.keepAgeUnknown.push(object.path);
      continue;
    }
    if (object.createdAt.getTime() >= cutoff) {
      plan.keepTooNew.push(object.path);
      continue;
    }
    plan.deletePaths.push(object.path);
  }

  return plan;
}

export interface SweepStore {
  /** Every object in the bucket, oldest and newest alike. */
  listObjects(): Promise<StoredObject[]>;
  /** Every path named by any meal in the database, for every user. */
  referencedPaths(): Promise<Set<string>>;
  /** Removes through the Storage API. Returns the paths the API reports as gone. */
  removeObjects(paths: readonly string[]): Promise<string[]>;
}

/**
 * The shape `storage.list` returns, narrowed to what we use. A folder entry has a
 * null `id`; a file entry has one.
 */
const fileEntrySchema = z.object({
  name: z.string(),
  id: z.string().nullable(),
  created_at: z.string().nullable(),
});

const photoPathsRowSchema = z.object({
  photo_paths: z.array(z.string()).nullable(),
});

export function createSweepStore(client: SupabaseClient): SweepStore {
  const bucket = client.storage.from(MEAL_PHOTO_BUCKET);

  function fail(operation: string, message: string): never {
    throw new Error(`Supabase ${operation} failed: ${message}`);
  }

  /**
   * Walks the bucket depth-first. Listing is per-prefix, so one call per user folder;
   * recursion rather than a fixed two-level loop, so an object stored under a deeper
   * path by some older code is still seen. Anything not seen is not deleted, so the
   * cost of missing one is a leftover, never a loss.
   */
  async function walk(prefix: string, depth: number, found: StoredObject[]): Promise<void> {
    for (let offset = 0; ; offset += LIST_PAGE) {
      const { data, error } = await bucket.list(prefix, {
        limit: LIST_PAGE,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) fail(`storage list of "${prefix || "/"}"`, error.message);

      const parsed = z.array(fileEntrySchema).safeParse(data ?? []);
      if (!parsed.success) {
        fail(
          `storage list of "${prefix || "/"}"`,
          `unexpected entry shape: ${parsed.error.message}`,
        );
      }

      const entries = parsed.data;
      for (const entry of entries) {
        const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.id === null) {
          if (depth < MAX_DEPTH) await walk(path, depth + 1, found);
          continue;
        }
        found.push({
          path,
          createdAt: entry.created_at === null ? null : new Date(entry.created_at),
        });
      }

      if (entries.length < LIST_PAGE) return;
    }
  }

  return {
    async listObjects() {
      const found: StoredObject[] = [];
      await walk("", 0, found);
      // A nil date survives as an invalid Date if the string was unparseable, and
      // `planSweep` treats that as an unknown age. Normalise it here so the rule is
      // about one thing.
      return found.map((object) => ({
        path: object.path,
        createdAt:
          object.createdAt !== null && Number.isNaN(object.createdAt.getTime())
            ? null
            : object.createdAt,
      }));
    },

    async referencedPaths() {
      const referenced = new Set<string>();

      // No user_id filter, and none is possible: this is every meal, everywhere.
      // RLS is bypassed because the client is built with the service role key.
      for (let offset = 0; ; offset += ROW_PAGE) {
        const { data, error } = await client
          .from("meals")
          .select("photo_paths")
          .order("id", { ascending: true })
          .range(offset, offset + ROW_PAGE - 1);
        if (error) fail("meals select of photo_paths", error.message);

        const parsed = z.array(photoPathsRowSchema).safeParse(data ?? []);
        if (!parsed.success) {
          fail("meals select of photo_paths", `unexpected row shape: ${parsed.error.message}`);
        }

        const rows = parsed.data;
        for (const row of rows) {
          for (const path of row.photo_paths ?? []) referenced.add(path);
        }

        if (rows.length < ROW_PAGE) return referenced;
      }
    },

    async removeObjects(paths) {
      const removed: string[] = [];
      for (let index = 0; index < paths.length; index += DELETE_BATCH) {
        const batch = paths.slice(index, index + DELETE_BATCH);
        const { data, error } = await bucket.remove([...batch]);
        if (error) fail(`storage remove of ${batch.length} object(s)`, error.message);
        for (const object of data ?? []) {
          if (object !== null && typeof object.name === "string") removed.push(object.name);
        }
      }
      return removed;
    },
  };
}

export type SweepLog = (
  level: "info" | "warn" | "error",
  message: string,
  fields?: LogFields,
) => void;

export interface SweepOptions {
  /** True means report and delete nothing. The default everywhere. */
  dryRun: boolean;
  now?: Date;
  minAgeHours?: number;
  log?: SweepLog;
}

export interface SweepResult {
  dryRun: boolean;
  scanned: number;
  referenced: number;
  plan: SweepPlan;
  /** What the Storage API reported as removed. Always empty in a dry run. */
  removed: string[];
}

/**
 * Run one sweep.
 *
 * The reference set is read before anything is deleted, and a failure to read it
 * throws: a partial reference set is more dangerous than no sweep at all, because it
 * makes referenced photos look like orphans.
 */
export async function sweep(store: SweepStore, options: SweepOptions): Promise<SweepResult> {
  const log: SweepLog = options.log ?? writeLog;
  const now = options.now ?? new Date();
  const minAgeHours = options.minAgeHours ?? SWEEP_MIN_AGE_HOURS;

  const objects = await store.listObjects();
  const referenced = await store.referencedPaths();
  const plan = planSweep({ objects, referenced, now, minAgeHours });

  log("info", "sweep scanned", {
    objects: objects.length,
    referencedPaths: referenced.size,
    deletable: plan.deletePaths.length,
    keptReferenced: plan.keepReferenced.length,
    keptTooNew: plan.keepTooNew.length,
    keptAgeUnknown: plan.keepAgeUnknown.length,
    minAgeHours,
    dryRun: options.dryRun,
  });

  if (plan.keepAgeUnknown.length > 0) {
    // Worth a warning rather than a count: it means the API stopped reporting
    // timestamps and the sweep has quietly stopped being able to clean up.
    log("warn", "unreferenced objects with no readable timestamp were kept", {
      count: plan.keepAgeUnknown.length,
      sample: plan.keepAgeUnknown.slice(0, 5).join(","),
    });
  }

  for (const path of plan.deletePaths.slice(0, MAX_LOGGED_PATHS)) {
    log("info", options.dryRun ? "would delete" : "deleting", { path });
  }
  if (plan.deletePaths.length > MAX_LOGGED_PATHS) {
    log("info", "further paths not logged individually", {
      remaining: plan.deletePaths.length - MAX_LOGGED_PATHS,
    });
  }

  if (options.dryRun) {
    log("info", "dry run: nothing deleted", {
      wouldDelete: plan.deletePaths.length,
      hint: "set SWEEP_DRY_RUN=false, or pass --live, to delete",
    });
    return {
      dryRun: true,
      scanned: objects.length,
      referenced: referenced.size,
      plan,
      removed: [],
    };
  }

  const removed = await store.removeObjects(plan.deletePaths);
  log("info", "sweep removed", { requested: plan.deletePaths.length, removed: removed.length });

  return {
    dryRun: false,
    scanned: objects.length,
    referenced: referenced.size,
    plan,
    removed,
  };
}

export interface SweepArgs {
  /** Null when the command line said nothing, leaving the environment to decide. */
  dryRunFlag: boolean | null;
  minAgeHours: number;
  help: boolean;
}

export function parseSweepArgs(argv: readonly string[]): SweepArgs {
  let dryRunFlag: boolean | null = null;
  let minAgeHours = SWEEP_MIN_AGE_HOURS;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inlineValue = equals === -1 ? null : arg.slice(equals + 1);

    switch (name) {
      case "--live":
        dryRunFlag = false;
        break;
      case "--dry-run":
        dryRunFlag = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      case "--older-than-hours": {
        const raw = inlineValue ?? argv[index + 1];
        if (raw === undefined) throw new Error("--older-than-hours needs a number of hours");
        if (inlineValue === null) index += 1;
        const hours = Number(raw);
        if (!Number.isFinite(hours) || hours < 1) {
          throw new Error(
            `--older-than-hours must be a number of hours, at least 1 (got "${raw}")`,
          );
        }
        minAgeHours = hours;
        break;
      }
      default:
        throw new Error(`Unknown argument "${arg}". Try --help.`);
    }
  }

  return { dryRunFlag, minAgeHours, help };
}

/**
 * Dry run unless something says otherwise, and the command line outranks the
 * environment so a manual `--live` does not need a deploy.
 *
 * A malformed value throws rather than being guessed at: if `SWEEP_DRY_RUN` is
 * misspelled the job must stop, not pick a default that deletes things.
 */
export function resolveDryRun(dryRunFlag: boolean | null, envValue: string | undefined): boolean {
  if (dryRunFlag !== null) return dryRunFlag;
  if (envValue === undefined || envValue.trim() === "") return true;

  const normalised = envValue.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalised)) return true;
  if (["false", "0", "no", "off"].includes(normalised)) return false;

  throw new Error(
    `SWEEP_DRY_RUN must be true or false (got "${envValue}"). Refusing to guess: an unrecognised value defaults to nothing, and the wrong guess here deletes photos.`,
  );
}

export const SWEEP_USAGE = `Usage: npm run sweep [-- <options>]

Deletes objects in the "${MEAL_PHOTO_BUCKET}" bucket that are older than the grace
period and that no meals.photo_paths names. Referenced photos are never touched.

  --dry-run              Report what would be deleted and delete nothing. Default.
  --live                 Actually delete. Same as SWEEP_DRY_RUN=false.
  --older-than-hours N   Change the grace period from ${SWEEP_MIN_AGE_HOURS}h. For a manual
                         investigation; the deployed job uses the default.
  -h, --help             This text.

Precedence: the command line, then SWEEP_DRY_RUN, then a dry run.`;
