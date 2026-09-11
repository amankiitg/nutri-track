/**
 * What the capture sheet actually says when a parse does not work out.
 *
 * The wording already has unit tests, but wording in a function is not the same as
 * wording on a screen: the whole complaint was a spinner that stops with nothing to
 * read underneath it, and only a render can prove that stopped happening. So these
 * tests drive the real sheet through the real request path with only `fetch` faked,
 * and assert against what a person would see.
 *
 * The Type tab is used throughout, which is deliberate: it is the one route that needs
 * no canvas (`preparePhoto` is a browser API jsdom does not have) and no upload, so the
 * failure being tested is the only thing in the way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CaptureSheet } from "./CaptureSheet";
import { supabase } from "@/integrations/supabase/client";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    storage: { from: vi.fn() },
    auth: { getSession: vi.fn() },
  },
}));

const auth = supabase.auth as unknown as { getSession: ReturnType<typeof vi.fn> };

const SERVICE = "https://meals.example.com/parse-meal";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function renderSheet() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CaptureSheet
        open
        onOpenChange={() => {}}
        userId="user-1"
        timeZone="America/New_York"
        targetCalories={2000}
      />
    </QueryClientProvider>,
  );
}

/**
 * Renders the sheet and opens the Type tab.
 *
 * Split from the rest because Radix mounts a tab panel through its own effects, which
 * need real timers to run: the tab has to be open before fake timers are installed.
 */
async function openTypeTab() {
  const user = userEvent.setup();
  renderSheet();
  await user.click(screen.getByRole("tab", { name: /type/i }));
  return user;
}

/**
 * Fills the meal and presses the button, awaiting nothing.
 *
 * `fireEvent` rather than `userEvent`: userEvent awaits its own timer flushing, which
 * deadlocks once fake timers are installed, and these tests install them to reach an
 * eight-second pause and a two-and-a-half-minute ceiling without waiting for real time.
 */
function submitTypedMeal() {
  fireEvent.change(screen.getByPlaceholderText(/two slices of sourdough/i), {
    target: { value: "two slices of toast and a flat white" },
  });
  fireEvent.click(screen.getByRole("button", { name: /analyse meal/i }));
}

/** Types a meal and presses the button, for the tests that use real timers. */
async function analyseTypedMeal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: /type/i }));
  await user.type(
    screen.getByPlaceholderText(/two slices of sourdough/i),
    "two slices of toast and a flat white",
  );
  await user.click(screen.getByRole("button", { name: /analyse meal/i }));
}

/** The red box, once it appears. */
async function alertText(): Promise<string> {
  const alert = await screen.findByRole("alert");
  return alert.textContent ?? "";
}

/** A fetch that never settles until it is aborted: a server that never answers. */
function hangingFetch(_input: unknown, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("The operation was aborted.", "AbortError")),
    );
  });
}

beforeEach(() => {
  // Belt and braces: a test that times out is aborted before its own `finally` runs,
  // and fake timers left installed would hang every test after it.
  vi.useRealTimers();
  vi.stubEnv("VITE_PARSE_MEAL_URL", SERVICE);
  auth.getSession.mockResolvedValue({ data: { session: { access_token: "token-1" } } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("when the meal service cannot be reached", () => {
  it("says so in words, instead of showing the browser's Failed to fetch", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    const user = userEvent.setup();
    renderSheet();
    await analyseTypedMeal(user);

    const shown = await alertText();
    expect(shown).toContain("Could not reach the meal service");
    expect(shown).not.toContain("Failed to fetch");
    // And it says the meal was not half-logged, which is the first thing anyone wonders.
    expect(shown).toContain("has not been logged");
  });

  it("leaves the button pressable again, so a retry is one tap", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    const user = userEvent.setup();
    renderSheet();
    await analyseTypedMeal(user);
    await alertText();

    const button = screen.getByRole("button", { name: /analyse meal/i });
    expect(button).toBeEnabled();
  });

  it("offers a way back to the meal, not just an apology", async () => {
    // The typed text is still in the textarea, so the user has lost nothing.
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    const user = userEvent.setup();
    renderSheet();
    await analyseTypedMeal(user);
    await alertText();

    expect(screen.getByPlaceholderText(/two slices of sourdough/i)).toHaveValue(
      "two slices of toast and a flat white",
    );
  });
});

describe("when the day's analyses are used up", () => {
  const limitBody = {
    error: {
      code: "rate_limited",
      message: "You have used all 60 meal analyses for today.",
      details: { limit: 60, used: 60, retry_after_seconds: 25_200 },
    },
  };

  it("says how long until they come back, from the header the browser can always read", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(jsonResponse(limitBody, 429, { "Retry-After": "25200" })),
    );
    const user = userEvent.setup();
    renderSheet();
    await analyseTypedMeal(user);

    const shown = await alertText();
    expect(shown).toContain("You have used all 60 meal analyses for today.");
    expect(shown).toContain("in about 7 hours");
    // The limit is on reading photos and voice, not on logging; saying so turns a dead
    // end into a different way to record the meal.
    expect(shown).toContain("type a meal");
  });
});

