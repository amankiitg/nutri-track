/**
 * The undo's refusal, driven through the Today screen in the order it happens: log a meal,
 * delete it, log the same thing again, press Undo.
 *
 * Driven through the route rather than by calling `restoreMeal`, because the thing being
 * checked is what reaches the screen. A unit test that asserted the throw would pass while
 * the toast showed a constraint name, which is exactly the shape of the bugs this codebase
 * has already been bitten by — the function right, the screen wrong.
 *
 * Lives outside `src/routes/` so the file-based router never sees it. A `.test.tsx` inside
 * the routes directory is a route as far as the generator is concerned.
 *
 * Two boundaries are faked. The read fetchers, because none of them is what this change
 * touches and the timeline only needs one row to have something to delete. And the
 * Supabase client's `update`, which becomes a two-row table that enforces the partial
 * unique index — the collision has to come from somewhere, and modelling it here is
 * cheaper than a database. The real behaviour of that index was measured against the live
 * database separately; this test is about the sentence the screen shows, and about the
 * refusal leaving both meals alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const PROFILE = {
  user_id: "user-1",
  timezone: "UTC",
  units: "metric" as const,
  display_name: "Aman",
};

/** The meal on the timeline, which is the one that gets deleted. */
const LOGGED = {
  id: "meal-1",
  eaten_at: "2026-09-19T13:34:00Z",
  meal_type: "lunch",
  source: "photo",
  notes: null,
  photo_count: 1,
  calories: 420,
  protein_g: 35,
  carbs_g: 12,
  fat_g: 24,
  item_count: 0,
  items: [],
};

/** Same photo, same text, same ten-minute bucket: one fingerprint, two meals. */
const FINGERPRINT = "fp-chicken-salad-1334";

interface Row {
  id: string;
  fingerprint: string;
  deletedAt: string | null;
}

/** The `meals` table, as far as this test needs it. */
const meals = new Map<string, Row>();

function seed(id: string, deletedAt: string | null): void {
  meals.set(id, { id, fingerprint: FINGERPRINT, deletedAt });
}

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  // The page, not the router, is what is under test here.
  createFileRoute: () => (options: { component: React.ComponentType }) => ({ options }),
  getRouteApi: () => ({ useRouteContext: () => ({ profile: PROFILE }) }),
}));

vi.mock("@/lib/dashboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard")>()),
  // Reads only. `deleteMeal` and `restoreMeal` stay real, which is the whole point.
  fetchTimeline: async () => [LOGGED],
  fetchDailyTotals: async () => ({
    local_date: "2026-09-19",
    meal_count: 1,
    calories: 420,
    protein_g: 35,
    carbs_g: 12,
    fat_g: 24,
    fiber_g: 4,
    target_calories: 2000,
    target_protein_g: 150,
    target_carbs_g: 200,
    target_fat_g: 70,
    remaining_calories: 1580,
    status: "under",
  }),
  fetchWeekVerdict: async () => ({
    window_days: 7,
    days_logged: 3,
    days_judged: 3,
    days_on_track: 2,
    avg_calories: 1800,
    avg_target_calories: 2000,
    avg_protein_g: 120,
    avg_target_protein_g: 150,
    verdict: "on_track",
  }),
  fetchRecentWeights: async () => [],
}));

vi.mock("@/lib/profile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/profile")>()),
  refreshTargetIfStale: async () => ({ refreshed: false }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      update: (patch: Record<string, unknown>) => ({
        eq: async (_column: string, id: string) => {
          const row = meals.get(id);
          if (row === undefined) return { error: null };

          // Un-deleting is the only statement that can violate a partial unique index:
          // it is the only one that puts a row back into the set the index covers.
          if (patch["deleted_at"] === null) {
            const clash = [...meals.values()].some(
              (other) => other.id !== id && other.deletedAt === null,
            );
            if (clash) {
              // Verbatim what PostgREST returns, constraint name and all, so the test
              // proves the message is not simply passing that text through.
              return {
                error: {
                  code: "23505",
                  message:
                    'duplicate key value violates unique constraint "meals_user_fingerprint_uniq"',
                  details: "",
                  hint: "",
                  name: "PostgrestError",
                },
              };
            }
          }

          row.deletedAt = patch["deleted_at"] as string | null;
          return { error: null };
        },
      }),
    }),
  },
}));

import { Toaster } from "@/components/ui/sonner";
import { Route } from "@/routes/_authenticated/today";

const Page = (Route as unknown as { options: { component: React.ComponentType } }).options
  .component;

function renderToday() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Page />
      <Toaster />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  meals.clear();
});

afterEach(() => {
  // sonner's toast store is module-level and outlives `cleanup`, so the first test's toast
  // is still queued when the second mounts its own Toaster — and is then the one on
  // screen, or the one hiding the other. Without this the second test passes alone and
  // fails after the first.
  toast.dismiss();
  vi.clearAllMocks();
});

describe("undoing a delete when the meal has since been logged again", () => {
  it("refuses in a sentence, leaves the constraint name out, and harms neither meal", async () => {
    const user = userEvent.setup();

    // Logged, and live.
    seed("meal-1", null);
    renderToday();

    // Deleted, from the timeline, which is where the undo is offered.
    await user.click(await screen.findByRole("button", { name: /delete lunch/i }));
    await waitFor(() => {
      expect(meals.get("meal-1")?.deletedAt).not.toBeNull();
    });

    // The same thing logged again while the original was deleted. Inserted straight into
    // the table rather than driven through the capture sheet: the capture sheet's own
    // path is covered elsewhere, and what matters to the undo is the row it leaves.
    seed("meal-2", null);

    await user.click(await screen.findByRole("button", { name: /^undo$/i }));

    // What the person reads. The exact sentence, and no trace of the constraint.
    expect(
      await screen.findByText("This meal has already been logged again, so it cannot be restored."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/meals_user_fingerprint_uniq/)).toBeNull();

    // Neither meal is harmed: the refusal is a refusal, not a partial write.
    expect(meals.get("meal-1")).toMatchObject({ id: "meal-1" });
    expect(meals.get("meal-1")?.deletedAt).not.toBeNull();
    expect(meals.get("meal-2")).toMatchObject({ deletedAt: null });
    expect(meals.size).toBe(2);
  });

  it("restores normally when nothing took the fingerprint, so the refusal is only for that", async () => {
    const user = userEvent.setup();

    seed("meal-1", null);
    renderToday();

    await user.click(await screen.findByRole("button", { name: /delete lunch/i }));
    await waitFor(() => {
      expect(meals.get("meal-1")?.deletedAt).not.toBeNull();
    });

    // Nothing re-logged.
    await user.click(await screen.findByRole("button", { name: /^undo$/i }));

    await waitFor(() => {
      expect(meals.get("meal-1")?.deletedAt).toBeNull();
    });
    expect(screen.queryByText(/cannot be restored/)).toBeNull();
  });
});
