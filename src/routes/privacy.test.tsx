/**
 * The privacy page: what it says, and that it says it at all.
 *
 * Public and signed-out, because Google's OAuth reviewers fetch it, so the test renders it with
 * the router stubbed down to a plain anchor. The assertions are about claims, not layout: this is
 * the page somebody believes, and the analytics section is the one that must stay no stronger than
 * what Cloudflare actually does.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ComponentType } from "react";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: { component: ComponentType }) => ({ options }),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

import { Route } from "./privacy";

const PrivacyPage = (Route as unknown as { options: { component: ComponentType } }).options
  .component;

describe("the privacy page", () => {
  it("says which counter is used, and no more than that", () => {
    render(<PrivacyPage />);

    expect(screen.getByRole("heading", { name: "Visit counts" })).toBeInTheDocument();
    expect(screen.getByText(/Cloudflare Web Analytics/)).toBeInTheDocument();
    expect(screen.getByText(/cookieless/)).toBeInTheDocument();
    expect(screen.getByText(/aggregate|totals across everyone/)).toBeInTheDocument();
  });

  it("claims only that the counter does not try to identify you", () => {
    render(<PrivacyPage />);

    // "does not identify you" is a claim about an outcome nobody here can verify; "does not try"
    // is the one Cloudflare's own description supports.
    expect(
      screen.getByText(/It is cookieless and does not try to identify you\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/does not identify you/)).toBeNull();
  });

  it("says the count is of visits, not of what you log", () => {
    render(<PrivacyPage />);

    // The distinction the section exists for: a visit counter must not read as meal tracking.
    expect(screen.getByText(/does not see what you log/)).toBeInTheDocument();
    expect(screen.getByText(/never part of the count/)).toBeInTheDocument();
  });

  it("claims no retention period for the counter, because none is known", () => {
    render(<PrivacyPage />);

    const section = screen.getByRole("heading", { name: "Visit counts" }).closest("section");
    expect(section?.textContent ?? "").not.toMatch(/retain|retention|kept for \d+/i);
  });
});
