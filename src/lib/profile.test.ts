import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCurrentTarget,
  localDateString,
  saveFailureDetail,
  saveProfileWithTargets,
  type Profile,
  type ProfileInsert,
} from "./profile";

interface TableRecorder {
  calls: Record<string, unknown[]>;
  upserts: unknown[];
  maybeSingleResult: { data: unknown; error: unknown };
  singleResult: { data: unknown; error: unknown };
  writeResult: { data: unknown; error: unknown };
}

const { fromMock, tableFor, resetHarness } = vi.hoisted(() => {
  const store = new Map<string, TableRecorder>();
  const get = (name: string): TableRecorder => {
    let table = store.get(name);
    if (!table) {
      table = {
        calls: {},
        upserts: [],
        maybeSingleResult: { data: null, error: null },
        singleResult: { data: null, error: null },
        writeResult: { data: null, error: null },
      };
      store.set(name, table);
    }
    return table;
  };

  const from = vi.fn((name: string) => {
    const table = get(name);
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "lte", "order", "limit", "update", "insert"]) {
      chain[method] = (...args: unknown[]) => {
        table.calls[method] = args;
        return chain;
      };
    }
    chain["upsert"] = (values: unknown, options?: unknown) => {
      table.calls["upsert"] = [values, options];
      table.upserts.push(values);
      return chain;
    };
    chain["maybeSingle"] = () => Promise.resolve(table.maybeSingleResult);
    chain["single"] = () => Promise.resolve(table.singleResult);
    // Lets `await supabase.from(t).upsert(...)` resolve without a .select().
    chain["then"] = (resolve: (value: unknown) => unknown) => resolve(table.writeResult);
    return chain;
  });

  return { fromMock: from, tableFor: get, resetHarness: () => store.clear() };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: fromMock, rpc: vi.fn() },
}));

/** 11:30 UTC is already the next day in Auckland (UTC+13) but still the 1st in Los Angeles (UTC-8). */
const LATE_EVENING_INSTANT = new Date("2026-03-01T11:30:00Z");

function storedProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    user_id: "user-1",
    display_name: "Ada",
    dob: "1994-01-01",
    sex: "female",
    height_cm: 165,
    weight_kg: 70,
    activity_level: "moderately_active",
    goal: "lose",
    target_weight_kg: 65,
    pace_kg_per_week: 0.5,
    protein_g_per_kg: 1.6,
    fat_share: 0.3,
    fiber_target_g: 30,
    units: "metric",
    timezone: "UTC",
    reminder_time: null,
    dietary_tags: [],
    created_at: "2026-03-01T00:00:00Z",
    updated_at: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}

function profileInsert(overrides: Partial<ProfileInsert> = {}): ProfileInsert {
  return {
    user_id: "user-1",
    display_name: "Ada",
    dob: "1994-01-01",
    sex: "female",
    height_cm: 165,
    weight_kg: 70,
    activity_level: "moderately_active",
    goal: "lose",
    target_weight_kg: 65,
    pace_kg_per_week: 0.5,
    protein_g_per_kg: 1.6,
    fat_share: 0.3,
    fiber_target_g: 30,
    units: "metric",
    timezone: "UTC",
    reminder_time: null,
    dietary_tags: [],
    ...overrides,
  };
}

/**
 * Points the mocked clients at a successful profile/target save.
 *
 * `saved` is what the upsert returns; `previouslyStoredWeightKg` is what the
 * pre-flight profile read finds (null when there is no profile row yet, which is
 * the onboarding case).
 */
function arrangeSuccessfulSave(saved: Profile, previouslyStoredWeightKg: number | null) {
  tableFor("profiles").maybeSingleResult = {
    data: previouslyStoredWeightKg === null ? null : { weight_kg: previouslyStoredWeightKg },
    error: null,
  };
  tableFor("profiles").singleResult = { data: saved, error: null };
  tableFor("targets").singleResult = { data: { id: "t1" }, error: null };
}

beforeEach(() => {
  resetHarness();
  vi.clearAllMocks();
});

describe("localDateString", () => {
  it("resolves one instant to different calendar days in different zones", () => {
    expect(localDateString("Pacific/Auckland", LATE_EVENING_INSTANT)).toBe("2026-03-02");
    expect(localDateString("America/Los_Angeles", LATE_EVENING_INSTANT)).toBe("2026-03-01");
  });

  it("turns over at the profile's midnight, to the minute", () => {
    // 15:00 UTC is midnight in Tokyo, and this is the input that decides which day the dashboard
    // and Trends ask about. One minute earlier the window still ends on the same day; one minute
    // later it has moved on, and with it the seven complete days behind it.
    expect(localDateString("Asia/Tokyo", new Date("2026-11-07T14:59:00Z"))).toBe("2026-11-07");
    expect(localDateString("Asia/Tokyo", new Date("2026-11-07T15:00:00Z"))).toBe("2026-11-08");
    // The second instant is still 7 November in New York, so a New York profile asks about the same
    // day a minute later than a Tokyo one does. Two profiles, one instant, two windows.
    expect(localDateString("America/New_York", new Date("2026-11-07T15:00:00Z"))).toBe(
      "2026-11-07",
    );
  });
});

