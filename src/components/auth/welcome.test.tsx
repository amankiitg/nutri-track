/**
 * The screen the emailed link lands on, which is the only place a first password is ever set.
 *
 * The order of these tests is the order of the argument: a session is what makes this screen exist,
 * a password is optional once it does, and somebody who already finished setting up is sent on rather
 * than shown a form they do not need.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  getSession: vi.fn(),
  updateUser: vi.fn(),
  fetchProfile: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: { component: React.ComponentType }) => ({ options }),
  useRouter: () => ({ history: { replace: h.replace } }),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: h.getSession, updateUser: h.updateUser } },
}));

vi.mock("@/lib/profile", () => ({ fetchProfile: h.fetchProfile }));

import { Route } from "@/routes/auth_.welcome";

const Page = (Route as unknown as { options: { component: React.ComponentType } }).options
  .component;

beforeEach(() => {
  vi.clearAllMocks();
  h.getSession.mockResolvedValue({ data: { session: { user: { id: "user-1" } } } });
  h.updateUser.mockResolvedValue({ data: {}, error: null });
  h.fetchProfile.mockResolvedValue(null);
});

describe("after the link", () => {
  it("offers a password as optional, and a way past it", async () => {
    render(<Page />);

    expect(await screen.findByRole("heading", { name: "You're in" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^confirm password$/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /skip, take me in/i })).toBeInTheDocument();
  });

  it("sets the password the person just proved they own the inbox for", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<Page />);

    await user.type(await screen.findByLabelText(/^password$/i), "hunter2hunter2");
    await user.type(screen.getByLabelText(/^confirm password$/i), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: /^set password$/i }));

    await waitFor(() => expect(h.updateUser).toHaveBeenCalledWith({ password: "hunter2hunter2" }));
    // Onboarding is next either way: the password was never the last step.
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/onboarding"));
  });

  it("refuses two passwords that do not match, without asking the server", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<Page />);

    await user.type(await screen.findByLabelText(/^password$/i), "hunter2hunter2");
    await user.type(screen.getByLabelText(/^confirm password$/i), "hunter2hunter3");
    await user.click(screen.getByRole("button", { name: /^set password$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Those two passwords don't match.");
    expect(h.updateUser).not.toHaveBeenCalled();
  });

  it("skips straight to onboarding when the password is not wanted", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<Page />);

    await user.click(await screen.findByRole("button", { name: /skip, take me in/i }));

    expect(h.replace).toHaveBeenCalledWith("/onboarding");
    expect(h.updateUser).not.toHaveBeenCalled();
  });
});

describe("when the link is not a way in", () => {
  it("says it expired rather than showing a form that cannot work", async () => {
    h.getSession.mockResolvedValue({ data: { session: null } });
    render(<Page />);

    expect(
      await screen.findByRole("heading", { name: /that link has expired/i }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/^password$/i)).toBeNull();
  });

  it("sends somebody who is already set up to Today", async () => {
    h.fetchProfile.mockResolvedValue({ user_id: "user-1" });
    render(<Page />);

    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/today"));
  });
});
