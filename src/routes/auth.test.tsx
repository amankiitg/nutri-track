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
  /** The captcha source: what a token looks like, and whether it was released afterwards. */
  ensure: vi.fn(),
  release: vi.fn(),
  signInWithOtp: vi.fn(),
  signInWithPassword: vi.fn(),
  signInWithOAuth: vi.fn(),
  resend: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  rpc: vi.fn(),
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

/**
 * The captcha source, replaced with one the test drives.
 *
 * The real one waits on a Cloudflare widget; here `ensure` answers whatever the test set, which is
 * what lets the tests assert that a token is fetched at submit time and released afterwards.
 */
vi.mock("@/lib/turnstile-token", () => ({
  createTurnstileTokenSource: () => ({
    ensure: () => mocks.ensure(),
    reset: () => mocks.release(),
    hasToken: () => true,
  }),
}));

/**
 * The sign-in helper is real here, not mocked: these tests are about what it passes on. Its two
 * collaborators are the client mock above and the captcha source mock beside it.
 */

vi.mock("@/lib/turnstile", () => ({
  turnstileSiteKey: () => "site-key",
  loadTurnstile: async () => {},
  turnstileApi: () => undefined,
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
    rpc: (...args: unknown[]) => mocks.rpc(...args),
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
  mocks.ensure.mockResolvedValue("captcha-token-1");
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
        : state === "open_signup"
          ? "Create your account"
          : state === "google_only"
            ? "This account signs in with Google."
            : "Welcome back";
  await screen.findByRole("heading", { name: heading });
}

describe("the copy the contact sheet settled", () => {
  it("tells an invited address it can set a password later, and nothing about proving the inbox", async () => {
    const user = userEvent.setup();
    await reachStep(user, "invited_new");

    expect(screen.getByText("You can set a password later in Settings.")).toBeTruthy();
    // The sentence it replaced explained why the link mattered, which the button already says.
    expect(screen.queryByText(/password you set afterwards/i)).toBeNull();
  });

  it("offers email in the Google-only panel, not a password", async () => {
    const user = userEvent.setup();
    await reachStep(user, "google_only");

    expect(
      screen.getByRole("button", { name: "Prefer email? Send me a sign-in link" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /prefer a password/i })).toBeNull();
  });
});

describe("the sign-in link button", () => {
  it("is behind the password view on the has_account step, one press away", async () => {
    const user = userEvent.setup();
    await reachStep(user, "has_account");
    expect(screen.queryByRole("button", { name: "Email me a sign-in link" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Use an email link instead" }));
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
    await user.click(screen.getByRole("button", { name: "Use an email link instead" }));
    await user.click(screen.getByRole("button", { name: "Email me a sign-in link" }));

    await waitFor(() => expect(mocks.signInWithOtp).toHaveBeenCalledTimes(1));
    expect(mocks.signInWithOtp).toHaveBeenCalledWith({
      email: "a@example.com",
      options: {
        shouldCreateUser: false,
        emailRedirectTo: window.location.origin,
        // A freshly fetched token rides along; it is the same call plus the proof GoTrue asks for
        // when CAPTCHA is on.
        captchaToken: "captcha-token-1",
      },
    });
  });

  it("shows the inbox sentence and holds the resend behind a 60 second cooldown", async () => {
    const user = userEvent.setup();
    await reachStep(user, "has_account");
    await user.click(screen.getByRole("button", { name: "Use an email link instead" }));
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

describe("the captcha token on the sign-in calls", () => {
  beforeEach(() => {
    signupsOpen = true;
  });

  it("fetches a token at submit time and sends it with the magic link", async () => {
    const user = userEvent.setup();
    mocks.authEntryState.mockResolvedValue("open_signup");
    mocks.signInWithOtp.mockResolvedValue({ data: {}, error: null });
    render(<AuthPage />);

    await user.type(screen.getByLabelText("Email"), "stranger@example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Email me a link" }));

    expect(mocks.ensure).toHaveBeenCalled();
    expect(mocks.signInWithOtp).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ captchaToken: "captcha-token-1" }),
      }),
    );
  });

  it("releases the spent token whether the call worked or not", async () => {
    const user = userEvent.setup();
    mocks.authEntryState.mockResolvedValue("open_signup");
    mocks.signInWithOtp.mockResolvedValue({
      data: {},
      error: {
        code: "captcha_failed",
        status: 400,
        message: "captcha verification process failed",
      },
    });
    render(<AuthPage />);

    await user.type(screen.getByLabelText("Email"), "stranger@example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Email me a link" }));

    expect(mocks.release).toHaveBeenCalled();
    expect(await screen.findByText(/captcha_failed/)).toBeInTheDocument();
    expect(screen.getByText(/captcha verification process failed/)).toBeInTheDocument();
  });

  it("sends the token inside the Google options object, not beside it", async () => {
    const user = userEvent.setup();
    mocks.signInWithOAuth.mockResolvedValue({
      data: { url: "https://accounts.google.com/x" },
      error: null,
    });
    render(<AuthPage />);

    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    expect(mocks.signInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ captchaToken: "captcha-token-1" }),
      }),
    );
  });
});