describe("fetchCurrentTarget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(LATE_EVENING_INSTANT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves the day boundary in the profile zone, not the device zone", async () => {
    await fetchCurrentTarget("user-1", "Pacific/Auckland");

    // The device zone would have said 2026-03-01; the profile zone is a day ahead.
    expect(tableFor("targets").calls["eq"]).toEqual(["user_id", "user-1"]);
    expect(tableFor("targets").calls["lte"]).toEqual(["effective_from", "2026-03-02"]);
  });
});

describe("saveProfileWithTargets — weight history", () => {
  it("leaves the weight log alone when a settings save does not change the weight", async () => {
    // Previously stored weight is 70; the incoming weight is also 70.
    arrangeSuccessfulSave(storedProfile({ weight_kg: 70 }), 70);

    await saveProfileWithTargets(profileInsert({ weight_kg: 70 }));

    expect(tableFor("weight_log").upserts).toHaveLength(0);
  });

  it("writes the weight log when the weight actually changed", async () => {
    arrangeSuccessfulSave(storedProfile({ weight_kg: 71 }), 70);

    await saveProfileWithTargets(profileInsert({ weight_kg: 71 }));

    expect(tableFor("weight_log").upserts).toHaveLength(1);
    expect(tableFor("weight_log").upserts[0]).toMatchObject({
      user_id: "user-1",
      weight_kg: 71,
      source: "manual",
    });
  });

  it("seeds the weight log on onboarding even when the stored weight matches", async () => {
    arrangeSuccessfulSave(storedProfile({ weight_kg: 70 }), 70);

    await saveProfileWithTargets(profileInsert({ weight_kg: 70 }), { seedWeight: true });

    expect(tableFor("weight_log").upserts).toHaveLength(1);
  });

  it("seeds the weight log on the first onboarding save, when no profile row exists yet", async () => {
    arrangeSuccessfulSave(storedProfile({ weight_kg: 70 }), null);

    await saveProfileWithTargets(profileInsert({ weight_kg: 70 }));

    expect(tableFor("weight_log").upserts).toHaveLength(1);
  });

  it("surfaces a failed weight log write instead of swallowing it", async () => {
    arrangeSuccessfulSave(storedProfile({ weight_kg: 71 }), 70);
    tableFor("weight_log").writeResult = { data: null, error: new Error("weight_log down") };

    await expect(saveProfileWithTargets(profileInsert({ weight_kg: 71 }))).rejects.toThrow(
      "weight_log down",
    );
  });
});

/**
 * The sentence under a failed save.
 *
 * The first case is the shape measured against this project's API with the publishable key: a
 * refused request comes back as a plain object, `instanceof Error` is false, and the form's old
 * check printed its generic sentence instead of the code. The second is the failure that cost a
 * production save during the fat_share deploy.
 */
describe("saveFailureDetail", () => {
  it("reads a PostgREST failure object, code and hint included", () => {
    const refusal = {
      code: "42501",
      message: "permission denied for table profiles",
      details: null,
      hint: "Grant the required privileges to the current role with: GRANT SELECT ON public.profiles TO anon;",
    };
    expect(refusal instanceof Error).toBe(false);
    expect(saveFailureDetail(refusal)).toBe(
      "permission denied for table profiles (42501) Grant the required privileges to the current role with: GRANT SELECT ON public.profiles TO anon;",
    );
  });

  it("names the schema-cache miss the fat share deploy produced", () => {
    expect(
      saveFailureDetail({
        code: "PGRST204",
        message: "Could not find the 'fat_share' column of 'profiles' in the schema cache",
        details: null,
        hint: null,
      }),
    ).toBe("Could not find the 'fat_share' column of 'profiles' in the schema cache (PGRST204)");
  });

  it("still reads a real Error, which carries a message but no code", () => {
    expect(saveFailureDetail(new TypeError("Failed to fetch"))).toBe("Failed to fetch");
    expect(saveFailureDetail("connection lost")).toBe("connection lost");
  });

  it("falls back to the details when there is no message, and to the code when neither", () => {
    expect(saveFailureDetail({ code: "23514", details: "violates check constraint" })).toBe(
      "violates check constraint (23514)",
    );
    expect(saveFailureDetail({ code: "PGRST000" })).toBe("PGRST000");
  });

  it("returns null when the value says nothing, so the caller keeps its own sentence", () => {
    expect(saveFailureDetail({})).toBeNull();
    expect(saveFailureDetail(null)).toBeNull();
    expect(saveFailureDetail(undefined)).toBeNull();
    expect(saveFailureDetail({ message: "   " })).toBeNull();
  });
});
