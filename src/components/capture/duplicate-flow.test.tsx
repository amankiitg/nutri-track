/**
 * The duplicate banner's two dead ends, driven through the real sheet.
 *
 * The sequence matters and cannot be shortened. Picking a photo alone checks nothing; the
 * collision is found inside `submit`, and the defect only appears on the *second* submit. So the
 * test has to be: pick, Analyse, banner, "It is a new meal", and then a request that actually goes
 * out.
 *
 * Asserting that the banner cleared would not be enough on its own: the bug left the banner up
 * *and* sent nothing, so a test that only looked at the banner could pass on a fix that merely
 * hid it. The load-bearing assertion is the parse request.
 *
 * Two boundaries are faked and no more: `preparePhoto`, which needs a canvas jsdom does not have,
 * and the duplicate query, so that a collision can be arranged at all. `requestParseMeal` runs for
 * real against a stubbed `fetch`, because "did the request go out" is the thing being measured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/** Shaped as `CandidateMeal`, which is what the real query returns. */
const COLLIDING_MEAL = {
  id: "meal-earlier",
  eatenAt: "2026-09-19T13:34:00Z",
  mealType: "lunch",
  source: "photo",
  itemNames: ["Chicken salad"],
  photoHashes: ["hash-collides"],
};

/** A well-formed reply, so the sheet reaches the review screen rather than an error. */
const PARSE_REPLY = {
  items: [
    {
      name: "Chicken salad",
      quantity: null,
      unit: null,
      grams: 300,
      calories: 420,
      protein_g: 35,
      carbs_g: 12,
      fat_g: 24,
      fiber_g: 4,
      sugar_g: 3,
      sodium_mg: 600,
      confidence: 0.8,
      needs_review: false,
      review_reasons: [],
    },
  ],
  meal_type: "lunch",
  source: "photo",
  model: "fake",
  attempts: 1,
};

const observed = { photoHashLookups: 0, requests: [] as string[] };

vi.mock("@/lib/capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/capture")>()),
  preparePhoto: async () => ({
    bytes: new Uint8Array([1]),
    mimeType: "image/jpeg",
    sha256: "hash-collides",
  }),
  uploadMealPhoto: async () => ({ path: "user-1/new.jpg", sha256: "hash-collides" }),
}));

vi.mock("@/lib/duplicates-repo", () => ({
  findMealByPhotoHashes: async () => {
    observed.photoHashLookups += 1;
    return COLLIDING_MEAL;
  },
  fetchMealItems: async () => [],
  fetchRecentMeals: async () => [],
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => ({ insert: () => Promise.resolve({ error: null }) })),
    rpc: vi.fn(),
    storage: { from: vi.fn() },
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: "token-1" } } })),
    },
  },
}));

import { CaptureSheet } from "./CaptureSheet";

function renderSheet() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CaptureSheet
        open
        onOpenChange={() => undefined}
        userId="user-1"
        timeZone="America/New_York"
        targetCalories={2000}
      />
    </QueryClientProvider>,
  );
}

/** Picks a photo on the Photo tab, which is where the reported sequence started. */
async function pickPhoto(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("tab", { name: /photo/i }));
  const input = document.querySelector('input[type="file"]');
  if (input === null) throw new Error("the photo tab has no file input");
  fireEvent.change(input, {
    target: { files: [new File(["x"], "lunch.jpg", { type: "image/jpeg" })] },
  });
}

/** Waits for the banner, which is the state the person is looking at when they decide. */
async function waitForBanner(): Promise<HTMLElement> {
  return await screen.findByRole("button", { name: /it is a new meal/i });
}

beforeEach(() => {
  observed.photoHashLookups = 0;
  observed.requests = [];
  vi.stubEnv("VITE_PARSE_MEAL_URL", "https://meals.example.com/parse-meal");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      observed.requests.push(String(url));
      return new Response(JSON.stringify(PARSE_REPLY), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("saying It is a new meal", () => {
  it("sends the request rather than finding the same hash again", async () => {
    const user = userEvent.setup();
    renderSheet();
    await pickPhoto(user);

    // First submit: the hash collides, so the banner appears and nothing is sent. That is the
    // behaviour being relied on, not the bug.
    await user.click(screen.getByRole("button", { name: /analyse meal/i }));
    await waitForBanner();
    expect(observed.requests).toEqual([]);

    // The answer, which must actually continue the capture.
    await user.click(screen.getByRole("button", { name: /it is a new meal/i }));

    await waitFor(() => {
      expect(observed.requests).toEqual(["https://meals.example.com/parse-meal"]);
    });
  });

  it("does not ask whether this is a duplicate at all, which is what the answer means", async () => {
    const user = userEvent.setup();
    renderSheet();
    await pickPhoto(user);

    await user.click(screen.getByRole("button", { name: /analyse meal/i }));
    await waitForBanner();
    const lookupsAfterTheCollision = observed.photoHashLookups;
    expect(lookupsAfterTheCollision).toBe(1);

    await user.click(screen.getByRole("button", { name: /it is a new meal/i }));
    await waitFor(() => {
      expect(observed.requests).toHaveLength(1);
    });

    // The lookup that blocked the request is not run again. One more submit would be a fresh
    // capture, and that one does ask.
    expect(observed.photoHashLookups).toBe(1);
  });

  it("clears the banner once the request has gone, so the screen is not stuck", async () => {
    const user = userEvent.setup();
    renderSheet();
    await pickPhoto(user);

    await user.click(screen.getByRole("button", { name: /analyse meal/i }));
    await waitForBanner();
    await user.click(screen.getByRole("button", { name: /it is a new meal/i }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /it is a new meal/i })).toBeNull();
    });
  });
});
