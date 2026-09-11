import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCurrentTarget, localDateString } from "./profile";

const { fromMock, queryCalls } = vi.hoisted(() => {
  const calls: Record<string, unknown[]> = {};
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "lte", "order", "limit"]) {
    chain[method] = (...args: unknown[]) => {
      calls[method] = args;
      return chain;
    };
  }
  chain["maybeSingle"] = async () => ({ data: null, error: null });
  return { fromMock: vi.fn(() => chain), queryCalls: calls };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: fromMock, rpc: vi.fn() },
}));

/** 11:30 UTC is already the next day in Auckland (UTC+13) but still the 1st in Los Angeles (UTC-8). */
const LATE_EVENING_INSTANT = new Date("2026-03-01T11:30:00Z");

describe("localDateString", () => {
  it("resolves one instant to different calendar days in different zones", () => {
    expect(localDateString("Pacific/Auckland", LATE_EVENING_INSTANT)).toBe("2026-03-02");
    expect(localDateString("America/Los_Angeles", LATE_EVENING_INSTANT)).toBe("2026-03-01");
  });
});

describe("fetchCurrentTarget", () => {
  beforeEach(() => {
    for (const key of Object.keys(queryCalls)) delete queryCalls[key];
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(LATE_EVENING_INSTANT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves the day boundary in the profile zone, not the device zone", async () => {
    await fetchCurrentTarget("user-1", "Pacific/Auckland");

    // The device zone would have said 2026-03-01; the profile zone is a day ahead.
    expect(queryCalls["eq"]).toEqual(["user_id", "user-1"]);
    expect(queryCalls["lte"]).toEqual(["effective_from", "2026-03-02"]);
  });
});
