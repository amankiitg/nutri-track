/**
 * The three public auth pages, opened by somebody who is already signed in.
 *
 * This is the bug these pin, in the words it was reported: a finished user opened `/auth/request`
 * and ended up in the onboarding wizard. All three pages are reachable while signed in - they are
 * not behind the guard - and each decided for itself where a signed-in visitor goes. The rule now
 * comes from one function, `signedInDestination`, and it uses the same profile check the guard does.
 *
 * The session and the profile are the only two facts involved, so both are mocked at the boundary the
 * app really uses: `auth.getUser()` and the `profiles` query.
 *
 * `/auth/welcome` is the one page where "signed in without a profile" must **not** mean onboarding:
 * that page is the link a brand-new invitee opens, and its whole job is to let them set a password
 * before the questions start. It stays put instead, which is asserted below.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { render, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  getSession: vi.fn(),
  profile: vi.fn(),
  replace: vi.fn(),
  search: {} as Record<string, unknown>,
  /** Fillable so a page that polls for a session can settle on the first pass. */
  updateUser: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: { component: React.ComponentType }) => ({
    options,
    useSearch: () => h.search,
  }),
  useRouter: () => ({ history: { replace: h.replace } }),
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
    return createElement(
      "a",
      { href: `${to}${query === "" ? "" : `?${query.toString()}`}` },
      children,
    );
  },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: h.getUser,
      getSession: h.getSession,
      signInWithPassword: vi.fn(),
      signInWithOtp: vi.fn(),
      signInWithOAuth: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      resend: vi.fn(),
      signOut: vi.fn(),
      updateUser: h.updateUser,
    },
    rpc: vi.fn(),
    // The profile lookup is `from("profiles").select("*").eq("user_id", id).maybeSingle()`.
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: h.profile }) }),
    }),
  },
}));

import { Route as AuthRoute } from "@/routes/auth";
import { Route as RequestRoute } from "@/routes/auth_.request";
import { Route as WelcomeRoute } from "@/routes/auth_.welcome";

type ComponentRoute = { options: { component: React.ComponentType } };

const AuthPage = (AuthRoute as unknown as ComponentRoute).options.component;
const RequestPage = (RequestRoute as unknown as ComponentRoute).options.component;
const WelcomePage = (WelcomeRoute as unknown as ComponentRoute).options.component;

/** Signs a user in, with or without a finished profile. */
function signedIn(withProfile: boolean): void {
  h.getUser.mockResolvedValue({
    data: { user: { id: "user-1", email: "aman@example.com" } },
    error: null,
  });
  // The local read the pages already use, which is shaped differently from `getUser`.
  h.getSession.mockResolvedValue({
    data: { session: { user: { id: "user-1", email: "aman@example.com" } } },
    error: null,
  });
  h.profile.mockResolvedValue(
    withProfile
      ? { data: { user_id: "user-1", display_name: "Aman" }, error: null }
      : { data: null, error: null },
  );
}

function signedOut(): void {
  h.getUser.mockResolvedValue({ data: { user: null }, error: { message: "no session" } });
  h.getSession.mockResolvedValue({ data: { session: null }, error: null });
  h.profile.mockResolvedValue({ data: null, error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.search = {};
  window.history.replaceState({}, "", "/auth");
  h.updateUser.mockResolvedValue({ data: {}, error: null });
});

describe("signed in, with a finished profile", () => {
  it.each([
    ["/auth", () => AuthPage],
    ["/auth/request", () => RequestPage],
    ["/auth/welcome", () => WelcomePage],
  ])("%s goes to Today", async (_name, page) => {
    signedIn(true);
    const Page = page();
    render(<Page />);

    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/today"));
  });

  it("honours ?redirect= on /auth", async () => {
    signedIn(true);
    h.search = { redirect: "/settings" };
    render(<AuthPage />);

    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/settings"));
  });

  it("honours ?redirect= on /auth/request", async () => {
    signedIn(true);
    h.search = { redirect: "/settings" };
    render(<RequestPage />);

    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/settings"));
  });

  it("refuses an off-site ?redirect= and sends them to Today instead", async () => {
    signedIn(true);
    h.search = { redirect: "https://evil.example/phish" };
    render(<AuthPage />);

    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/today"));
  });
});

describe("signed in, without a profile", () => {
  it("sends /auth to the wizard, not to Today", async () => {
    signedIn(false);
    render(<AuthPage />);

    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/onboarding"));
  });

  it("sends /auth/request to the wizard", async () => {
    signedIn(false);
    render(<RequestPage />);

    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/onboarding"));
  });

  it("leaves /auth/welcome on the password step, which is the point of that page", async () => {
    // A brand-new invitee arrives here from the email link with no profile. Sending them to the
    // wizard would skip the password they came to set.
    signedIn(false);
    render(<WelcomePage />);

    await waitFor(() => expect(h.replace).not.toHaveBeenCalled());
  });
});

describe("signed out", () => {
  it.each([
    ["/auth", () => AuthPage],
    ["/auth/request", () => RequestPage],
  ])("leaves %s where it is", async (_name, page) => {
    signedOut();
    const Page = page();
    render(<Page />);

    // Give the effect a chance to fire before asserting it did not navigate.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.replace).not.toHaveBeenCalled();
  });
});
