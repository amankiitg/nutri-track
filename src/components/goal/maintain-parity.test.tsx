/**
 * Settings and Today answer one question: is this person at their target?
 *
 * They used to answer it with different inputs. Settings compared the profile's stored weight
 * with the target; Today read the trailing 7-day average. So 167.2 lb against a 165 lb target
 * showed a notice in Settings that Today correctly hid, and the two screens disagreed about the
 * same person on the same day.
 *
 * These tests drive both screens with the same fake week of weigh-ins and compare what a reader
 * would see: whether the notice is there at all, and the average line word for word. A pure test
 * of `maintainSuggestion` cannot catch this class of bug, because the rule was right and the
 * screens were passing it different numbers.
 *
 * Lives outside `src/routes/` so the file-based router never sees it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentType } from "react";
import { lbToKg } from "@/lib/units";

const h = vi.hoisted(() => ({
  saveProfile: vi.fn(),
  invalidate: vi.fn(() => Promise.resolve()),
}));

/** The trailing 7-day window both screens are supposed to read. */
let weightWindow: { averageKg: number | null; readings: number } = {
  averageKg: 69.5,
  readings: 5,
};

/** The stored profile. The weight is deliberately not near the target in most cases. */
let PROFILE = {
  user_id: "user-1",
  timezone: "UTC",
  units: "metric" as "metric" | "imperial",
  display_name: "Aman",
  dob: "1994-01-01",
  sex: "female" as "female" | "male" | "other",
  height_cm: 175,
  activity_level: "moderately_active",
  goal: "lose" as "lose" | "maintain" | "gain",
  weight_kg: 72,
  target_weight_kg: 70,
  pace_kg_per_week: 0.5,
  dietary_tags: [] as string[],
  fiber_target_g: 30,
  reminder_time: null,
  protein_g_per_kg: 1.6,
};

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: { component: ComponentType }) => ({ options }),
  getRouteApi: () => ({ useRouteContext: () => ({ profile: PROFILE }) }),
  useRouter: () => ({ invalidate: h.invalidate }),
  useNavigate: () => vi.fn(),
}));

vi.mock("@/lib/dashboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard")>()),
  fetchTimeline: async () => [],
  fetchRecentWeights: async () => [
    { logged_on: "2026-11-11", weight_kg: PROFILE.weight_kg, waist_cm: null },
  ],
  fetchDailyTotals: async () => ({
    local_date: "2026-11-12",
    meal_count: 0,
    calories: 0,
    protein_g: 0,
    carbs_g: 0,
    fat_g: 0,
    fiber_g: 0,
    target_calories: 2000,
    target_protein_g: 150,
    target_carbs_g: 200,
    target_fat_g: 70,
    remaining_calories: 2000,
    status: "under",
  }),
  fetchWeekVerdict: async () => ({
    window_days: 7,
    days_logged: 0,
    days_judged: 0,
    days_on_track: 0,
    avg_calories: null,
    avg_target_calories: null,
    avg_protein_g: null,
    avg_target_protein_g: null,
    verdict: "no_data",
  }),
}));

vi.mock("@/lib/profile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/profile")>()),
  fetchWeightWindow: async () => weightWindow,
  fetchCurrentTarget: async () => null,
  refreshTargetIfStale: async () => ({ refreshed: false, weightKg: null, effectiveFrom: null }),
  saveProfileWithTargets: h.saveProfile,
}));

vi.mock("@/lib/calls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/calls")>()),
  fetchCallBudget: async () => ({
    used: 0,
    limit: 60,
    remaining: 60,
    resetsAt: new Date().toISOString(),
  }),
  presentBudget: () => null,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: async () => ({ data: { user: null } }),
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signOut: vi.fn(),
    },
  },
}));

import { Route as TodayRoute } from "@/routes/_authenticated/today";
import { Route as SettingsRoute } from "@/routes/_authenticated/settings";

const TodayPage = (TodayRoute as unknown as { options: { component: ComponentType } }).options
  .component;
const SettingsPage = (SettingsRoute as unknown as { options: { component: ComponentType } }).options
  .component;

