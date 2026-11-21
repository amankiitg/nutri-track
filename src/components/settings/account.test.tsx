/**
 * The Account card at the bottom of Settings.
 *
 * Three things worth pinning. The label follows the identities, because a Google-only account has
 * no password to change and a button promising one is a dead end. Setting a password goes to
 * `updateUser` on the same account rather than anywhere else, which is the deliberate choice
 * recorded in AGENTS.md. And signing out clears the cache before it navigates, because a signed-out
 * device holding another person's cached rows is the kind of thing nobody notices until it matters.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
  navigate: vi.fn(),
  authEntryState: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => h.navigate,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: h.getUser,
      updateUser: h.updateUser,
      signOut: h.signOut,
    },
  },
}));

/**
 * The database's answer about whether this account has a password, which the identities cannot
 * give: a magic-link account has an `email` identity and no password.
 */
vi.mock("@/lib/invite-request", () => ({
  authEntryState: () => h.authEntryState(),
}));

import { AccountSection } from "./AccountSection";

function account(providers: readonly string[]): unknown {
  return {
    data: {
      user: {
        email: "aman@example.com",
        identities: providers.map((provider) => ({ provider })),
      },
    },
  };
}

function renderAccount({
  remainingAnalyses = null,
}: {
  remainingAnalyses?: { line: string; note: string | null } | null;
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AccountSection
        timeZone="America/New_York"
        units="metric"
        today="2026-11-19"
        remainingAnalyses={remainingAnalyses}
      />
    </QueryClientProvider>,
  );
  return client;
}

async function typeNewPassword(password: string, confirmation = password): Promise<void> {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText(/^new password$/i), password);
  await user.type(screen.getByLabelText(/^confirm password$/i), confirmation);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getUser.mockResolvedValue(account(["google"]));
  h.authEntryState.mockResolvedValue("google_only");
  h.updateUser.mockResolvedValue({ data: { user: null }, error: null });
  h.signOut.mockResolvedValue({ error: null });
});

describe("who is signed in", () => {
  it("shows the address and a Google-only account offering to set a password", async () => {
    renderAccount();

    expect(await screen.findByText("aman@example.com")).toBeInTheDocument();
    expect(screen.getByText(/signing in with google/i)).toBeInTheDocument();
    // Nothing to change, so it must not claim otherwise.
    expect(screen.getByRole("button", { name: /set a password/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /change password/i })).toBeNull();
  });

  it("says so when the account has both ways in", async () => {
    h.getUser.mockResolvedValue(account(["google", "email"]));
    h.authEntryState.mockResolvedValue("has_password");

    renderAccount();

    expect(await screen.findByText(/signing in with google and email/i)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /change password/i })).toBeInTheDocument();
  });

  it("offers to set one on a magic-link account, which has an email identity and no password", async () => {
    // The bug: this account has `email` in its identities, so the button said "Change password"
    // for a password that was never set.
    h.getUser.mockResolvedValue(account(["email"]));
    h.authEntryState.mockResolvedValue("link_only");

    renderAccount();

    expect(await screen.findByRole("button", { name: /set a password/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /change password/i })).toBeNull();
  });

  it("still offers to set one when the answer cannot be read", async () => {
    h.getUser.mockResolvedValue(account(["email"]));
    h.authEntryState.mockResolvedValue(null);

    renderAccount();

    // The fallback is the old behaviour: an unknown answer is not a promise either way.
    expect(await screen.findByRole("button", { name: /change password/i })).toBeInTheDocument();
  });
});

