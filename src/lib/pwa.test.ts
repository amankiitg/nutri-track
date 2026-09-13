/**
 * Install-hint detection.
 *
 * The user agents here are real ones, because the whole question is which of them can be told
 * apart: every browser on iOS is WebKit, so the token in the user agent is the only signal and
 * the tests are mostly about where that signal stops.
 *
 * The one that matters most is `"other"`. It is not "Safari": it is "no token I recognise", and it
 * has to stay that way, because a Chrome reader on Request Desktop Website sends a desktop user
 * agent with no token in it. Asserting they are in Safari would be inventing a fact.
 */
import { describe, expect, it } from "vitest";
import { iosBrowser, iosInstallHint, isIos, type IosBrowser } from "./pwa";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1";
const IPHONE_FIREFOX =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15";
const IPHONE_EDGE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/126.0 Mobile/15E148 Safari/605.1.15";
const IPHONE_OPERA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) OPiOS/2.2.0 Mobile/15E148 Safari/9537.53";

/** iPadOS 13 and later: a Mac user agent, because that is what Apple decided to send. */
const IPADOS_AS_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const DESKTOP_CHROME_ON_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function setNavigator(userAgent: string, maxTouchPoints: number): void {
  Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true });
  Object.defineProperty(window.navigator, "maxTouchPoints", {
    value: maxTouchPoints,
    configurable: true,
  });
}

describe("isIos", () => {
  it("recognises an iPhone", () => {
    setNavigator(IPHONE_SAFARI, 5);
    expect(isIos()).toBe(true);
  });

  it("recognises an iPad, which reports a Macintosh user agent", () => {
    // The user agent is identical to a Mac's, so a touchscreen is the only thing left to go on.
    setNavigator(IPADOS_AS_MAC, 5);
    expect(isIos()).toBe(true);
  });

  it("does not claim a Mac is an iPad", () => {
    setNavigator(IPADOS_AS_MAC, 0);
    expect(isIos()).toBe(false);
  });

  it("leaves Android alone", () => {
    setNavigator(DESKTOP_CHROME_ON_MAC, 0);
    expect(isIos()).toBe(false);
  });
});

describe("iosBrowser", () => {
  it("names the browsers that identify themselves", () => {
    expect(iosBrowser(IPHONE_CHROME)).toBe("Chrome");
    expect(iosBrowser(IPHONE_FIREFOX)).toBe("Firefox");
    expect(iosBrowser(IPHONE_EDGE)).toBe("Edge");
    expect(iosBrowser(IPHONE_OPERA)).toBe("Opera");
  });

  it("says nothing about Safari, because a Safari-shaped user agent is not proof of Safari", () => {
    expect(iosBrowser(IPHONE_SAFARI)).toBe("other");
  });

  it("cannot see through Request Desktop Website, which is why 'other' is not 'Safari'", () => {
    // Chrome on an iPhone with the desktop site requested: the token is gone and this is now
    // indistinguishable from a Mac. Nothing here can fix that, so nothing here pretends to.
    expect(iosBrowser(DESKTOP_CHROME_ON_MAC)).toBe("other");
  });
});

describe("iosInstallHint", () => {
  it("names Safari in every case", () => {
    const browsers: IosBrowser[] = ["other", "Chrome", "Firefox", "Edge", "Opera"];
    for (const browser of browsers) {
      expect(iosInstallHint(browser)).toContain("Safari");
    }
  });

  it("gives the Share steps and a way out when the browser is unnamed", () => {
    const hint = iosInstallHint("other");

    expect(hint).toContain("Share");
    expect(hint).toContain("Add to Home Screen");
    // An in-app browser reports a Safari-like user agent and has no Share button, and no
    // detection can tell. A reader who cannot find one is told what to do about it.
    expect(hint).toContain("if there is no Share button");
  });

  it("sends a reader in a named browser to Safari rather than giving them steps for it", () => {
    const hint = iosInstallHint("Chrome");

    expect(hint).toContain("Chrome cannot add apps to the home screen");
    expect(hint).toContain("Open tracknutri.app in Safari");
    expect(hint).toContain("Add to Home Screen");
  });

  it("stays a hint rather than becoming a tutorial", () => {
    for (const browser of ["other", "Chrome", "Firefox", "Edge", "Opera"] as IosBrowser[]) {
      expect(iosInstallHint(browser).length).toBeLessThan(180);
    }
  });
});