describe("when the model declines", () => {
  it("shows the service's own explanation rather than a second guess at it", async () => {
    const body = {
      error: {
        code: "unparseable_response",
        message:
          "The meal reader declined to analyse this one. Try a different photo, or type what you ate — typing works without a picture.",
        details: { reason: "refusal", finishReason: "SAFETY" },
      },
    };
    vi.stubGlobal("fetch", () => Promise.resolve(jsonResponse(body, 422)));
    const user = userEvent.setup();
    renderSheet();
    await analyseTypedMeal(user);

    const shown = await alertText();
    expect(shown).toContain("declined");
    expect(shown).not.toContain("short note");
  });
});

describe("a parse that is taking a long time", () => {
  it("admits it is slow and offers a way out, instead of an unchanging spinner", async () => {
    // Never settles: the case that used to spin with no end and no explanation.
    vi.stubGlobal("fetch", hangingFetch);
    await openTypeTab();
    vi.useFakeTimers();
    submitTypedMeal();

    // The first thing the user sees is honest about what is happening.
    expect(screen.getByRole("button", { name: /analysing/i })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_500);
    });

    expect(screen.getByRole("button", { name: /still analysing/i })).toBeInTheDocument();
    expect(screen.getByText(/can take up to two minutes/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^cancel$/i })).toBeInTheDocument();
  });

  it("says nothing about being slow while it is still quick", async () => {
    // The notice has to mean something. Shown immediately, it would be reassurance
    // instead of information.
    vi.stubGlobal("fetch", hangingFetch);
    await openTypeTab();
    vi.useFakeTimers();
    submitTypedMeal();

    expect(screen.getByRole("button", { name: /analysing/i })).toBeInTheDocument();
    expect(screen.queryByText(/can take up to two minutes/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^cancel$/i })).not.toBeNull();
  });

  it("treats Cancel as a decision, not as a failure", async () => {
    vi.stubGlobal("fetch", hangingFetch);
    const user = userEvent.setup();
    renderSheet();
    await analyseTypedMeal(user);

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));

    const shown = await alertText();
    expect(shown).toContain("cancelled");
    expect(screen.getByRole("button", { name: /analyse meal/i })).toBeEnabled();
  });

  it("gives up on its own before the user has to, and says nothing was logged", async () => {
    vi.stubGlobal("fetch", hangingFetch);
    await openTypeTab();
    vi.useFakeTimers();
    submitTypedMeal();

    // Past the ceiling the client sets for a request that never answers.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(151_000);
      // The abort rejects the pending fetch, and the rejection has to travel back
      // through the awaited call before React has anything to render.
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByRole("alert").textContent).toContain("Nothing was logged");
    expect(screen.getByRole("button", { name: /analyse meal/i })).toBeEnabled();
  });
});

describe("a parse that works", () => {
  it("shows no error at all, which is the case that must not have regressed", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        jsonResponse({
          items: [
            {
              name: "Sourdough toast",
              quantity: 2,
              unit: "slice",
              grams: 70,
              calories: 180,
              protein_g: 6,
              carbs_g: 34,
              fat_g: 1.5,
              fiber_g: 2,
              sugar_g: 2,
              sodium_mg: 300,
              confidence: 0.8,
              needs_review: false,
              review_reasons: [],
            },
          ],
          meal_type: "breakfast",
          source: "text",
          model: "gemini-test",
          attempts: 1,
        }),
      ),
    );
    const user = userEvent.setup();
    renderSheet();
    await analyseTypedMeal(user);

    // The review screen replaces the button, and nothing red appears.
    expect(await screen.findByRole("button", { name: /save meal/i })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
