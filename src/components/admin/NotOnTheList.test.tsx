/**
 * The two screens the invite gate can show, and the difference between them.
 *
 * The bug these pin: a failed check was reported as a refusal, so a dropped connection told a
 * signed-in person they had been taken off the list. Access still fails closed - that was never the
 * problem - but the screen must stop asserting something it does not know.
 *
 * The second thing they pin is who may undo an admin's decision. This screen asks on the person's
 * behalf, without anybody pressing anything, so it calls `request_invite` with `auto: true`: a
 * revoked invitation stays revoked and a declined request stays declined. `auto` being passed is
 * asserted directly, because the rule lives in the database and this is the only place the flag is
 * set.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { requestInvite } from "@/lib/invite-request";
import { NotOnTheList } from "./NotOnTheList";

const invalidate = vi.fn(() => Promise.resolve());

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { signOut: vi.fn() } },
}));

vi.mock("@/lib/invite-request", async (importOriginal) => ({
  // The address constant comes from the real module: `InviteAddress` reads it, and a second copy of
  // the mailbox in a test is a second copy that can disagree with the one people are told to write
  // to.
  ...(await importOriginal<typeof import("@/lib/invite-request")>()),
  requestInvite: vi.fn(),
}));

const request = requestInvite as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  invalidate.mockClear();
  request.mockReset();
  request.mockResolvedValue("requested");
});

describe("a check that could not be completed", () => {
  it("says so, instead of telling them they are not invited", () => {
    render(<NotOnTheList email="a@example.com" reason="unavailable" />);

    expect(screen.getByRole("heading")).toHaveTextContent(/couldn't check/i);
    expect(screen.queryByText(/isn't on the invite list/i)).toBeNull();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("offers a way to try again", async () => {
    const user = userEvent.setup();
    render(<NotOnTheList email="a@example.com" reason="unavailable" />);

    await user.click(screen.getByRole("button", { name: /try again/i }));

    // Re-runs the layout's `beforeLoad`, which is where the check actually lives.
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("does not ask for an invite on behalf of someone who may already be on the list", async () => {
    render(<NotOnTheList email="a@example.com" reason="unavailable" />);

    await waitFor(() => expect(request).not.toHaveBeenCalled());
  });
});

describe("a genuine refusal", () => {
  it("uses the invite-only wording, and does not send them looking for an owner", async () => {
    render(<NotOnTheList email="a@example.com" reason="denied" />);

    expect(screen.getByRole("heading")).toHaveTextContent(/invite-only right now/i);
    expect(screen.getByText(/isn't on the list yet/i)).toBeInTheDocument();
    // The old copy told a stranger to "ask the account owner", which is not something they can do.
    expect(screen.queryByText(/account owner/i)).toBeNull();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  });

  it("asks automatically, and never as an explicit request", async () => {
    render(<NotOnTheList email="a@example.com" reason="denied" />);

    await waitFor(() => expect(request).toHaveBeenCalledWith("a@example.com", { auto: true }));
  });

  it("says the request is in, and offers no button to send it again", async () => {
    render(<NotOnTheList email="a@example.com" reason="denied" />);

    expect(await screen.findByText(/your request is in/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /request access/i })).toBeNull();
  });

  it("says already asked, in its own words, when the request was already waiting", async () => {
    request.mockResolvedValueOnce("already_pending");
    render(<NotOnTheList email="a@example.com" reason="denied" />);

    expect(await screen.findByText(/already requested an invite/i)).toBeInTheDocument();
  });

  it("offers the address as well, because a recorded request is not the only way in", async () => {
    // The automatic request succeeds here, which is the state that used to leave this screen with
    // nothing a person could act on: the row is written for them, but they cannot say anything
    // themselves.
    render(<NotOnTheList email="a@example.com" reason="denied" />);

    expect(await screen.findByText(/your request is in/i)).toBeInTheDocument();
    expect(screen.getByText(/or email/i)).toHaveTextContent("Or email invites@tracknutri.app");
    expect(screen.getByRole("button", { name: /^copy$/i })).toBeInTheDocument();
  });

  it("offers it when the request was refused too", async () => {
    request.mockResolvedValueOnce("rate_limited");
    render(<NotOnTheList email="a@example.com" reason="denied" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't record/i);
    expect(screen.getByRole("button", { name: /^copy$/i })).toBeInTheDocument();
  });

  it("does not claim a request was sent when nothing was recorded", async () => {
    // The point of this section: never reassure somebody about a request the database refused.
    request.mockResolvedValueOnce(null);
    render(<NotOnTheList email="a@example.com" reason="denied" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't record/i);
    expect(screen.queryByText(/your request is in/i)).toBeNull();
    expect(screen.getByRole("button", { name: /request access/i })).toBeInTheDocument();
  });

  it("offers the button when the call fails, and retries when it is pressed", async () => {
    request.mockResolvedValueOnce(null);
    const user = userEvent.setup();
    render(<NotOnTheList email="a@example.com" reason="denied" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't record/i);

    request.mockResolvedValueOnce("requested");
    await user.click(screen.getByRole("button", { name: /request access/i }));

    expect(await screen.findByText(/your request is in/i)).toBeInTheDocument();
  });
});