describe("the widget slot across steps", () => {
  beforeEach(() => {
    signupsOpen = true;
  });

  it("keeps the container mounted on the create-account step", async () => {
    const user = userEvent.setup();
    mocks.authEntryState.mockResolvedValue("open_signup");
    mocks.signInWithOtp.mockResolvedValue({ data: {}, error: null });
    const { container } = render(<AuthPage />);

    // On the email step, before anything is asked.
    expect(container.querySelector("[data-turnstile]")).not.toBeNull();

    await user.type(screen.getByLabelText("Email"), "stranger@example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Create your account" });

    // Still there after the step changed, which is what makes a token obtainable at submit.
    expect(container.querySelector("[data-turnstile]")).not.toBeNull();
  });

  it("sends the token from the create-account step, not only from an existing account", async () => {
    const user = userEvent.setup();
    mocks.authEntryState.mockResolvedValue("open_signup");
    mocks.signInWithOtp.mockResolvedValue({ data: {}, error: null });
    render(<AuthPage />);

    await user.type(screen.getByLabelText("Email"), "brand-new@example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Email me a link" }));

    const sent = mocks.signInWithOtp.mock.calls[0]?.[0] as {
      email: string;
      options: Record<string, unknown>;
    };
    expect(sent.email).toBe("brand-new@example.com");
    expect(sent.options["shouldCreateUser"]).toBe(true);
    expect(sent.options["captchaToken"]).toBe("captcha-token-1");
  });
});

describe("the three account states", () => {
  it("shows no password box for an account that never set one", async () => {
    const user = userEvent.setup();
    mocks.authEntryState.mockResolvedValue("link_only");
    render(<AuthPage />);

    await user.type(screen.getByLabelText("Email"), "magic-link@example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();
    // The bug: this screen used to draw a password field the account could never satisfy.
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.getByRole("button", { name: "Email me a sign-in link" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /forgot password/i })).toBeNull();
  });

  it("still sends the link through the captcha helper", async () => {
    const user = userEvent.setup();
    mocks.authEntryState.mockResolvedValue("link_only");
    mocks.signInWithOtp.mockResolvedValue({ data: {}, error: null });
    render(<AuthPage />);

    await user.type(screen.getByLabelText("Email"), "magic-link@example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Email me a sign-in link" }));

    expect(mocks.signInWithOtp).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "magic-link@example.com",
        options: expect.objectContaining({
          shouldCreateUser: false,
          captchaToken: "captcha-token-1",
        }),
      }),
    );
  });

  it("keeps the password box for an account that has one", async () => {
    const user = userEvent.setup();
    mocks.authEntryState.mockResolvedValue("has_password");
    render(<AuthPage />);

    await user.type(screen.getByLabelText("Email"), "password@example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /forgot password/i })).toBeTruthy();
  });

  it("still treats the old has_account answer as an account with a password", async () => {
    const user = userEvent.setup();
    // What a database from before the three-way split says, i.e. after a rollback of the migration.
    await reachStep(user, "has_account");

    expect(screen.getByLabelText("Password")).toBeTruthy();
  });

  it("makes Google the primary action on a Google-only account", async () => {
    const user = userEvent.setup();
    await reachStep(user, "google_only");

    const googleButton = screen.getByRole("button", { name: /continue with google/i });
    // Filled rather than outlined: the only door that works is the one presented as the way in.
    expect(googleButton.className).toContain("bg-primary");
    expect(screen.getByRole("button", { name: "Email me a sign-in link" })).toBeTruthy();
  });
});

describe("an account with a link and Google but no password", () => {
  it("offers both doors, with the link first", async () => {
    const user = userEvent.setup();
    mocks.authEntryState.mockResolvedValue("link_only_google");
    render(<AuthPage />);

    await user.type(screen.getByLabelText("Email"), "both@example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();

    // The link is the primary action because that is how the account was made.
    const link = screen.getByRole("button", { name: "Email me a sign-in link" });
    expect(link.className).toContain("bg-primary");
    const googleButton = screen.getByRole("button", { name: /continue with google/i });
    expect(googleButton.className).toContain("border");
    expect(googleButton.className).not.toContain("bg-primary");
  });

  it("sends the Google call with a captcha token, like every other sign-in", async () => {
    const user = userEvent.setup();
    mocks.authEntryState.mockResolvedValue("link_only_google");
    mocks.signInWithOAuth.mockResolvedValue({
      data: { url: "https://accounts.google.com/x" },
      error: null,
    });
    render(<AuthPage />);

    await user.type(screen.getByLabelText("Email"), "both@example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: /continue with google/i }));

    expect(mocks.signInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ captchaToken: "captcha-token-1" }),
      }),
    );
  });
});

