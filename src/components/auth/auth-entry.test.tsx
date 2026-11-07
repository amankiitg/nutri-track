/**
 * The email-first sign-in page, one state at a time.
 *
 * The question is no longer "which button did you press" but "what does the database say about this
 * address". That answer is mocked here at the RPC boundary, which is the only thing the page cannot
 * decide for itself: `auth_entry_state` returns `not_invited`, `invited_new`, `has_account`,
 * `google_only` or `busy`, and the page has to draw a different screen for each.
 *
 * Two things are asserted that are easy to lose silently:
 *
 *   - **No password before the inbox is proven.** The invited path emails a link and sets the
 *     password afterwards, so a password field here is a bug even though it is the obvious form to
 *     draw.
 *   - **The words "create account" are nowhere on this page.** An address on the list is claiming an
 *     invite that already names it, and telling somebody to create an account is how a Google user
 *     ends up with two rows and two histories.
 *
 * Lives outside `src/routes/` because the file-based router treats a `.test.tsx` in there as a route.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  signInWithPassword: vi.fn(),
  signInWithOtp: vi.fn(),
  signInWithOAuth: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  resend: vi.fn(),
  replace: vi.fn(),
  /** The search the page is rendered with, so `?email=` and `?forgot=` can be exercised. */
  search: {} as Record<string, unknown>,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  // The page is what is under test, not the router around it.
  createFileRoute: () => (options: { component: React.ComponentType }) => ({
    options,
    useSearch: () => h.search,
  }),
  useRouter: () => ({ history: { replace: h.replace } }),
  // The search travels in the href so a link that drops it is visible here.
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
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: null } }),
      signInWithPassword: h.signInWithPassword,
      signInWithOtp: h.signInWithOtp,
      signInWithOAuth: h.signInWithOAuth,
      resetPasswordForEmail: h.resetPasswordForEmail,
      resend: h.resend,
      signOut: vi.fn(),
    },
    rpc: h.rpc,
  },
}));

import { Route } from "@/routes/auth";

const Page = (Route as unknown as { options: { component: React.ComponentType } }).options
  .component;

/** Answers `auth_entry_state` with one state, leaving every other RPC alone. */
function entryState(state: string | null): void {
  h.rpc.mockImplementation((fn: string) => {
    if (fn === "auth_entry_state") {
      return Promise.resolve(
        state === null ? { data: null, error: { message: "boom" } } : { data: state, error: null },
      );
    }
    return Promise.resolve({ data: null, error: null });
  });
}

/** Types an address and presses Continue, which is the only door into the other screens. */
async function continueWith(email: string): Promise<void> {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.type(screen.getByLabelText(/^email$/i), email);
  await user.click(screen.getByRole("button", { name: /^continue$/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.search = {};
  window.history.replaceState({}, "", "/auth");
  h.signInWithPassword.mockResolvedValue({ data: { user: null, session: null }, error: null });
  h.signInWithOtp.mockResolvedValue({ data: {}, error: null });
  h.signInWithOAuth.mockResolvedValue({
    data: { url: "https://accounts.google.com/x" },
    error: null,
  });
  h.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
  h.resend.mockResolvedValue({ data: {}, error: null });
  entryState("not_invited");
});

describe("an address that is not invited", () => {
  it("says so, and sends them to the request page with the address already in it", async () => {
    render(<Page />);
    await continueWith("stranger@example.com");

    expect(
      await screen.findByRole("heading", { name: "This email isn't invited yet." }),
    ).toBeInTheDocument();
    // No password field: there is no account to sign in to and no invite to claim.
    expect(screen.queryByLabelText(/^password$/i)).toBeNull();
    const link = screen.getByRole("link", { name: /request an invite/i });
    expect(link).toHaveAttribute("href", "/auth/request?email=stranger%40example.com");
    expect(h.rpc).toHaveBeenCalledWith("auth_entry_state", { p_email: "stranger@example.com" });
  });

  it("offers the way back to the address field", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<Page />);
    await continueWith("stranger@example.com");

    await user.click(await screen.findByRole("button", { name: /use a different email/i }));
    expect(screen.getByRole("heading", { name: "Welcome" })).toBeInTheDocument();
  });
});

