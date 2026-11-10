/**
 * What the intro plays, and what it does when that cannot play: on a slow connection the short
 * cut alone and never the GIF; otherwise the full MP4, then the GIF.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  DEMO_GIF,
  DEMO_MP4,
  DEMO_SHORT_MP4,
  demoMedia,
  isSlowConnection,
  pageClock,
} from "@/lib/intro";

const mocks = vi.hoisted(() => ({
  media: null as { videos: string[]; allowGif: boolean } | null,
}));

vi.mock("@/lib/intro", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/intro")>();
  return {
    ...actual,
    demoMedia: (...args: Parameters<typeof actual.demoMedia>) =>
      mocks.media ?? actual.demoMedia(...args),
  };
});

const { DemoIntro } = await import("./DemoIntro");

const SLOW = { videos: [DEMO_SHORT_MP4], allowGif: false };
const realClock = pageClock.now;

beforeEach(() => {
  mocks.media = null;
  pageClock.now = () => 500;
  document.documentElement.removeAttribute("data-intro");
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

afterEach(() => {
  pageClock.now = realClock;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const dialog = () => screen.queryByRole("dialog");
const video = () => dialog()?.querySelector("video") ?? null;
const gif = () => dialog()?.querySelector("img") ?? null;

describe("isSlowConnection", () => {
  it("is true for data saver and for 3g or slower, false otherwise and when unknown", () => {
    expect(isSlowConnection({ saveData: true, effectiveType: "4g" })).toBe(true);
    expect(isSlowConnection({ effectiveType: "3g" })).toBe(true);
    expect(isSlowConnection({ effectiveType: "2g" })).toBe(true);
    expect(isSlowConnection({ effectiveType: "slow-2g" })).toBe(true);
    expect(isSlowConnection({ effectiveType: "4g" })).toBe(false);
    expect(isSlowConnection({})).toBe(false);
    expect(isSlowConnection(undefined)).toBe(false);
  });
});

describe("demoMedia", () => {
  it("on a slow connection: the short cut alone, and no GIF", () => {
    expect(demoMedia(true, true)).toEqual({ videos: [DEMO_SHORT_MP4], allowGif: false });
  });

  it("on a slow connection with no short cut in the build: the full video, still no GIF", () => {
    expect(demoMedia(false, true)).toEqual({ videos: [DEMO_MP4], allowGif: false });
  });

  it("otherwise: the full video, then the GIF", () => {
    expect(demoMedia(true, false)).toEqual({ videos: [DEMO_MP4], allowGif: true });
  });
});

describe("on a slow connection", () => {
  it("plays the short cut", () => {
    mocks.media = SLOW;
    render(<DemoIntro onDone={() => undefined} deadline />);
    expect(video()?.getAttribute("src")).toBe(DEMO_SHORT_MP4);
  });

  it("ends, with no GIF, when the short cut cannot load", async () => {
    mocks.media = SLOW;
    const onDone = vi.fn();
    render(<DemoIntro onDone={onDone} deadline />);
    fireEvent.error(video() as HTMLVideoElement);

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(gif()).toBeNull();
  });

  it("ends, with no GIF, when autoplay is refused", async () => {
    mocks.media = SLOW;
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(() =>
      Promise.reject(new DOMException("refused", "NotAllowedError")),
    );
    const onDone = vi.fn();
    render(<DemoIntro onDone={onDone} deadline />);

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(gif()).toBeNull();
  });

  it("ends at 3 s from page load when the short cut is not playing yet", () => {
    vi.useFakeTimers();
    mocks.media = SLOW;
    pageClock.now = () => 2_000;
    const onDone = vi.fn();
    render(<DemoIntro onDone={onDone} deadline />);

    vi.advanceTimersByTime(999);
    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe("on an ordinary connection", () => {
  it("plays the full MP4", () => {
    render(<DemoIntro onDone={() => undefined} deadline />);
    expect(video()?.getAttribute("src")).toBe(DEMO_MP4);
  });

  it("falls back to the GIF when the video cannot load", async () => {
    render(<DemoIntro onDone={() => undefined} deadline />);
    fireEvent.error(video() as HTMLVideoElement);
    await waitFor(() => expect(gif()?.getAttribute("src")).toBe(DEMO_GIF));
  });

  it("goes to the GIF at once when autoplay is refused", async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(() =>
      Promise.reject(new DOMException("refused", "NotAllowedError")),
    );
    render(<DemoIntro onDone={() => undefined} deadline />);
    await waitFor(() => expect(gif()?.getAttribute("src")).toBe(DEMO_GIF));
  });

  it("moves on to the next video when one fails to load and play() rejects", async () => {
    mocks.media = { videos: [DEMO_SHORT_MP4, DEMO_MP4], allowGif: true };
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() =>
      Promise.reject(new DOMException("no source", "NotSupportedError")),
    );
    render(<DemoIntro onDone={() => undefined} deadline />);
    fireEvent.error(video() as HTMLVideoElement);

    await waitFor(() => expect(video()?.getAttribute("src")).toBe(DEMO_MP4));
    expect(gif()).toBeNull();
  });
});
