/**
 * Which demo the intro asks for, and the order it falls back in: the short cut on a slow
 * connection when the build has one, then the full MP4, then the GIF.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  DEMO_GIF,
  DEMO_MP4,
  DEMO_SHORT_AVAILABLE,
  DEMO_SHORT_MP4,
  demoVideoSources,
  isSlowConnection,
} from "@/lib/intro";

const mocks = vi.hoisted(() => ({ sources: null as string[] | null }));

vi.mock("@/lib/intro", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/intro")>();
  return {
    ...actual,
    demoVideoSources: (...args: Parameters<typeof actual.demoVideoSources>) =>
      mocks.sources ?? actual.demoVideoSources(...args),
  };
});

const { DemoIntro } = await import("./DemoIntro");

beforeEach(() => {
  mocks.sources = null;
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const video = () => screen.getByRole("dialog").querySelector("video");
const gif = () => screen.getByRole("dialog").querySelector("img");

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

describe("demoVideoSources", () => {
  it("asks for the short cut first only when it exists and the connection is slow", () => {
    expect(demoVideoSources(true, true)).toEqual([DEMO_SHORT_MP4, DEMO_MP4]);
    expect(demoVideoSources(false, true)).toEqual([DEMO_MP4]);
    expect(demoVideoSources(true, false)).toEqual([DEMO_MP4]);
  });

  it("knows the short cut is absent from this build, since the file is not in public/demo", () => {
    // Flip this when meal-demo-short.mp4 is added: vite.config.ts sets the flag from the file.
    expect(DEMO_SHORT_AVAILABLE).toBe(false);
  });
});

describe("the intro's fallbacks", () => {
  it("plays the short cut, then the full MP4 if it cannot load, then the GIF", async () => {
    mocks.sources = [DEMO_SHORT_MP4, DEMO_MP4];
    render(<DemoIntro onDone={() => undefined} />);

    expect(video()?.getAttribute("src")).toBe(DEMO_SHORT_MP4);
    fireEvent.error(video() as HTMLVideoElement);
    await waitFor(() => expect(video()?.getAttribute("src")).toBe(DEMO_MP4));
    fireEvent.error(video() as HTMLVideoElement);
    await waitFor(() => expect(gif()?.getAttribute("src")).toBe(DEMO_GIF));
  });

  it("does not skip the full MP4 when the short one fails to load and play() rejects", async () => {
    mocks.sources = [DEMO_SHORT_MP4, DEMO_MP4];
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() =>
      Promise.reject(new DOMException("no source", "NotSupportedError")),
    );
    render(<DemoIntro onDone={() => undefined} />);
    fireEvent.error(video() as HTMLVideoElement);

    await waitFor(() => expect(video()?.getAttribute("src")).toBe(DEMO_MP4));
    expect(gif()).toBeNull();
  });

  it("goes to the GIF at once when autoplay is refused", async () => {
    mocks.sources = [DEMO_SHORT_MP4, DEMO_MP4];
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(() =>
      Promise.reject(new DOMException("refused", "NotAllowedError")),
    );
    render(<DemoIntro onDone={() => undefined} />);
    await waitFor(() => expect(gif()?.getAttribute("src")).toBe(DEMO_GIF));
  });

  it("plays the full MP4 on an ordinary connection", () => {
    render(<DemoIntro onDone={() => undefined} />);
    expect(video()?.getAttribute("src")).toBe(DEMO_MP4);
  });
});
