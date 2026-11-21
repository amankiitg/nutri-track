/**
 * The fibre chip in the meal summary.
 *
 * The footer lists Protein, Carbs, Fat and Fibre in one 2-column grid, and the fourth cell was
 * the one nobody had a test for: the app has summed `fiber_g` since the column existed, but a
 * missing value has to behave like the other macros rather than print `NaN g` or vanish and
 * leave a three-cell row that reads as a bug.
 *
 * Driven through the capture dock, like the remaining-calories test, because the totals come
 * from the items the analysis returned and not from anything passed in here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/** Fibre per item, set per test: two items that add up, then one that has no fibre at all. */
let items: Array<{ name: string; fiber_g: number | null; calories: number }> = [];

vi.mock("@/lib/capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/capture")>()),
  preparePhoto: async () => ({ bytes: new Uint8Array([1]), mimeType: "image/jpeg", sha256: "h" }),
  uploadMealPhoto: async () => ({ path: "user-1/new.jpg", sha256: "h" }),
}));

vi.mock("@/lib/duplicates-repo", () => ({
  findMealByPhotoHashes: async () => null,
  fetchMealItems: async () => [],
  fetchRecentMeals: async () => [],
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: async () => ({
      data: [
        {
          local_date: "2026-09-19",
          meal_count: 0,
          calories: 0,
          protein_g: 0,
          carbs_g: 0,
          fat_g: 0,
          fiber_g: 0,
          target_calories: 2000,
          remaining_calories: 2000,
          status: "under",
        },
      ],
      error: null,
    }),
    from: vi.fn(() => ({ insert: () => Promise.resolve({ error: null }) })),
    storage: { from: vi.fn() },
    auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: "t" } } })) },
  },
}));

import { CaptureDock } from "./CaptureDock";

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
  items = [
    { name: "Ramen noodles in spicy broth", fiber_g: 2.5, calories: 380 },
    { name: "Soft boiled egg", fiber_g: 1.5, calories: 126 },
  ];
  vi.stubEnv("VITE_PARSE_MEAL_URL", "https://meals.example.com/parse-meal");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      return new Response(
        JSON.stringify({
          items: items.map((item, index) => ({
            name: item.name,
            quantity: null,
            unit: null,
            grams: 100,
            calories: item.calories,
            protein_g: 10,
            carbs_g: 12,
            fat_g: 4,
            fiber_g: item.fiber_g,
            sugar_g: null,
            sodium_mg: null,
            confidence: 0.9,
            cooking_fat: null,
            needs_review: false,
            review_reasons: [],
            item_id: `item-${index}`,
          })),
          meal_type: "dinner",
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

describe("the fibre chip in the meal summary", () => {
  it("shows the summed fibre of every item, beside the other macros", async () => {
    await openReviewScreen();

    const chips = screen.getAllByRole("definition");
    expect(chips).toHaveLength(4);
    expect(await screen.findByText("Fibre")).toBeInTheDocument();
    expect(await screen.findByText("4 g")).toBeInTheDocument();
  });

  it("counts a missing fibre as zero, the way a missing macro does", async () => {
    items = [{ name: "Grilled chicken", fiber_g: null, calories: 300 }];
    await openReviewScreen();

    expect(await screen.findByText("Fibre")).toBeInTheDocument();
    expect(await screen.findByText("0 g")).toBeInTheDocument();
  });
});
