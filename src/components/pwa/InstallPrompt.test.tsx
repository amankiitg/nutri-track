/**
 * The install banner's timing relative to the landing intro: hidden while the intro (or a
 * replay) owns the screen, and shown only after the landing page has been visible for a beat.
 *
 * The gate itself lives on <html data-intro> (src/lib/intro.ts); the banner reads it on mount
 * and follows the window event the gate helpers dispatch when they change it. The inline gate
 * script changes the attribute without that event, but it runs before the app, so the mount
 * read is what covers a bypassed intro.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { InstallPrompt, DISMISS_KEY } from "./InstallPrompt";
import { INSTALL_BANNER_DELAY_MS } from "@/lib/pwa";
import { openIntroGate, openLandingGate } from "@/lib/intro";

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const realMatchMedia = window.matchMedia;

function setNavigator(userAgent: string, maxTouchPoints: number): void {
  Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true });
  Object.defineProperty(window.navigator, "maxTouchPoints", {
    value: maxTouchPoints,
    configurable: true,
  });
}

function setGate(value: string | undefined): void {
  if (value === undefined) delete document.documentElement.dataset["intro"];
  else document.documentElement.dataset["intro"] = value;
}

function emitInstallPrompt(): void {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  act(() => {
    window.dispatchEvent(event);
  });
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

const banner = () => screen.queryByRole("dialog", { name: "Install NutriTrack" });

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  window.sessionStorage.clear();
  setGate(undefined);
  setNavigator(ANDROID_UA, 1);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.matchMedia = realMatchMedia;
});

describe("the install banner's intro gating", () => {
  it("stays hidden while the intro is playing", () => {
    setGate("playing");
    render(<InstallPrompt />);
    emitInstallPrompt();

    advance(INSTALL_BANNER_DELAY_MS * 4);
    expect(banner()).toBeNull();
  });

  it("shows after the delay once the intro has finished", () => {
    render(<InstallPrompt />);
    emitInstallPrompt();

    // The intro takes the screen.
    act(() => openIntroGate());
    advance(INSTALL_BANNER_DELAY_MS * 4);
    expect(banner()).toBeNull();

    // The intro ends and the landing page shows.
    act(() => openLandingGate());
    advance(INSTALL_BANNER_DELAY_MS - 1);
    expect(banner()).toBeNull();
    advance(1);
    expect(banner()).toBeTruthy();
  });

  it("shows after the delay when the intro was bypassed", () => {
    // Already seen this session, reduced motion, or the 3 s slow-connection rule: the gate
    // script opened the page before the app loaded.
    setGate("skip");
    render(<InstallPrompt />);
    emitInstallPrompt();

    advance(INSTALL_BANNER_DELAY_MS - 1);
    expect(banner()).toBeNull();
    advance(1);
    expect(banner()).toBeTruthy();
  });

  it("shows at once off the landing page, where there is no intro", () => {
    render(<InstallPrompt />);
    emitInstallPrompt();

    expect(banner()).toBeTruthy();
  });

  it("still respects the dismissal memory", () => {
    window.localStorage.setItem(DISMISS_KEY, "1");
    setGate("skip");
    render(<InstallPrompt />);
    emitInstallPrompt();

    advance(INSTALL_BANNER_DELAY_MS * 2);
    expect(banner()).toBeNull();
  });

  it("never shows when already installed as a standalone app", () => {
    window.matchMedia = ((query: string) => ({
      matches: query === "(display-mode: standalone)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    setGate("skip");
    render(<InstallPrompt />);
    emitInstallPrompt();

    advance(INSTALL_BANNER_DELAY_MS * 2);
    expect(banner()).toBeNull();
  });

  it("shows the iOS hint after the delay when the intro was bypassed", () => {
    setNavigator(IPHONE_UA, 5);
    setGate("skip");
    render(<InstallPrompt />);

    advance(INSTALL_BANNER_DELAY_MS);
    const dialog = banner();
    expect(dialog).toBeTruthy();
    expect(screen.getByText(/Add to Home Screen/)).toBeTruthy();
  });
});
