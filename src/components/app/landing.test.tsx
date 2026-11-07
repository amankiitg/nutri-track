/**
 * The landing page's two doors.
 *
 * "Sign in" and "Request an invite" are two different intentions, and for a while both went to the
 * same page: the request link carried `?request=1` into a flow that then asked for an address anyway.
 * The request page has an address of its own now, and this pins that the link goes there rather than
 * keeping the old convention alive by accident.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: { component: React.ComponentType }) => ({ options }),
  useNavigate: () => h.navigate,
  Link: ({
    to,
    search,
    children,
  }: {
    to: string;
    search?: Record<string, unknown>;
    children: ReactNode;
  }) => {
    const query = search === undefined ? "" : new URLSearchParams(search as Record<string, string>);
    const suffix = query === "" ? "" : `?${query.toString()}`;
    return createElement("a", { href: `${to}${suffix}` }, children);
  },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: () => Promise.resolve({ data: { session: null } }) } },
}));

import { Route } from "@/routes/index";

const Page = (Route as unknown as { options: { component: React.ComponentType } }).options
  .component;

beforeEach(() => {
  h.navigate.mockClear();
});

describe("the landing page", () => {
  it("sends Sign in to the sign-in page", async () => {
    render(<Page />);

    expect(await screen.findByRole("link", { name: /^sign in$/i })).toHaveAttribute(
      "href",
      "/auth",
    );
  });

  it("sends Request an invite to its own page", async () => {
    render(<Page />);

    expect(screen.getByRole("link", { name: /request an invite/i })).toHaveAttribute(
      "href",
      "/auth/request",
    );
  });
});