describe("an invited address with no account", () => {
  it("emails a link instead of asking for a password", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    entryState("invited_new");
    render(<Page />);
    await continueWith("new@example.com");

    expect(await screen.findByRole("heading", { name: "You're invited!" })).toBeInTheDocument();
    expect(screen.getByText(/we'll email you a link to finish setting up/i)).toBeInTheDocument();
    // The whole point of the addendum: a password is never collected before the inbox is proven.
    expect(screen.queryByLabelText(/^password$/i)).toBeNull();
    expect(screen.queryByLabelText(/^confirm password$/i)).toBeNull();

    await user.click(screen.getByRole("button", { name: /email me a link/i }));

    await waitFor(() => expect(h.signInWithOtp).toHaveBeenCalledTimes(1));
    expect(h.signInWithOtp).toHaveBeenCalledWith({
      email: "new@example.com",
      options: {
        shouldCreateUser: true,
        emailRedirectTo: expect.stringContaining("/auth/welcome"),
      },
    });
    expect(await screen.findByRole("heading", { name: /check your inbox/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /resend in/i })).toBeDisabled();
  });

  it("says so when the link cannot be sent, and stays on the button", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    entryState("invited_new");
    h.signInWithOtp.mockResolvedValueOnce({
      data: {},
      error: { message: "Email rate limit exceeded" },
    });
    render(<Page />);
    await continueWith("new@example.com");

    await user.click(await screen.findByRole("button", { name: /email me a link/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/too many attempts/i);
    expect(screen.queryByRole("heading", { name: /check your inbox/i })).toBeNull();
  });
});

describe("an invited address with an account", () => {
  it("asks for the password and signs in", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    entryState("has_account");
    render(<Page />);
    await continueWith("known@example.com");

    await user.type(await screen.findByLabelText(/^password$/i), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() =>
      expect(h.signInWithPassword).toHaveBeenCalledWith({
        email: "known@example.com",
        password: "hunter2hunter2",
      }),
    );
    await waitFor(() => expect(h.replace).toHaveBeenCalled());
    expect(screen.queryByLabelText(/^confirm password$/i)).toBeNull();
  });

  it("points a Google user at Google and everybody else at a reset", async () => {
    h.signInWithPassword.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { message: "Invalid login credentials" },
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    entryState("has_account");
    render(<Page />);
    await continueWith("known@example.com");

    await user.type(await screen.findByLabelText(/^password$/i), "wrongpassword");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "That email and password don't match. If you joined with Google, use Continue with Google above. Otherwise reset your password.",
    );
    // The words in the sentence are buttons, and the Google one really does move the pointer.
    expect(
      within(alert).getByRole("button", { name: /continue with google/i }),
    ).toBeInTheDocument();
    await user.click(within(alert).getByRole("button", { name: /reset your password/i }));
    expect(screen.getByRole("heading", { name: /reset your password/i })).toBeInTheDocument();
  });

  it("turns an unconfirmed account into the verify panel, not a password complaint", async () => {
    h.signInWithPassword.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { message: "Email not confirmed" },
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    entryState("has_account");
    render(<Page />);
    await continueWith("known@example.com");

    await user.type(await screen.findByLabelText(/^password$/i), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(await screen.findByRole("heading", { name: /check your inbox/i })).toBeInTheDocument();
    expect(screen.getByText(/check your inbox to verify/i)).toBeInTheDocument();
    // The password field is gone with the form: the next step is the inbox, not another attempt.
    expect(screen.queryByLabelText(/^password$/i)).toBeNull();
  });

  it("resends the verification mail, and waits a minute before offering it again", async () => {
    h.signInWithPassword.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { message: "Email not confirmed" },
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    entryState("has_account");
    render(<Page />);
    await continueWith("known@example.com");
    await user.type(await screen.findByLabelText(/^password$/i), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    // Nothing was sent yet, so the control is a live button rather than a countdown.
    await user.click(await screen.findByRole("button", { name: /^resend$/i }));

    await waitFor(() =>
      expect(h.resend).toHaveBeenCalledWith({ type: "signup", email: "known@example.com" }),
    );
    // And then it is a countdown: the button cannot be pressed again for a minute.
    expect(await screen.findByRole("button", { name: /resend in/i })).toBeDisabled();
  });
});

describe("an address whose account has never had a password", () => {
  it("says so, and offers Google rather than a password box", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    entryState("google_only");
    render(<Page />);
    await continueWith("google@example.com");

    expect(
      await screen.findByRole("heading", { name: "This account signs in with Google." }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/^password$/i)).toBeNull();

    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    await waitFor(() => expect(h.signInWithOAuth).toHaveBeenCalledTimes(1));
    // The hint is what stops Google's chooser opening on the wrong account.
    expect(h.signInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        options: expect.objectContaining({ queryParams: { login_hint: "google@example.com" } }),
      }),
    );
  });

  it("offers a link for somebody who would rather have a password", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    entryState("google_only");
    render(<Page />);
    await continueWith("google@example.com");

    await user.click(
      await screen.findByRole("button", { name: /prefer a password\? email me a link/i }),
    );

    await waitFor(() =>
      expect(h.signInWithOtp).toHaveBeenCalledWith(
        expect.objectContaining({
          email: "google@example.com",
          options: expect.objectContaining({
            emailRedirectTo: expect.stringContaining("/auth/welcome"),
          }),
        }),
      ),
    );
  });
});

