/**
 * The review footer's remaining-calories line, on a day that already has meals logged.
 *
 * This is the case the old tests could not reach. On an empty day the target and the day's
 * remainder are the same number, so subtracting a meal from either gives the same answer and
 * the basis looks correct. The phone that reported this had 1,363 kcal already logged: the ring
 * said 408 remaining, and the footer answered a 130 kcal meal with "1641 kcal left of today's
 * 1771" — which is 1771 - 130, the target, not the remainder. 408 - 130 = 278.
 *
 * Driven through `CaptureDock` rather than by handing the review screen a number, because the
 * dock is where the number comes from: a test that passed the remainder in directly would not
 * notice the dock querying the target again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/** The phone's day: 1,363 eaten, a 1,771 target, 408 left. */
const DAY = {
  local_date: "2026-09-19",
  meal_count: 3,
  calories: 1363,
  protein_g: 96,
  carbs_g: 120,
  fat_g: 44,
  fiber_g: 18,
  target_calories: 1771,
  target_protein_g: 140,
  target_carbs_g: 190,
  target_fat_g: 62,
  remaining_calories: 408,
  status: "under",
};

/** This meal's calories, set per test so one file covers both sides of zero. */
let mealCalories = 130;

vi.mock("@/lib/capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/capture")>()),
  preparePhoto: async () => ({
    bytes: new Uint8Array([1]),
    mimeType: "image/jpeg",
    sha256: "hash-1",
  }),
  uploadMealPhoto: async () => ({ path: "user-1/new.jpg", sha256: "hash-1" }),
}));

vi.mock("@/lib/duplicates-repo", () => ({
  findMealByPhotoHashes: async () => null,
  fetchMealItems: async () => [],
  fetchRecentMeals: async () => [],
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: async (name: string) =>
      name === "daily_totals" ? { data: [DAY], error: null } : { data: [], error: null },
    from: vi.fn(() => ({ insert: () => Promise.resolve({ error: null }) })),
    storage: { from: vi.fn() },
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: "token-1" } } })),
    },
  },
}));

import { CaptureDock } from "./CaptureDock";

/**
 * Opens the dock, picks a photo and analyses it, so the review footer is on screen.
 *
 * No wait for the day's totals first: `remainingToday` arrives with the dock's query, and
 * every assertion below is a `findBy`, so a pending query resolves inside the assertion
 * rather than racing it.
 */
async function openReviewScreen(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <CaptureDock userId="user-1" timeZone="UTC" />
    </QueryClientProvider>,
  );

  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /add a meal/i }));

  await user.click(screen.getByRole("tab", { name: /photo/i }));
  const input = document.querySelector('input[type="file"]');
  if (input === null) throw new Error("the photo tab has no file input");
  fireEvent.change(input, {
    target: { files: [new File(["x"], "lunch.jpg", { type: "image/jpeg" })] },
  });

  await user.click(screen.getByRole("button", { name: /analyse meal/i }));
  await screen.findByText("This meal");
}

beforeEach(() => {
  mealCalories = 130;
  vi.stubEnv("VITE_PARSE_MEAL_URL", "https://meals.example.com/parse-meal");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      return new Response(
        JSON.stringify({
          items: [
            {
              name: "Chicken salad",
              quantity: null,
              unit: null,
              grams: 300,
              calories: mealCalories,
              protein_g: 12,
              carbs_g: 8,
              fat_g: 5,
              fiber_g: 2,
              sugar_g: 1,
              sodium_mg: 300,
              confidence: 0.8,
              needs_review: false,
              review_reasons: [],
            },
          ],
          meal_type: "lunch",
          source: "photo",
          model: "fake",
          attempts: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the footer on a day that already has meals", () => {
  it("subtracts this meal from what is left, not from the target", async () => {
    await openReviewScreen();

    // 408 - 130, not 1771 - 130.
    expect(await screen.findByText("278 kcal left of today's 1771")).toBeInTheDocument();
    expect(screen.queryByText(/1641/)).toBeNull();
  });

  it("reads zero left when the meal uses exactly the rest of the day", async () => {
    mealCalories = 408;
    await openReviewScreen();

    expect(await screen.findByText("0 kcal left of today's 1771")).toBeInTheDocument();
  });

  it("says it plainly when this meal takes the day over", async () => {
    mealCalories = 500;
    await openReviewScreen();

    // 408 - 500, so the day ends 92 over. Never a negative number on screen.
    expect(await screen.findByText("92 kcal over today's 1771")).toBeInTheDocument();
    expect(screen.queryByText(/-92/)).toBeNull();
  });
});
