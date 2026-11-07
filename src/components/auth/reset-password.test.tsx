/**
 * The page the reset link lands on.
 *
 * Two things have to be right and they are different things: a usable link sets a password and
 * leaves the person signed in on Today, and an unusable one says so instead of pretending the
 * password was wrong. The second is the case that strands people, because a link that expired
 * yesterday is not a typing mistake and re-typing the password never fixes it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  getSession: vi.fn(),
  updateUser: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: { component: React.ComponentType }) => ({ options }),
  useRouter: () => ({ history: { replace: h.replace } }),
  // Serialised rather than dropped, so a test can assert where "request a new one" points.
  Link: ({
    to,
    search,
    children,
  }: {
    to: string;
    search?: Record<string, unknown>;
    children: ReactNode;
  }) => {
    const query =
      search === undefined
        ? ""
        : `?${new URLSearchParams(Object.entries(search).map(([key, value]) => [key, String(value)])).toString()}`;
    return createElement("a", { href: `${to}${query}` }, children);
  },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: h.getSession,
      updateUser: h.updateUser,
    },
  },
}));

import { Route } from "@/routes/auth_.reset";

const Page = (Route as unknown as { options: { component: React.ComponentType } }).options
  .component;

const SESSION = { data: { session: { access_token: "token" } } };

async function typePassword(password: string, confirmation = password): Promise<void> {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText(/^new password$/i), password);
  await user.type(screen.getByLabelText(/^confirm password$/i), confirmation);
  await user.click(screen.getByRole("button", { name: /set a new password/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "";
  h.getSession.mockResolvedValue(SESSION);
  h.updateUser.mockResolvedValue({ data: { user: null }, error: null });
});

describe("a usable reset link", () => {
  it("sets the password and leaves the person on Today", async () => {
    render(<Page />);

    await typePassword("correct horse battery");

    expect(h.updateUser).toHaveBeenCalledWith({ password: "correct horse battery" });
    expect(h.replace).toHaveBeenCalledWith("/today");
  });

  it("reveals both fields from either toggle, because they are one decision", async () => {
    const user = userEvent.setup();
    render(<Page />);
    const next = await screen.findByLabelText(/^new password$/i);
    const confirm = screen.getByLabelText(/^confirm password$/i);
    expect(next).toHaveAttribute("type", "password");

    // The second field's toggle, pressed deliberately: either one drives the pair.
    const toggles = screen.getAllByRole("button", { name: /show password/i });
    expect(toggles).toHaveLength(2);
    await user.click(toggles[1]!);

    expect(next).toHaveAttribute("type", "text");
    expect(confirm).toHaveAttribute("type", "text");
    expect(screen.getAllByRole("button", { name: /hide password/i })).toHaveLength(2);
  });

  it("refuses two different passwords before it sends anything", async () => {
    render(<Page />);

    await typePassword("correct horse battery", "correct horse batteries");

    expect(await screen.findByRole("alert")).toHaveTextContent(/don't match/i);
    expect(h.updateUser).not.toHaveBeenCalled();
  });

  it("refuses a short password before it sends anything", async () => {
    render(<Page />);

    // The field carries `minLength`, so this is the belt to that braces: a paste or an autofill
    // that bypasses the attribute still meets the rule.
    await typePassword("short", "short");

    expect(h.updateUser).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
  });
});

describe("a link that cannot be used", () => {
  it("says so and offers to request another, when there is no session", async () => {
    h.getSession.mockResolvedValue({ data: { session: null } });

    render(<Page />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That link has expired. Request a new one.",
    );
    // Straight to the reset step, which is what "request a new one" means in practice.
    expect(screen.getByRole("link", { name: /request a new link/i })).toHaveAttribute(
      "href",
      "/auth?tab=signin&forgot=true",
    );
    // No password form to fill in, because there is nothing to attach it to.
    expect(screen.queryByLabelText(/^new password$/i)).toBeNull();
  });

  it("treats an error in the fragment as expired even when a session is present", async () => {
    // What an already-used link looks like: Supabase hands back the reason in the fragment and
    // the SDK leaves no session behind. Modelling both at once is the honest case.
    window.location.hash = "#error=access_denied&error_description=Email+link+is+invalid";

    render(<Page />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/that link has expired/i);
  });

  it("reads a missing session on update as a dead link, not a bad password", async () => {
    h.updateUser.mockResolvedValue({
      data: { user: null },
      error: { message: "Auth session missing!" },
    });

    render(<Page />);
    await typePassword("correct horse battery");

    expect(await screen.findByRole("alert")).toHaveTextContent(/that link has expired/i);
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("passes anything else through the sentence map", async () => {
    h.updateUser.mockResolvedValue({
      data: { user: null },
      error: { message: "Password should be at least 8 characters" },
    });

    render(<Page />);
    await typePassword("correct horse battery");

    expect(await screen.findByRole("alert")).toHaveTextContent(/at least 8 characters/i);
  });
});