describe("setting a password", () => {
  it("updates the user's own account and re-reads the identities afterwards", async () => {
    const user = userEvent.setup();
    renderAccount();

    await user.click(await screen.findByRole("button", { name: /set a password/i }));
    await typeNewPassword("correct horse battery");
    await user.click(screen.getByRole("button", { name: /set a password/i }));

    expect(h.updateUser).toHaveBeenCalledWith({ password: "correct horse battery" });
    // Read again, because setting one turns a Google-only account into a two-provider one and the
    // label has to follow it.
    await waitFor(() => expect(h.getUser).toHaveBeenCalledTimes(2));
  });

  it("refuses two different passwords before it sends anything", async () => {
    const user = userEvent.setup();
    renderAccount();

    await user.click(await screen.findByRole("button", { name: /set a password/i }));
    await typeNewPassword("correct horse battery", "correct horse batteries");
    await user.click(screen.getByRole("button", { name: /set a password/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/don't match/i);
    expect(h.updateUser).not.toHaveBeenCalled();
  });

  it("reports a refusal in a sentence rather than a status code", async () => {
    h.updateUser.mockResolvedValue({
      data: { user: null },
      error: { message: "Password should be at least 8 characters" },
    });
    const user = userEvent.setup();
    renderAccount();

    await user.click(await screen.findByRole("button", { name: /set a password/i }));
    await typeNewPassword("correct horse battery");
    await user.click(screen.getByRole("button", { name: /set a password/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/at least 8 characters/i);
  });
});

describe("signing out", () => {
  it("clears the cache before it sends the person to the sign-in page", async () => {
    const user = userEvent.setup();
    const client = renderAccount();
    // Something in the cache, which is the state that makes this worth asserting.
    client.setQueryData(["weights", "user-1"], [{ weight_kg: 71 }]);
    expect(client.getQueryCache().getAll()).toHaveLength(1);

    await user.click(await screen.findByRole("button", { name: /sign out/i }));

    expect(h.signOut).toHaveBeenCalledTimes(1);
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(h.navigate).toHaveBeenCalledWith({ to: "/auth" });
  });

  it("stays put and says why when the sign-out itself fails", async () => {
    h.signOut.mockResolvedValue({ error: { message: "Failed to fetch" } });
    const user = userEvent.setup();
    const client = renderAccount();
    client.setQueryData(["weights", "user-1"], [{ weight_kg: 71 }]);

    await user.click(await screen.findByRole("button", { name: /sign out/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/reach the server/i);
    // Nothing was cleared and nothing navigated: they are still signed in.
    expect(client.getQueryCache().getAll()).toHaveLength(1);
    expect(h.navigate).not.toHaveBeenCalled();
  });
});

describe("the day's analyses, in one line", () => {
  it("shows the line it was given, reset and all", () => {
    renderAccount({
      remainingAnalyses: {
        line: "14 of 20 photo analyses left today · resets at midnight",
        note: null,
      },
    });

    expect(
      screen.getByText("14 of 20 photo analyses left today · resets at midnight"),
    ).toBeInTheDocument();
  });

  it("keeps the way through when the day is used up", () => {
    renderAccount({
      remainingAnalyses: {
        line: "0 of 20 photo analyses left today · resets at midnight",
        note: "You can still add meals by typing the numbers yourself.",
      },
    });

    expect(screen.getByText(/0 of 20 photo analyses left today/)).toBeInTheDocument();
    expect(screen.getByText(/typing the numbers yourself/)).toBeInTheDocument();
  });

  it("shows nothing when the count could not be read", () => {
    renderAccount({ remainingAnalyses: null });

    // A number that might be wrong is worse than no number on a settings page.
    expect(screen.queryByText(/photo analyses left today/)).toBeNull();
  });
});

describe("finding the password control", () => {
  it("labels the row, so the control is not a bare button beside Sign out", async () => {
    h.getUser.mockResolvedValue(account(["email"]));
    h.authEntryState.mockResolvedValue("link_only");

    renderAccount();

    expect(await screen.findByText("Password")).toBeInTheDocument();
    // The sentence that says what setting one would do, which is what a link-only account needs.
    expect(screen.getByText(/set a password to sign in without waiting/i)).toBeInTheDocument();
  });

  it("describes the other case in the same place", async () => {
    h.getUser.mockResolvedValue(account(["email"]));
    h.authEntryState.mockResolvedValue("has_password");

    renderAccount();

    expect(await screen.findByText(/you can sign in with this password/i)).toBeInTheDocument();
  });
});
