/**
 * The sign-in link for existing accounts: who sees it, what it sends, and the resend cooldown.
 *
 * The page starts on the email step and asks the database which form the address deserves via
 * `authEntryState`, so each test drives through that step with a mocked answer rather than
 * rendering a screen directly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { AuthPage } from "./auth";

const mocks = vi.hoisted(() => ({
  authEntryState: vi.fn(),
  signInWithOtp: vi.fn(),
  signInWithPassword: vi.fn(),
  signInWithOAuth: vi.fn(),
  resend: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("@/lib/invite-request", () => ({
  authEntryState: (...args: unknown[]) => mocks.authEntryState(...args),
}));

/** The switch, per test: closed is the old product, open is the new one. */
let signupsOpen = false;

vi.mock("@/lib/open-signups", () => ({
  openSignups: async () => signupsOpen,
}));

vi.mock("@/lib/post-signin", () => ({
  signedInVisit: async () => ({ kind: "signed_out" as const }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      signInWithOtp: (...args: unknown[]) => mocks.signInWithOtp(...args),
      signInWithPassword: (...args: unknown[]) => mocks.signInWithPassword(...args),
      signInWithOAuth: (...args: unknown[]) => mocks.signInWithOAuth(...args),
      resend: (...args: unknown[]) => mocks.resend(...args),
      resetPasswordForEmail: (...args: unknown[]) => mocks.resetPasswordForEmail(...args),
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const ReactModule = await import("react");
  return {
    ...actual,
    createFileRoute: () => (routeDef: Record<string, unknown>) => ({
      ...routeDef,
      useSearch: () => ({ email: undefined, redirect: undefined, forgot: false }),
    }),
    useRouter: () => ({ history: { replace: mocks.replace } }),
    Link: ({
      to,
      children,
      className,
    }: {
      to: string;
      children?: React.ReactNode;
      className?: string;
    }) => ReactModule.createElement("a", { href: to, className }, children),
  };
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.authEntryState.mockResolvedValue("has_account");
  mocks.signInWithOtp.mockResolvedValue({ error: null });
});

/** Types the email and presses Continue, then waits for the step's own heading. */
async function reachStep(user: ReturnType<typeof userEvent.setup>, state: string): Promise<void> {
  mocks.authEntryState.mockResolvedValue(state);
  render(<AuthPage />);
  await user.type(screen.getByLabelText("Email"), "a@example.com");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  const heading =
    state === "not_invited"
      ? "This email isn't invited yet."
      : state === "invited_new"
        ? "You're invited!"
        : state === "has_account"
          ? "Welcome back"
          : "This account signs in with Google.";
  await screen.findByRole("heading", { name: heading });
}

describe("the sign-in link button", () => {
  it("shows on the has_account step", async () => {
    const user = userEvent.setup();
    await reachStep(user, "has_account");
    expect(screen.getByRole("button", { name: "Email me a sign-in link" })).toBeTruthy();
  });

  it("shows on the google_only step", async () => {
    const user = userEvent.setup();
    await reachStep(user, "google_only");
    expect(screen.getByRole("button", { name: "Email me a sign-in link" })).toBeTruthy();
  });

  it("does not show on the email step", () => {
    render(<AuthPage />);
    expect(screen.queryByRole("button", { name: "Email me a sign-in link" })).toBeNull();
  });

  it.each(["not_invited", "invited_new"] as const)(
    "does not show on the %s step",
    async (state) => {
      const user = userEvent.setup();
      await reachStep(user, state);
      expect(screen.queryByRole("button", { name: "Email me a sign-in link" })).toBeNull();
    },
  );
});

describe("sending the sign-in link", () => {
  it("calls signInWithOtp with shouldCreateUser false and the current origin", async () => {
    const user = userEvent.setup();
    await reachStep(user, "has_account");
    await user.click(screen.getByRole("button", { name: "Email me a sign-in link" }));

    await waitFor(() => expect(mocks.signInWithOtp).toHaveBeenCalledTimes(1));
    expect(mocks.signInWithOtp).toHaveBeenCalledWith({
      email: "a@example.com",
      options: {
        shouldCreateUser: false,
        emailRedirectTo: window.location.origin,
      },
    });
  });

  it("shows the inbox sentence and holds the resend behind a 60 second cooldown", async () => {
    const user = userEvent.setup();
    await reachStep(user, "has_account");
    await user.click(screen.getByRole("button", { name: "Email me a sign-in link" }));

    expect(await screen.findByRole("heading", { name: "Check your inbox" })).toBeTruthy();
    expect(screen.getByText("The link works once and expires in an hour.")).toBeTruthy();

    const resend = screen.getByRole("button", { name: /resend in 60s/i });
    expect(resend).toBeDisabled();
    // A press during the cooldown sends nothing new.
    mocks.signInWithOtp.mockClear();
    await user.click(resend);
    expect(mocks.signInWithOtp).not.toHaveBeenCalled();
  });
});

describe("the sign-up screen, with the switch either way", () => {
  beforeEach(() => {
    signupsOpen = false;
  });

  it("offers an account to an unknown address when sign-ups are open", async () => {
    signupsOpen = true;
    const user = userEvent.setup();
    mocks.authEntryState.mockResolvedValue("open_signup");
    render(<AuthPage />);

    await user.type(screen.getByLabelText("Email"), "stranger@example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "Create your account" })).toBeTruthy();
    expect(screen.getByText(/sign-ups are open/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Email me a link" })).toBeTruthy();
    // There is nothing to request when the door is open.
    expect(screen.queryByRole("link", { name: /request/i })).toBeNull();
  });

  it("keeps the invite wall when the switch is off", async () => {
    const user = userEvent.setup();
    await reachStep(user, "not_invited");

    expect(screen.getByText(/isn't on the list yet/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Request an invite" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Create your account" })).toBeNull();
  });

  it("says it is invite only on the email step while closed, and does not while open", async () => {
    render(<AuthPage />);
    // The read lands asynchronously; the closed sentence is the first one drawn.
    expect(await screen.findByText(/Invite-only for now/)).toBeTruthy();
  });
});
