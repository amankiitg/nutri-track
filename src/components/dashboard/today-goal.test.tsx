/**
 * The reached-target notice on Today.
 *
 * Driven through the route rather than by calling `targetReached`, because the thing that was
 * wrong was a screen: the maths can be right and the notice still never reach the person. The tap
 * is covered here too, and it is a *save* on this screen — Today has no Save button, so a tap that
 * only changed local state would look like it worked and change nothing.
 *
 * Lives outside `src/routes/` so the file-based router never sees it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lbToKg } from "@/lib/units";

const h = vi.hoisted(() => ({
  saveProfile: vi.fn(),
  invalidate: vi.fn(() => Promise.resolve()),
}));

/** The latest weigh-in, which is what the notice is decided from. */
let latestWeight = 69.5;

/** The profile the route hands the screen. Mutable, because the numbers are the test. */
let PROFILE = {
  user_id: "user-1",
  timezone: "UTC",
  units: "metric" as const,
  display_name: "Aman",
  goal: "lose" as const,
  weight_kg: 72,
  target_weight_kg: 70,
  pace_kg_per_week: 0.5,
};

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: { component: React.ComponentType }) => ({ options }),
  getRouteApi: () => ({ useRouteContext: () => ({ profile: PROFILE }) }),
  useRouter: () => ({ invalidate: h.invalidate }),
}));

vi.mock("@/lib/dashboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard")>()),
  // Reads only. Nothing in this test deletes or restores a meal.
  fetchTimeline: async () => [],
  fetchRecentWeights: async () => [
    { logged_on: "2026-11-06", weight_kg: latestWeight, waist_cm: null },
  ],
  fetchDailyTotals: async () => ({
    local_date: "2026-11-06",
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
  refreshTargetIfStale: async () => ({ refreshed: false }),
  saveProfileWithTargets: h.saveProfile,
}));

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { Route } from "@/routes/_authenticated/today";

const Page = (Route as unknown as { options: { component: React.ComponentType } }).options
  .component;

function renderToday() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.saveProfile.mockResolvedValue(undefined);
  latestWeight = 69.5;
  PROFILE = {
    user_id: "user-1",
    timezone: "UTC",
    units: "metric",
    display_name: "Aman",
    goal: "lose",
    weight_kg: 72,
    target_weight_kg: 70,
    pace_kg_per_week: 0.5,
  };
});

describe("the target already being behind you", () => {
  it("says so under the ring, where the deficit is", async () => {
    renderToday();

    expect(await screen.findByText(/you're at your target weight/i)).toBeInTheDocument();
    expect(screen.getByText(/switch to maintain to stop the deficit/i)).toBeInTheDocument();
  });

  it("stays quiet while the target is still ahead", async () => {
    latestWeight = 75;

    renderToday();

    // Wait for the screen to have drawn its numbers, then check the notice never arrived.
    expect(await screen.findByText(/of 2,000 kcal/i)).toBeInTheDocument();
    expect(screen.queryByText(/you're at your target weight/i)).toBeNull();
  });

  it("stays quiet when the target is on the wrong side, which is the form's error to report", async () => {
    // 77 kg against an 85 kg lose target: this screen has no business saying "at your target"
    // next to it, which is the pair of messages the distance rule separated.
    latestWeight = 77;
    PROFILE = { ...PROFILE, target_weight_kg: 85 };

    renderToday();

    expect(await screen.findByText(/of 2,000 kcal/i)).toBeInTheDocument();
    expect(screen.queryByText(/you're at your target weight/i)).toBeNull();
    expect(screen.queryByText(/your target is above your current weight/i)).toBeNull();
  });

  it("says so for 169.8 lb against a 170 lb target, a pound that is 90 g", async () => {
    latestWeight = lbToKg(169.8);
    PROFILE = { ...PROFILE, target_weight_kg: lbToKg(170) };

    renderToday();

    expect(await screen.findByText(/you're at your target weight/i)).toBeInTheDocument();
  });

  it("saves Maintain on one tap, because there is no Save button on this screen", async () => {
    const user = userEvent.setup();
    renderToday();

    await user.click(await screen.findByRole("button", { name: /switch to maintain/i }));

    expect(h.saveProfile).toHaveBeenCalledTimes(1);
    expect(h.saveProfile.mock.calls[0]?.[0]).toMatchObject({
      user_id: "user-1",
      goal: "maintain",
    });
    // The profile the notice is drawn from is reloaded, or it would keep saying the target is
    // reached until the next navigation.
    expect(h.invalidate).toHaveBeenCalled();
  });

  it("does not save anything until the button is actually pressed", async () => {
    renderToday();

    await screen.findByText(/you're at your target weight/i);

    expect(h.saveProfile).not.toHaveBeenCalled();
  });
});
