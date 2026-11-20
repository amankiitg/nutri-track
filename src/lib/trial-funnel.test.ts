/**
 * The page's two funnel counts: what they send, and that a failure never reaches the page.
 *
 * The reporting is fire-and-forget on purpose, so the assertion that matters most here is
 * the one about what happens when the network is not there: nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportPageFunnelEvent } from "./trial";

const SERVICE = "https://meals.example.com/parse-meal";

describe("reportPageFunnelEvent", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubEnv("VITE_PARSE_MEAL_URL", SERVICE);
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("posts the event to the funnel route beside the parse route", () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    reportPageFunnelEvent("try_page_view");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://meals.example.com/trial/funnel");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ event: "try_page_view" }));
    // Without keepalive the count is lost by a visitor who analyses and leaves.
    expect(init.keepalive).toBe(true);
  });

  it("returns nothing and throws nothing when the request fails", () => {
    fetchMock.mockRejectedValue(new Error("offline"));

    expect(() => reportPageFunnelEvent("analyse_tapped")).not.toThrow();
  });

  it("survives a fetch that throws where a promise belongs", () => {
    // A bare call in a click handler dies with the handler, so the tap that was being counted
    // would do nothing at all — the count would have taken the feature down with it.
    fetchMock.mockImplementation(() => {
      throw new Error("no fetch today");
    });

    expect(() => reportPageFunnelEvent("analyse_tapped")).not.toThrow();
  });

  it("does not wait for the reply, so a slow count cannot stall a tap", () => {
    // A promise that never settles stands in for a service that has not answered yet.
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));

    expect(() => reportPageFunnelEvent("analyse_tapped")).not.toThrow();
  });
});
