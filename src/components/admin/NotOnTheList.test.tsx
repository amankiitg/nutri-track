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
  it("still says they are not on the list, and offers no retry", async () => {
    render(<NotOnTheList email="a@example.com" reason="denied" />);

    expect(screen.getByRole("heading")).toHaveTextContent(/not on the list/i);
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  it("files the invite request, so they do not have to ask twice", async () => {
    render(<NotOnTheList email="a@example.com" reason="denied" />);

    await waitFor(() => expect(inviteRequest).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("status")).toHaveTextContent(/request has been sent/i);
  });
});
