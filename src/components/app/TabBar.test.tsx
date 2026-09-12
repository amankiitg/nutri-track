/**
 * The bottom bar's height is the single source of truth for anything that has to sit above it.
 *
 * These assert on the rendered markup rather than on pixels, because jsdom has no layout to
 * measure and the bug they guard against was purely a coupling between two stylesheets. The
 * coupling is visible in the attributes, which is what makes it testable at all.
 *
 * The defect: the bar's inner row used `app-shell`, a *page-content* utility whose
 * `padding-bottom` includes the safe-area inset, so the bar ended up two insets tall while the
 * add-meal button above it assumed one. On a phone with a 34px inset the bar grew by 68px and
 * the button's bottom 43px disappeared behind it. `CaptureDock.test.tsx` asserts the other half
 * of the same agreement.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";

// Renders a plain anchor: the assertions are about classes and inline styles, and standing up
// a real router would test TanStack's Link rather than this agreement.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    activeProps,
    children,
    ...rest
  }: {
    to?: string;
    activeProps?: unknown;
    children?: ReactNode;
    className?: string;
  }) => (
    <a href={typeof to === "string" ? to : "#"} {...rest}>
      {children}
    </a>
  ),
}));

const { TabBar } = await import("./TabBar");

describe("TabBar", () => {
  it("takes its height from the shared token, so the inset is counted once", () => {
    const { getByRole } = render(<TabBar />);
    const style = getByRole("navigation").getAttribute("style") ?? "";

    expect(style).toContain("--tabbar-height");
    expect(style).toContain("env(safe-area-inset-bottom)");
  });

  it("keeps the page-content utility off its inner row", () => {
    const { getByRole } = render(<TabBar />);
    const ul = getByRole("navigation").querySelector("ul");

    expect(ul?.classList.contains("app-shell-x")).toBe(true);
    // `app-shell` carries page-content bottom padding, which is what inflated the bar.
    expect(ul?.classList.contains("app-shell")).toBe(false);
  });

  it("lets each tab fill the row height rather than carrying its own minimum", () => {
    const { getAllByRole } = render(<TabBar />);

    for (const link of getAllByRole("link")) {
      expect(link.classList.contains("h-full")).toBe(true);
      // A `min-h-14` here would be a second, independent copy of the row height.
      expect(link.classList.contains("min-h-14")).toBe(false);
    }
  });

  it("still shows the Admin tab only when asked", () => {
    const { rerender, queryByRole } = render(<TabBar isAdmin={false} />);
    expect(queryByRole("link", { name: "Admin" })).toBeNull();

    rerender(<TabBar isAdmin />);
    expect(queryByRole("link", { name: "Admin" })).not.toBeNull();
  });
});
