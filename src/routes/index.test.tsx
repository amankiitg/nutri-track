/**
 * The landing page's intro: who sees it, how it ends, and what is left afterwards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { Landing } from "./index";
import { INTRO_FADE_MS } from "@/components/landing/DemoIntro";
import { DEMO_GIF_DURATION_MS, INTRO_SEEN_KEY, pageClock } from "@/lib/intro";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  navigate: vi.fn(),
  reducedMotion: false,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: () => mocks.getSession() } },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const ReactModule = await import("react");
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
    Link: ({
      to,
      children,
      className,
    }: {
      to: string;
      children?: React.ReactNode;
      className?: string;
    }) => ReactModule.createElement("a", { href: to, className }, children),
  };
});

const originalMatchMedia = window.matchMedia;

const realClock = pageClock.now;
/** Milliseconds since "page load" as the deadline sees it; tests move it by hand. */
let pageAge = 500;

beforeEach(() => {
  window.sessionStorage.clear();
  document.documentElement.removeAttribute("data-intro");
  pageAge = 500;
  pageClock.now = () => pageAge;
  mocks.getSession.mockReset();
  mocks.getSession.mockResolvedValue({ data: { session: null } });
  mocks.navigate.mockReset();
  mocks.reducedMotion = false;
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? mocks.reducedMotion : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  // jsdom implements no media playback.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

afterEach(() => {
  pageClock.now = realClock;
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const page = () => screen.getByTestId("landing-page");
/** The page is visible when the gate on <html> is open; styles.css hides it otherwise. */
const gate = () => document.documentElement.dataset["intro"];
const pageShown = () => gate() === "skip";

describe("the landing intro", () => {
  it("plays the vertical demo first, then Skip fades to the page without a demo box", async () => {
    const { container } = render(<Landing />);

    const intro = await screen.findByRole("dialog", { name: "NutriTrack demo" });
    expect(pageShown()).toBe(false);
    const video = intro.querySelector("video");
    expect(video?.getAttribute("src")).toBe("/demo/meal-demo.mp4");
    expect(video?.getAttribute("poster")).toBe("/demo/meal-demo-poster.png");
    expect(video?.muted).toBe(true);
    expect(video?.hasAttribute("playsinline")).toBe(true);
    expect(video?.parentElement?.className).toContain("aspect-[4/5]");
    expect(video?.className).toContain("object-contain");
    expect(window.sessionStorage.getItem(INTRO_SEEN_KEY)).toBe("1");

    await userEvent.setup().click(screen.getByRole("button", { name: "Skip" }));

    expect(pageShown()).toBe(true);
    expect(screen.getByRole("link", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Request an invite" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(container.querySelector("video, img[src*='meal-demo']")).toBeNull();
  });

  it("fades to the page when the video ends", async () => {
    render(<Landing />);
    const intro = await screen.findByRole("dialog");
    fireEvent.ended(intro.querySelector("video") as HTMLVideoElement);
    expect(pageShown()).toBe(true);
  });

  it("fades to the page on a tap anywhere", async () => {
    render(<Landing />);
    const intro = await screen.findByRole("dialog");
    fireEvent.click(intro);
    expect(pageShown()).toBe(true);
  });

  it("does not replay in the same browser session", async () => {
    window.sessionStorage.setItem(INTRO_SEEN_KEY, "1");
    render(<Landing />);
    await waitFor(() => expect(pageShown()).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("goes straight to the page when reduced motion is set", async () => {
    mocks.reducedMotion = true;
    render(<Landing />);
    await waitFor(() => expect(pageShown()).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("sends a signed-in visitor to /today with no intro", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: { user: { id: "u" } } } });
    render(<Landing />);
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({ to: "/today", replace: true }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.sessionStorage.getItem(INTRO_SEEN_KEY)).toBeNull();
  });

  it("replays from Watch the demo", async () => {
    window.sessionStorage.setItem(INTRO_SEEN_KEY, "1");
    render(<Landing />);
    await waitFor(() => expect(pageShown()).toBe(true));

    await userEvent.setup().click(screen.getByRole("button", { name: "Watch the demo" }));
    expect(await screen.findByRole("dialog", { name: "NutriTrack demo" })).toBeTruthy();
  });

  it("claims the screen once the video is playing, and keeps it past the deadline", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Landing />);
    const intro = await screen.findByRole("dialog");
    expect(page().getAttribute("aria-hidden")).toBe("true");

    fireEvent.playing(intro.querySelector("video") as HTMLVideoElement);
    expect(gate()).toBe("playing");

    pageAge = 10_000;
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(pageShown()).toBe(false);
  });

  it("shows the page at 3 s from page load when the video has not started", async () => {
    vi.useFakeTimers();
    pageAge = 1_200;
    render(<Landing />);

    // The session read resolves in a microtask; flush it so the intro mounts, then keep the
    // clock still. Without shouldAdvanceTime the deadline cannot move on its own, so the only
    // thing that ends the intro here is the deadline timer advanced below.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("dialog")).toBeTruthy();

    // 1.8 s are left of the 3: not yet.
    act(() => {
      vi.advanceTimersByTime(1_700);
    });
    expect(pageShown()).toBe(false);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(pageShown()).toBe(true);

    // The intro stays mounted over the fade, then unmounts.
    act(() => {
      vi.advanceTimersByTime(INTRO_FADE_MS);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Watch the demo" })).toBeTruthy();
  });

  it("does not open the intro at all when the app arrives after the deadline", async () => {
    pageAge = 3_400;
    render(<Landing />);
    await waitFor(() => expect(pageShown()).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not open the intro when the gate script already showed the page", async () => {
    document.documentElement.dataset["intro"] = "skip";
    render(<Landing />);
    await waitFor(() => expect(mocks.getSession).toHaveBeenCalled());
    await waitFor(() => expect(pageShown()).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ends a video that starts after the page is already showing, rather than covering it", async () => {
    render(<Landing />);
    const intro = await screen.findByRole("dialog");
    // The gate script's own timer opened the page a moment before the video's first frame.
    document.documentElement.dataset["intro"] = "skip";
    fireEvent.playing(intro.querySelector("video") as HTMLVideoElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(pageShown()).toBe(true);
  });

  it("falls back to the GIF when autoplay is refused, and ends one loop after it has loaded", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(() =>
      Promise.reject(new DOMException("refused", "NotAllowedError")),
    );
    render(<Landing />);
    const intro = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(intro.querySelector("img")?.getAttribute("src")).toBe("/demo/meal-demo.gif"),
    );

    // Arrived before the deadline: it has started, so one loop, then the page.
    fireEvent.load(intro.querySelector("img") as HTMLImageElement);
    expect(gate()).toBe("playing");
    act(() => {
      vi.advanceTimersByTime(DEMO_GIF_DURATION_MS - 1);
    });
    expect(pageShown()).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(pageShown()).toBe(true);
  });

  it("shows the page at the deadline when the GIF is still downloading", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(() =>
      Promise.reject(new DOMException("refused", "NotAllowedError")),
    );
    render(<Landing />);
    await screen.findByRole("dialog");
    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    expect(pageShown()).toBe(true);
  });

  it("on a replay, waits for the GIF however long it takes: the visitor asked, and Skip is there", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.sessionStorage.setItem(INTRO_SEEN_KEY, "1");
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(() =>
      Promise.reject(new DOMException("refused", "NotAllowedError")),
    );
    render(<Landing />);
    await waitFor(() => expect(pageShown()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Watch the demo" }));
    const intro = await screen.findByRole("dialog");
    await waitFor(() => expect(intro.querySelector("img")).not.toBeNull());

    act(() => {
      vi.advanceTimersByTime(DEMO_GIF_DURATION_MS * 3);
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("the landing copy", () => {
  it("offers the trial as Try it now, with no scan count and no em dash", async () => {
    window.sessionStorage.setItem(INTRO_SEEN_KEY, "1");
    render(<Landing />);
    await waitFor(() => expect(pageShown()).toBe(true));

    expect(screen.getByRole("link", { name: "Try it now" }).getAttribute("href")).toBe("/try");
    expect(page().textContent).not.toMatch(/scans?/i);
    expect(page().textContent).not.toContain("—");
  });
});