describe("a throttled check", () => {
  it("says to wait rather than pretending the address is not invited", async () => {
    entryState("busy");
    render(<Page />);
    await continueWith("stranger@example.com");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many attempts. Try again in a minute.",
    );
    // Still on the email step: "not invited" would be the wrong sentence for a throttle.
    expect(screen.getByRole("heading", { name: "Welcome" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /request an invite/i })).toBeNull();
  });
});

describe("getting back to the address", () => {
  it.each([
    ["not_invited", "stranger@example.com"],
    ["invited_new", "new@example.com"],
    ["has_account", "known@example.com"],
    ["google_only", "google@example.com"],
  ])("has a way back from %s", async (state, address) => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    entryState(state);
    render(<Page />);
    await continueWith(address);

    await screen.findByRole("heading", {
      name:
        state === "not_invited"
          ? "This email isn't invited yet."
          : state === "invited_new"
            ? "You're invited!"
            : state === "has_account"
              ? "Welcome back"
              : "This account signs in with Google.",
    });
    await user.click(screen.getByRole("button", { name: /use a different email/i }));

    // Back on the email field, with the address still there to edit rather than retype.
    expect(screen.getByRole("heading", { name: "Welcome" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^email$/i)).toHaveValue(address);
  });
});

describe("the page as a whole", () => {
  it("never says create account, in any state", async () => {
    for (const state of ["not_invited", "invited_new", "has_account", "google_only"]) {
      entryState(state);
      const { unmount } = render(<Page />);
      await continueWith(`${state}@example.com`);
      await screen.findByRole("heading", {
        name:
          state === "not_invited"
            ? "This email isn't invited yet."
            : state === "invited_new"
              ? "You're invited!"
              : state === "has_account"
                ? "Welcome back"
                : "This account signs in with Google.",
      });
      expect(screen.queryByText(/create account/i)).toBeNull();
      unmount();
      vi.clearAllMocks();
      h.signInWithOtp.mockResolvedValue({ data: {}, error: null });
    }
  });

  it("carries the typed address into the request link", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<Page />);
    await user.type(screen.getByLabelText(/^email$/i), "Stranger@Example.com");

    expect(screen.getByRole("link", { name: /request one/i })).toHaveAttribute(
      "href",
      "/auth/request?email=stranger%40example.com",
    );
  });

  it("treats an old ?tab=signup link as the email step, and clears it from the URL", async () => {
    window.history.replaceState({}, "", "/auth?tab=signup");
    render(<Page />);

    expect(await screen.findByRole("heading", { name: "Welcome" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /sign in/i })).toBeNull();
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("says so rather than guessing when the check itself fails", async () => {
    entryState(null);
    render(<Page />);
    await continueWith("known@example.com");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't check that address right now. Try again in a moment.",
    );
    // Not the invite panel: that would tell somebody with an invite to ask for one.
    expect(screen.queryByRole("heading", { name: "This email isn't invited yet." })).toBeNull();
    expect(screen.getByRole("heading", { name: "Welcome" })).toBeInTheDocument();
  });
});

describe("an address in the link", () => {
  it("prefills it and continues without anybody pressing Continue", async () => {
    h.search = { email: "Amank.IITG@Gmail.com" };
    entryState("has_account");
    render(<Page />);

    // The approval email's button lands here, so the page has to carry on by itself.
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    expect(h.rpc).toHaveBeenCalledWith("auth_entry_state", { p_email: "amank.iitg@gmail.com" });
  });

  it("asks the database exactly once, however many times the page renders", async () => {
    h.search = { email: "amank.iitg@gmail.com" };
    entryState("has_account");
    const { rerender } = render(<Page />);
    await screen.findByRole("heading", { name: "Welcome back" });
    rerender(<Page />);

    const calls = h.rpc.mock.calls.filter(([fn]) => fn === "auth_entry_state");
    expect(calls).toHaveLength(1);
  });
});
