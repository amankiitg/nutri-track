/**
 * The landing page's intro: who sees it, how it ends, and what is left afterwards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { Landing } from "./index";
import { DEMO_GIF_DURATION_MS, INTRO_SEEN_KEY } from "@/lib/intro";

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

beforeEach(() => {
  window.sessionStorage.clear();
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
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const page = () => screen.getByTestId("landing-page");

describe("the landing intro", () => {
  it("plays the vertical demo first, then Skip fades to the page without a demo box", async () => {
    const { container } = render(<Landing />);

    const intro = await screen.findByRole("dialog", { name: "NutriTrack demo" });
    expect(page().className).toContain("invisible");
    const video = intro.querySelector("video");
    expect(video?.getAttribute("src")).toBe("/demo/meal-demo.mp4");
    expect(video?.getAttribute("poster")).toBe("/demo/meal-demo-poster.png");
    expect(video?.muted).toBe(true);
    expect(video?.hasAttribute("playsinline")).toBe(true);
    expect(video?.parentElement?.className).toContain("aspect-[4/5]");
    expect(video?.className).toContain("object-contain");
    expect(window.sessionStorage.getItem(INTRO_SEEN_KEY)).toBe("1");

    await userEvent.setup().click(screen.getByRole("button", { name: "Skip" }));

    expect(page().className).not.toContain("invisible");
    expect(screen.getByRole("link", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Request an invite" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(container.querySelector("video, img[src*='meal-demo']")).toBeNull();
  });

  it("fades to the page when the video ends", async () => {
    render(<Landing />);
    const intro = await screen.findByRole("dialog");
    fireEvent.ended(intro.querySelector("video") as HTMLVideoElement);
    expect(page().className).not.toContain("invisible");
  });

  it("fades to the page on a tap anywhere", async () => {
    render(<Landing />);
    const intro = await screen.findByRole("dialog");
    fireEvent.click(intro);
    expect(page().className).not.toContain("invisible");
  });

  it("does not replay in the same browser session", async () => {
    window.sessionStorage.setItem(INTRO_SEEN_KEY, "1");
    render(<Landing />);
    await waitFor(() => expect(page().className).not.toContain("invisible"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("goes straight to the page when reduced motion is set", async () => {
    mocks.reducedMotion = true;
    render(<Landing />);
    await waitFor(() => expect(page().className).not.toContain("invisible"));
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
    await waitFor(() => expect(page().className).not.toContain("invisible"));

    await userEvent.setup().click(screen.getByRole("button", { name: "Watch the demo" }));
    expect(await screen.findByRole("dialog", { name: "NutriTrack demo" })).toBeTruthy();
  });

  it("falls back to the GIF when autoplay is refused, and ends after the demo's length", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(() =>
      Promise.reject(new DOMException("refused", "NotAllowedError")),
    );
    render(<Landing />);
    const intro = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(intro.querySelector("img")?.getAttribute("src")).toBe("/demo/meal-demo.gif"),
    );
    expect(page().className).toContain("invisible");

    act(() => {
      vi.advanceTimersByTime(DEMO_GIF_DURATION_MS);
    });
    expect(page().className).not.toContain("invisible");
  });
});

describe("the landing copy", () => {
  it("offers the trial as Try it now, with no scan count and no em dash", async () => {
    window.sessionStorage.setItem(INTRO_SEEN_KEY, "1");
    render(<Landing />);
    await waitFor(() => expect(page().className).not.toContain("invisible"));

    expect(screen.getByRole("link", { name: "Try it now" }).getAttribute("href")).toBe("/try");
    expect(page().textContent).not.toMatch(/scans?/i);
    expect(page().textContent).not.toContain("—");
  });
});