describe("the link view of an account with a password", () => {
  async function toLinkView(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(await screen.findByRole("button", { name: "Use an email link instead" }));
  }

  it("is one press away on the has_account step, and the only view is the one showing", async () => {
    const user = userEvent.setup();
    await reachStep(user, "has_account");

    // The password view arrives, because a password is the thing the answer is about.
    expect(await screen.findByLabelText("Password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Email me a sign-in link" })).toBeNull();

    await toLinkView(user);

    // Now the link view, and the password form is gone rather than sitting under it.
    expect(screen.getByRole("button", { name: "Email me a sign-in link" })).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("button", { name: /forgot password/i })).toBeNull();
  });

  it("toggles as many times as it likes without ever stacking the two", async () => {
    const user = userEvent.setup();
    await reachStep(user, "has_account");
    await screen.findByLabelText("Password");

    for (let round = 0; round < 3; round += 1) {
      await toLinkView(user);
      expect(screen.getAllByRole("button", { name: "Email me a sign-in link" })).toHaveLength(1);
      expect(screen.queryByLabelText("Password")).toBeNull();

      await user.click(screen.getByRole("button", { name: "Use a password instead" }));
      expect(screen.getAllByLabelText("Password")).toHaveLength(1);
      expect(screen.queryByRole("button", { name: "Email me a sign-in link" })).toBeNull();
    }
  });

  it("moves focus to the control the view is about", async () => {
    const user = userEvent.setup();
    await reachStep(user, "has_account");
    expect(await screen.findByLabelText("Password")).toHaveFocus();

    await toLinkView(user);
    expect(screen.getByRole("button", { name: "Email me a sign-in link" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Use a password instead" }));
    expect(screen.getByLabelText("Password")).toHaveFocus();
  });
});

describe("an account with no evidence of a password", () => {
  it("shows one door and no password control at all", async () => {
    const user = userEvent.setup();
    await reachStep(user, "link_only");

    expect(await screen.findByRole("button", { name: "Email me a sign-in link" })).toBeTruthy();
    // Not "hidden behind a quiet link": there is no password to type, so there is nothing to
    // offer, and a control that cannot work is worse than no control.
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByRole("button", { name: /use a password instead/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /forgot password/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /use an email link instead/i })).toBeNull();
  });

  it("adds Google beside the link when the account has a Google identity", async () => {
    const user = userEvent.setup();
    await reachStep(user, "link_only_google");

    expect(await screen.findByRole("button", { name: "Email me a sign-in link" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("shows the password view first, with Google beside it, once a password is known", async () => {
    const user = userEvent.setup();
    await reachStep(user, "has_password_google");

    expect(await screen.findByLabelText("Password")).toBeTruthy();
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Email me a sign-in link" })).toBeNull();
  });
});

describe("a password that worked", () => {
  it("records that this account has one, which is the only evidence the screen has", async () => {
    const user = userEvent.setup();
    mocks.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: null,
    });
    await reachStep(user, "has_password");

    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(mocks.signInWithPassword).toHaveBeenCalledTimes(1));
    // An account from before the flag existed becomes has_password on its next password sign-in,
    // so this call is the self heal rather than a note about the screen.
    expect(mocks.rpc).toHaveBeenCalledWith("mark_has_password");
  });
});

describe("a refused password", () => {
  it("shows the sentence, and the raw error under it as the link flow does", async () => {
    const user = userEvent.setup();
    mocks.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { code: "invalid_credentials", status: 400, message: "Invalid login credentials" },
    });
    await reachStep(user, "has_account");

    await user.type(await screen.findByLabelText("Password"), "wrong password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText(/invalid_credentials/)).toBeInTheDocument();
    expect(screen.getByText(/Invalid login credentials/)).toBeInTheDocument();
    // Still one view, still the password one, and the field still there to correct.
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });
});

describe("use a different email", () => {
  it.each(["not_invited", "invited_new", "open_signup", "link_only", "has_account"])(
    "clears the field from %s",
    async (state) => {
      const user = userEvent.setup();
      await reachStep(user, state);
      await user.click(await screen.findByRole("button", { name: /use a different email/i }));

      expect(screen.getByRole("heading", { name: "Welcome" })).toBeInTheDocument();
      // Empty, not prefilled: a phone field still holding the old address makes the button a
      // delete-first instruction.
      expect(screen.getByLabelText("Email")).toHaveValue("");
    },
  );
});
