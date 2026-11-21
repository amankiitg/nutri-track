/**
 * The return leg of a Google sign-in.
 *
 * Two things it has to get right. If Google came back as somebody other than the address typed,
 * say so and offer the way back, rather than silently redirecting as the wrong person. And if the
 * account is new, report the funnel step and land in onboarding: a Google sign-up has no email
 * link for the other path to hang that step on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  getSession: vi.fn(),
  signOut: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  replace: vi.fn(),
  signedInVisit: vi.fn(),
  reportPageFunnelEvent: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (routeDef: Record<string, unknown>) => ({
      ...routeDef,
      useSearch: () => ({ redirect: "/today" }),
    }),
    useRouter: () => ({ history: { replace: h.replace } }),
    Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
      <a href={to}>{children}</a>
    ),
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: h.getSession,
      signOut: h.signOut,
      exchangeCodeForSession: h.exchangeCodeForSession,
    },
  },
}));

vi.mock("@/lib/post-signin", () => ({ signedInVisit: h.signedInVisit }));
vi.mock("@/lib/trial", () => ({ reportPageFunnelEvent: h.reportPageFunnelEvent }));

import { AuthCallbackPage } from "./auth_.callback";

function signedInAs(email: string) {
  h.getSession.mockResolvedValue({ data: { session: { user: { id: "user-1", email } } } });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  h.signOut.mockResolvedValue({ error: null });
  h.signedInVisit.mockResolvedValue({ kind: "ready", to: "/today" });
});

describe("a Google sign-in as the wrong address", () => {
  it("says who they are signed in as, and does not redirect", async () => {
    window.sessionStorage.setItem("nutritrack:pending-google-email", "typed@example.com");
    signedInAs("actual@example.com");

    render(<AuthCallbackPage />);

    expect(await screen.findByText(/signed in as somebody else/i)).toBeInTheDocument();
    expect(screen.getByText(/actual@example.com/)).toBeInTheDocument();
    // The address appears twice: in the sentence, and on the button that returns to it.
    expect(screen.getAllByText(/typed@example.com/).length).toBeGreaterThan(0);
    // Nothing moved: redirecting would sign them in as the wrong person without a word.
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.reportPageFunnelEvent).not.toHaveBeenCalled();
  });

  it("offers the way back, which signs out and returns to the typed address", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem("nutritrack:pending-google-email", "typed@example.com");
    signedInAs("actual@example.com");

    render(<AuthCallbackPage />);

    await user.click(
      await screen.findByRole("button", { name: /sign out and use typed@example.com/i }),
    );

    await waitFor(() => expect(h.signOut).toHaveBeenCalled());
    expect(h.replace).toHaveBeenCalledWith("/auth?email=typed%40example.com");
  });

  it("says nothing when the addresses match", async () => {
    window.sessionStorage.setItem("nutritrack:pending-google-email", "same@example.com");
    signedInAs("same@example.com");

    render(<AuthCallbackPage />);

    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/today"));
    expect(screen.queryByText(/signed in as somebody else/i)).toBeNull();
  });
});

describe("a Google sign-up", () => {
  it("reports the funnel step and lands in onboarding", async () => {
    signedInAs("brand-new@example.com");
    h.signedInVisit.mockResolvedValue({ kind: "not_set_up" });

    render(<AuthCallbackPage />);

    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/onboarding"));
    expect(h.reportPageFunnelEvent).toHaveBeenCalledWith("signup_completed");
  });

  it("does not report a signup for somebody who already has a profile", async () => {
    signedInAs("existing@example.com");

    render(<AuthCallbackPage />);

    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/today"));
    expect(h.reportPageFunnelEvent).not.toHaveBeenCalled();
  });
});
