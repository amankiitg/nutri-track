/**
 * The add-meal button's offset must be derived from the tab bar's own height, not hand-picked.
 *
 * It was `calc(4.5rem + env(safe-area-inset-bottom))` — a guess at the bar's height that counted
 * the inset once, while the bar counted it twice. The two agreed only when the inset was zero,
 * which is why this looked fine in Safari and broke once installed to the home screen.
 *
 * jsdom cannot measure the overlap, so this pins the coupling instead: the offset names the same
 * token the bar uses. `TabBar.test.tsx` asserts the bar's half.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    storage: { from: vi.fn() },
    auth: { getSession: vi.fn() },
  },
}));

// The sheet is not what this file is about, and mounting it would drag Radix in for nothing.
vi.mock("./CaptureSheet", () => ({ CaptureSheet: () => null }));

const { CaptureDock } = await import("./CaptureDock");

function renderDock() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CaptureDock userId="user-1" timeZone="America/New_York" />
    </QueryClientProvider>,
  );
}

describe("CaptureDock", () => {
  it("clears the tab bar by a gap added to the bar's own height", () => {
    const { getByLabelText } = renderDock();
    const style = getByLabelText("Add a meal").getAttribute("style") ?? "";

    expect(style).toContain("--tabbar-height");
    expect(style).toContain("env(safe-area-inset-bottom)");
  });

  it("no longer carries the magic 4.5rem offset it shipped with", () => {
    const { getByLabelText } = renderDock();

    expect(getByLabelText("Add a meal").getAttribute("style") ?? "").not.toContain("4.5rem");
  });
});
