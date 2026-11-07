/**
 * The sign-in form's second question.
 *
 * "Invalid login credentials" is what the provider says both for a wrong password and for an
 * address that was never invited, and only one of those is worth retyping. So the screen asks the
 * invite list before blaming the password. Both answers are pinned here, through the form, because
 * what this replaces was a screen rather than a function: the sentence was right and the page was
 * a dead end.
 *
 * Lives outside `src/routes/` because the file-based router treats a `.test.tsx` in there as a
 * route.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  rpc: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  // The page is what is under test, not the router around it.
  createFileRoute: () => (options: { component: React.ComponentType }) => ({
    options,
    useSearch: () => ({}),
  }),
  useRouter: () => ({ history: { replace: h.replace } }),
  Link: ({ to, children }: { to: string; children: ReactNode }) =>
    createElement("a", { href: to }, children),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: null } }),
      signInWithPassword: h.signInWithPassword,
      resetPasswordForEmail: h.resetPasswordForEmail,
      signOut: vi.fn(),
    },
    rpc: h.rpc,
  },
}));

import { Route } from "@/routes/auth";

const Page = (Route as unknown as { options: { component: React.ComponentType } }).options
  .component;

const CREDENTIALS_REFUSED = {
  data: { user: null, session: null },
  error: { message: "Invalid login credentials" },
};

/** Fills the sign-in tab and submits it, which is the only way in from this screen. */
async function attemptSignIn(email: string): Promise<void> {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  render(<Page />);
  await user.type(screen.getByLabelText(/email/i), email);
  await user.type(screen.getByLabelText(/password/i), "hunter2hunter2");
  await user.click(screen.getByRole("button", { name: /^sign in$/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.signInWithPassword.mockResolvedValue({ data: { user: null, session: null }, error: null });
  h.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
  h.rpc.mockResolvedValue({ data: true, error: null });
});

describe("signing in with an address that was never invited", () => {
  it("shows the invite panel and a request that leaves as mail, not a password complaint", async () => {
    h.signInWithPassword.mockResolvedValueOnce(CREDENTIALS_REFUSED);
    h.rpc.mockResolvedValueOnce({ data: false, error: null });

    await attemptSignIn("stranger@example.com");

    expect(
      await screen.findByRole("heading", { name: /invite-only right now/i }),
    ).toBeInTheDocument();

    // The way out is a mailto: nobody is signed in, so there is no token for a row to take an
    // address from, and the request has to leave from the person's own mailbox.
    const request = screen.getByRole("link", { name: /request access/i });
    expect(request.getAttribute("href")).toContain("mailto:");
    expect(request.getAttribute("href")).toContain("Please%20invite%20stranger%40example.com");
    expect(
      screen.getByText(/your email app will open with the request ready to send/i),
    ).toBeInTheDocument();

    // And not the sentence that would send them round the loop again.
    expect(screen.queryByText(/don't match/i)).toBeNull();
    expect(h.rpc).toHaveBeenCalledWith("check_email_allowed", { _email: "stranger@example.com" });
    // Nothing navigated: they are not signed in.
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("names the two real ways out when the address is on the list", async () => {
    h.signInWithPassword.mockResolvedValueOnce(CREDENTIALS_REFUSED);
    h.rpc.mockResolvedValueOnce({ data: true, error: null });

    await attemptSignIn("invited@example.com");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "That email and password don't match. If you joined with Google, use Continue with Google above. Otherwise reset your password.",
    );
    // "or create an account" is gone: somebody with a wrong password has an account already.
    expect(alert).not.toHaveTextContent(/create an account/i);
    expect(screen.queryByRole("heading", { name: /invite-only/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /request access/i })).toBeNull();

    // The words in the sentence are buttons, and the Google one really does move the pointer.
    const googleInText = within(alert).getByRole("button", { name: /continue with google/i });
    await userEvent.setup({ pointerEventsCheck: 0 }).click(googleInText);

    // Two buttons carry this name now, one inside the sentence and the real one above it, so the
    // assertion names the one outside the alert rather than trusting the first match.
    const googleButton = screen
      .getAllByRole("button", { name: /^continue with google$/i })
      .filter((button) => !alert.contains(button));
    expect(googleButton).toHaveLength(1);
    expect(googleButton[0]).toHaveFocus();
  });

  it("does not ask the invite list about a failure that is not about the credentials", async () => {
    // A different refusal deserves a different sentence, and one round trip less. Asking here
    // would also let an unconfirmed address be told it is not invited.
    h.signInWithPassword.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { message: "Email not confirmed" },
    });

    await attemptSignIn("waiting@example.com");

    expect(await screen.findByRole("alert")).toHaveTextContent(/confirm your email/i);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("still goes to the page they were sent away from when the password is right", async () => {
    await attemptSignIn("invited@example.com");

    // `useSearch` is stubbed empty here, so this is the default destination; the sanitising of a
    // real `?redirect=` is covered in `auth-redirect.test.ts`.
    expect(h.replace).toHaveBeenCalledWith("/today");
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

/** The panel, reached the way a person reaches it: a sign-in that could not have worked. */
async function showPanel(): Promise<void> {
  h.signInWithPassword.mockResolvedValueOnce(CREDENTIALS_REFUSED);
  h.rpc.mockResolvedValueOnce({ data: false, error: null });
  await attemptSignIn("stranger@example.com");
  await screen.findByRole("heading", { name: /invite-only right now/i });
}

describe("the address to write to by hand", () => {
  it("is shown below the button, because the button needs a mail app and a device may have none", async () => {
    await showPanel();

    expect(screen.getByText(/or email/i)).toHaveTextContent("Or email invites@tracknutri.app");
    // One press selects the whole address. That is what the failed-copy message points at, so it
    // is not decoration: without it the fallback is selecting an address character by character.
    expect(screen.getByText("invites@tracknutri.app")).toHaveClass("select-all");
  });

  it("copies it when Copy is pressed, and says so", async () => {
    await showPanel();
    // Created before the stub is defined: `userEvent.setup` attaches its own clipboard, and
    // defining the spy first would let that stub replace it.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    await user.click(screen.getByRole("button", { name: /^copy$/i }));

    expect(writeText).toHaveBeenCalledWith("invites@tracknutri.app");
    expect(await screen.findByRole("button", { name: /copied/i })).toBeInTheDocument();
  });

  it("points at the text instead of claiming a copy when the browser refuses", async () => {
    await showPanel();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")) },
      configurable: true,
      writable: true,
    });

    await user.click(screen.getByRole("button", { name: /^copy$/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/select the address above/i);
  });
});

describe("forgetting a password", () => {
  /** Opens the sign-in tab's reset step, with whatever address was typed first. */
  async function openResetStep(typed: string) {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<Page />);
    if (typed !== "") await user.type(screen.getByLabelText(/^email$/i), typed);
    await user.click(screen.getByRole("button", { name: /forgot password/i }));
    return user;
  }

  it("carries the address over, sends the link, and answers the same way either way", async () => {
    const user = await openResetStep("invited@example.com");

    // Prefilled from the sign-in field, so nobody types it twice.
    expect(screen.getByLabelText(/^email$/i)).toHaveValue("invited@example.com");
    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    // The sentence never says whether the address has an account: that answer is a way to ask
    // whether somebody uses this app.
    expect(await screen.findByRole("status")).toHaveTextContent(
      "If that email has a password account, a reset link is on its way. Check spam too.",
    );
    expect(h.resetPasswordForEmail).toHaveBeenCalledWith("invited@example.com", {
      redirectTo: expect.stringContaining("/auth/reset"),
    });
  });

  it("says the same thing when Supabase reports nothing for the address", async () => {
    // `resetPasswordForEmail` resolves for an unknown address, which is the whole reason the
    // sentence can be unconditional rather than hedged.
    h.resetPasswordForEmail.mockResolvedValueOnce({ data: {}, error: null });
    const user = await openResetStep("nobody@example.com");

    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/a reset link is on its way/i);
  });

  it("holds the button for a minute after a send", async () => {
    const user = await openResetStep("invited@example.com");
    await user.click(screen.getByRole("button", { name: /send reset link/i }));
    await screen.findByRole("status");

    await user.click(screen.getByRole("button", { name: /back to sign in/i }));
    await user.click(screen.getByRole("button", { name: /forgot password/i }));

    expect(screen.getByRole("button", { name: /send again in 60s/i })).toBeDisabled();
    // And one send, not two: the guard is real, not only a label.
    expect(h.resetPasswordForEmail).toHaveBeenCalledTimes(1);
  });
});
