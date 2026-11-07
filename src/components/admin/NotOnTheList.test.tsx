/**
 * The two screens the invite gate can show, and the difference between them.
 *
 * The bug these pin: a failed check was reported as a refusal, so a dropped connection told a
 * signed-in person they had been taken off the list. Access still fails closed — that was never
 * the problem — but the screen must stop asserting something it does not know.
 *
 * The second assertion matters as much as the copy: `invite_requests` is the one write an
 * uninvited person can cause, and a check that never completed is no reason to file one on
 * behalf of somebody who may already be on the list.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fetchOwnRequest, recordInviteRequest } from "@/lib/admin";
import { NotOnTheList } from "./NotOnTheList";

const invalidate = vi.fn(() => Promise.resolve());

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { signOut: vi.fn() } },
}));

vi.mock("@/lib/admin", () => ({
  fetchOwnRequest: vi.fn(),
  recordInviteRequest: vi.fn(),
}));

const ownRequest = fetchOwnRequest as unknown as ReturnType<typeof vi.fn>;
const inviteRequest = recordInviteRequest as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  invalidate.mockClear();
  ownRequest.mockReset();
  inviteRequest.mockReset();
  ownRequest.mockResolvedValue(null);
  inviteRequest.mockResolvedValue(true);
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

  it("does not file an invite request for someone who may already be on the list", async () => {
    render(<NotOnTheList email="a@example.com" reason="unavailable" />);

    await waitFor(() => {
      expect(ownRequest).not.toHaveBeenCalled();
      expect(inviteRequest).not.toHaveBeenCalled();
    });
  });
});

describe("a genuine refusal", () => {
  it("uses the invite-only wording, and does not send them looking for an owner", async () => {
    render(<NotOnTheList email="a@example.com" reason="denied" />);

    expect(screen.getByRole("heading")).toHaveTextContent(/invite-only right now/i);
    expect(screen.getByText(/isn't on the list yet/i)).toBeInTheDocument();
    // The old copy told a stranger to "ask the account owner", which is not something they can do.
    expect(screen.queryByText(/account owner/i)).toBeNull();
    await waitFor(() => expect(inviteRequest).toHaveBeenCalledTimes(1));
  });

  it("says the request was sent, and offers no button to send it again", async () => {
    render(<NotOnTheList email="a@example.com" reason="denied" />);

    expect(await screen.findByRole("status")).toHaveTextContent(/request sent/i);
    expect(screen.queryByRole("button", { name: /request access/i })).toBeNull();
  });

  it("does not claim a request was sent when the row was not recorded", async () => {
    // The point of this section: never reassure somebody about a request the database refused.
    inviteRequest.mockResolvedValueOnce(false);
    render(<NotOnTheList email="a@example.com" reason="denied" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't record/i);
    expect(screen.queryByText(/request sent/i)).toBeNull();
    expect(screen.getByRole("button", { name: /request access/i })).toBeInTheDocument();
  });

  it("offers the button when the call throws, and retries when it is pressed", async () => {
    inviteRequest.mockRejectedValueOnce(new Error("Couldn't reach the server."));
    const user = userEvent.setup();
    render(<NotOnTheList email="a@example.com" reason="denied" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/reach the server/i);

    inviteRequest.mockResolvedValueOnce(true);
    await user.click(screen.getByRole("button", { name: /request access/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/request sent/i);
  });
});