/** What a reader sees on one screen once its queries have settled. */
interface Seen {
  notice: "at" | "past" | null;
  average: string | null;
}

async function readScreen(Page: ComponentType): Promise<Seen> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  );

  // Every query has finished, including the 7-day window. Asserting an absence before this
  // would pass on the loading state, which is the one moment when neither screen shows a notice.
  await waitFor(() => {
    const queries = client.getQueryCache().findAll();
    expect(
      queries.some((query) => Array.isArray(query.queryKey) && query.queryKey.includes("7d")),
    ).toBe(true);
    expect(queries.every((query) => query.state.status === "success")).toBe(true);
  });

  const past = screen.queryByText(/you're past your target weight/i) !== null;
  const at = screen.queryByText(/you're at your target weight/i) !== null;
  const average = screen.queryByText(/your 7-day average is/i)?.textContent ?? null;

  view.unmount();
  return { notice: past ? "past" : at ? "at" : null, average };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  h.saveProfile.mockResolvedValue(undefined);
  weightWindow = { averageKg: 69.5, readings: 5 };
  PROFILE = {
    user_id: "user-1",
    timezone: "UTC",
    units: "metric",
    display_name: "Aman",
    dob: "1994-01-01",
    sex: "female",
    height_cm: 175,
    activity_level: "moderately_active",
    goal: "lose",
    weight_kg: 72,
    target_weight_kg: 70,
    pace_kg_per_week: 0.5,
    dietary_tags: [],
    fiber_target_g: 30,
    reminder_time: null,
    protein_g_per_kg: 1.6,
  };
});

describe("the two screens agree about the same week of weigh-ins", () => {
  it("both say it, and print the same average", async () => {
    const today = await readScreen(TodayPage);
    const settings = await readScreen(SettingsPage);

    expect(today.notice).toBe("at");
    expect(settings.notice).toBe("at");
    expect(today.average).toBe("Your 7-day average is 69.5 kg.");
    expect(settings.average).toBe(today.average);
  });

  it("neither says it on a single low weigh-in", async () => {
    weightWindow = { averageKg: 65, readings: 1 };

    expect((await readScreen(TodayPage)).notice).toBeNull();
    expect((await readScreen(SettingsPage)).notice).toBeNull();
  });

  it("neither says it while the average is still ahead", async () => {
    weightWindow = { averageKg: 75, readings: 5 };

    const today = await readScreen(TodayPage);
    const settings = await readScreen(SettingsPage);

    expect(today.notice).toBeNull();
    expect(settings.notice).toBeNull();
    expect(settings.average).toBeNull();
  });

  it("neither decides from the latest weigh-in: 167.2 lb against 165 lb stays quiet", async () => {
    // The report. The stored weight is 0.998 kg from the target, which the old Settings check
    // counted as arrived; the week's average is 166.4 lb, 0.635 kg away, so Today hid it.
    PROFILE = {
      ...PROFILE,
      units: "imperial",
      weight_kg: lbToKg(167.2),
      target_weight_kg: lbToKg(165),
    };
    weightWindow = { averageKg: lbToKg(166.4), readings: 5 };

    const today = await readScreen(TodayPage);
    const settings = await readScreen(SettingsPage);

    expect(today.notice).toBeNull();
    expect(settings.notice).toBeNull();
    expect(today.average).toBeNull();
    expect(settings.average).toBeNull();
  });

  it("both print the average in pounds", async () => {
    PROFILE = { ...PROFILE, units: "imperial", target_weight_kg: lbToKg(170) };
    weightWindow = { averageKg: lbToKg(169.4), readings: 4 };

    const today = await readScreen(TodayPage);
    const settings = await readScreen(SettingsPage);

    expect(today.average).toBe("Your 7-day average is 169.4 lb.");
    expect(settings.average).toBe(today.average);
  });

  it('both call a crossed target "past"', async () => {
    weightWindow = { averageKg: 69.2, readings: 5 };

    expect((await readScreen(TodayPage)).notice).toBe("past");
    expect((await readScreen(SettingsPage)).notice).toBe("past");
  });
});
