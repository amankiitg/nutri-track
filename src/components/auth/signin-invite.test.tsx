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
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
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

  it("blames the password when the address is on the list", async () => {
    h.signInWithPassword.mockResolvedValueOnce(CREDENTIALS_REFUSED);
    h.rpc.mockResolvedValueOnce({ data: true, error: null });

    await attemptSignIn("invited@example.com");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /that email and password don't match/i,
    );
    expect(screen.queryByRole("heading", { name: /invite-only/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /request access/i })).toBeNull();
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
