/**
 * The trial page's two refusals: an invited address is sent to sign in, and a visitor
 * who has used all ten scans meets the wall that asks for an invite.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { TrialPage } from "./try";

const mocks = vi.hoisted(() => ({
  sendTrialCode: vi.fn(),
  verifyTrialCode: vi.fn(),
  parseTrialMeal: vi.fn(),
  getStoredTrial: vi.fn(),
  getTrialScansLimit: vi.fn(),
  requestInvite: vi.fn(),
}));

vi.mock("@/lib/trial", () => ({
  getStoredTrial: (...args: unknown[]) => mocks.getStoredTrial(...args),
  storeTrial: vi.fn(),
  clearTrial: vi.fn(),
  sendTrialCode: (...args: unknown[]) => mocks.sendTrialCode(...args),
  verifyTrialCode: (...args: unknown[]) => mocks.verifyTrialCode(...args),
  parseTrialMeal: (...args: unknown[]) => mocks.parseTrialMeal(...args),
  getTrialScansLimit: (...args: unknown[]) => mocks.getTrialScansLimit(...args),
}));

vi.mock("@/lib/invite-request", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/invite-request")>();
  return {
    ...actual,
    requestInvite: (...args: unknown[]) => mocks.requestInvite(...args),
  };
});

vi.mock("@/lib/turnstile", () => ({
  turnstileSiteKey: () => "test-site-key",
  loadTurnstile: async () => {},
  turnstileApi: () => ({
    render: (_el: HTMLElement, options: Record<string, unknown>) => {
      const callback = options["callback"] as (token: string) => void;
      callback("test-token");
      return "widget-1";
    },
    remove: () => {},
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn(),
    storage: { from: vi.fn() },
    auth: { getSession: vi.fn(async () => ({ data: { session: null } })) },
  },
}));

// The page renders router <Link>s; render them as plain anchors rather than stand up a
// full router for a two-case test.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const ReactModule = await import("react");
  return {
    ...actual,
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
  mocks.sendTrialCode.mockReset();
  mocks.verifyTrialCode.mockReset();
  mocks.parseTrialMeal.mockReset();
  mocks.getStoredTrial.mockReset();
  mocks.getStoredTrial.mockReturnValue(null);
  mocks.getTrialScansLimit.mockReset();
  mocks.getTrialScansLimit.mockResolvedValue(10);
  mocks.requestInvite.mockReset();
  mocks.requestInvite.mockResolvedValue("requested");
});

function parsedWith(scansLeft: number) {
  return {
    items: [],
    scans_left: scansLeft,
    meal_type: "lunch",
    source: "text",
    model: "fake",
    attempts: 1,
  };
}

describe("the trial page", () => {
  it("opens with the intro and no scan count up front", async () => {
    render(<TrialPage />);

    expect(
      await screen.findByText(
        "Try NutriTrack free. We'll email you a code to start. Trial results aren't saved.",
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\bscans?\b/i);
    expect(document.body.textContent).not.toContain("10");
  });

  it("shows the scans left only at 3 and at 1", async () => {
    mocks.getStoredTrial.mockReturnValue({ token: "token-1", email: "trial@example.com" });
    render(<TrialPage />);
    const user = userEvent.setup();

    const seen: Array<[number, string | null]> = [];
    for (const left of [9, 3, 2, 1]) {
      mocks.parseTrialMeal.mockResolvedValueOnce(parsedWith(left));
      await user.type(await screen.findByPlaceholderText(/type what you ate/i), "dal");
      await user.click(screen.getByRole("button", { name: /analyse/i }));
      await screen.findByRole("button", { name: /scan another meal/i });
      seen.push([left, screen.queryByRole("status")?.textContent ?? null]);
      expect(document.body.textContent).not.toMatch(/scans left:/i);
      await user.click(screen.getByRole("button", { name: /scan another meal/i }));
    }

    expect(seen).toEqual([
      [9, null],
      [3, "3 scans left. Join to keep tracking."],
      [2, null],
      [1, "1 scan left. Join to keep tracking."],
    ]);
  });

  it("sends an invited address to sign in instead of starting a trial", async () => {
    mocks.sendTrialCode.mockResolvedValue({
      status: "already_access",
      email: "invited@example.com",
    });

    render(<TrialPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "invited@example.com");
    await user.click(screen.getByRole("button", { name: /email me a code/i }));

    expect(await screen.findByText("You already have access.")).toBeTruthy();
    expect(mocks.sendTrialCode).toHaveBeenCalledWith("invited@example.com", "", expect.any(String));
  });

  it("shows the wall and asks for an invite when the scans run out", async () => {
    mocks.getStoredTrial.mockReturnValue({ token: "token-1", email: "trial@example.com" });
    mocks.parseTrialMeal.mockResolvedValue({
      items: [],
      scans_left: 0,
      meal_type: "lunch",
      source: "text",
      model: "fake",
      attempts: 1,
    });

    render(<TrialPage />);
    const user = userEvent.setup();

    await user.type(await screen.findByPlaceholderText(/type what you ate/i), "dal and roti");
    await user.click(screen.getByRole("button", { name: /analyse/i }));

    expect(await screen.findByText(/used your 10 free scans/i)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /request an invite/i }));

    expect(mocks.requestInvite).toHaveBeenCalledWith(
      "trial@example.com",
      expect.objectContaining({ fromTrial: true }),
    );
  });
});
