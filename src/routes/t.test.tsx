/**
 * A personal trial link, opened: straight to the meal step for a good link, the sign-in
 * wall when the invited trial runs out, and the right screen for every way it can be
 * refused before or after the first scan.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { TrialLink } from "./t.$token";
import { TrialRequestError } from "@/lib/trial";

const mocks = vi.hoisted(() => ({
  verifyTrialLink: vi.fn(),
  parseTrialMeal: vi.fn(),
  getTrialSettings: vi.fn(),
  loadTurnstile: vi.fn(),
  requestInvite: vi.fn(),
}));

vi.mock("@/lib/trial", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/trial")>();
  return {
    ...actual,
    verifyTrialLink: (...args: unknown[]) => mocks.verifyTrialLink(...args),
    parseTrialMeal: (...args: unknown[]) => mocks.parseTrialMeal(...args),
    getTrialSettings: (...args: unknown[]) => mocks.getTrialSettings(...args),
  };
});

// No site key at all: a personal link must not need Turnstile.
vi.mock("@/lib/turnstile", () => ({
  turnstileSiteKey: () => null,
  loadTurnstile: (...args: unknown[]) => mocks.loadTurnstile(...args),
  turnstileApi: () => undefined,
}));

vi.mock("@/lib/invite-request", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/invite-request")>();
  return {
    ...actual,
    requestInvite: (...args: unknown[]) => mocks.requestInvite(...args),
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: vi.fn(), from: vi.fn(), auth: { getSession: vi.fn() } },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const ReactModule = await import("react");
  return {
    ...actual,
    Link: ({
      to,
      search,
      children,
      className,
    }: {
      to: string;
      search?: { email?: string };
      children?: React.ReactNode;
      className?: string;
    }) =>
      ReactModule.createElement(
        "a",
        { href: search?.email ? to + "?email=" + search.email : to, className },
        children,
      ),
  };
});

const TOKEN = "eyJlbWFpbCI6InByaXlhQGV4YW1wbGUuY29tIn0.c2ln";

function parsed(scansLeft: number) {
  return {
    items: [
      {
        name: "Dal",
        calories: 300,
        protein_g: 12,
        carbs_g: 40,
        fat_g: 8,
        cooking_fat: null,
      },
    ],
    scans_left: scansLeft,
    meal_type: "lunch",
    source: "text",
    model: "fake",
    attempts: 1,
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getTrialSettings.mockResolvedValue({ scansLimit: 10, requireEmail: false });
  mocks.verifyTrialLink.mockResolvedValue({
    status: "ok",
    email: "priya@example.com",
    firstName: "Priya",
    scansLeft: 10,
    scansTotal: 10,
    invited: true,
  });
  mocks.requestInvite.mockResolvedValue("requested");
});

async function scanOnce(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByPlaceholderText(/type what you ate/i), "dal");
  await user.click(screen.getByRole("button", { name: /analyse/i }));
}

describe("a valid personal link", () => {
  it("greets the person and opens the meal step, with no email, code or Turnstile", async () => {
    render(<TrialLink token={TOKEN} />);

    expect(await screen.findByRole("heading", { name: "Hi Priya, try a meal" })).toBeTruthy();
    expect(await screen.findByPlaceholderText(/type what you ate/i)).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByRole("button", { name: /email me a code/i })).toBeNull();
    expect(mocks.loadTurnstile).not.toHaveBeenCalled();
    expect(mocks.verifyTrialLink).toHaveBeenCalledWith(TOKEN);
    // Stored where the code flow stores its token, so the scans that follow are ordinary trial scans.
    expect(localStorage.getItem("nutritrack-trial-token")).toBe(TOKEN);
    expect(localStorage.getItem("nutritrack-trial-email")).toBe("priya@example.com");
    expect(localStorage.getItem("nutritrack-trial-invited")).toBe("1");
  });

  it("says Hi there when the admin gave no name", async () => {
    mocks.verifyTrialLink.mockResolvedValue({
      status: "ok",
      email: "x@example.com",
      firstName: null,
      scansLeft: 10,
      scansTotal: 10,
      invited: true,
    });
    render(<TrialLink token={TOKEN} />);
    expect(await screen.findByRole("heading", { name: "Hi there, try a meal" })).toBeTruthy();
  });

  it("scans with the link's token, warns at 3 and at 1, and leads to sign in at 0", async () => {
    render(<TrialLink token={TOKEN} />);
    const user = userEvent.setup();

    const seen: Array<string | null> = [];
    for (const left of [4, 3, 2, 1]) {
      mocks.parseTrialMeal.mockResolvedValueOnce(parsed(left));
      await scanOnce(user);
      await screen.findByRole("button", { name: /scan another meal/i });
      seen.push(screen.queryByRole("status")?.textContent ?? null);
      await user.click(screen.getByRole("button", { name: /scan another meal/i }));
    }
    expect(seen).toEqual([
      null,
      "3 scans left. Join to keep tracking.",
      null,
      "1 scan left. Join to keep tracking.",
    ]);
    expect(mocks.parseTrialMeal).toHaveBeenCalledWith(expect.objectContaining({ token: TOKEN }));

    mocks.parseTrialMeal.mockResolvedValueOnce(parsed(0));
    await scanOnce(user);
    expect(await screen.findByRole("heading", { name: /Your trial is done/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      "/auth?email=priya@example.com",
    );
  });

  it("shows the sign-in wall, not an alert, when the link is reopened with no scans left", async () => {
    render(<TrialLink token={TOKEN} />);
    mocks.parseTrialMeal.mockRejectedValueOnce(
      new TrialRequestError("You've used your 10 free scans.", "trial_exhausted"),
    );
    await scanOnce(userEvent.setup());
    expect(await screen.findByRole("heading", { name: /Your trial is done/ })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the sign-in line under results for an invited address", async () => {
    render(<TrialLink token={TOKEN} />);
    mocks.parseTrialMeal.mockResolvedValueOnce(parsed(9));
    await scanOnce(userEvent.setup());
    await screen.findByRole("button", { name: /scan another meal/i });

    const signInLink = screen.getByRole("link", { name: "Sign in" });
    expect(signInLink.getAttribute("href")).toBe("/auth?email=priya@example.com");
    expect(signInLink.closest("p")?.textContent).toContain("You're invited");
  });
});

describe("a refused link", () => {
  it("expired, tampered or revoked: says so and offers to request an invite", async () => {
    mocks.verifyTrialLink.mockResolvedValue({ status: "expired" });
    render(<TrialLink token="tampered.token" />);

    expect(await screen.findByRole("link", { name: "invites@tracknutri.app" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "invites@tracknutri.app" }).getAttribute("href")).toBe(
      "mailto:invites@tracknutri.app",
    );
    expect(screen.getByText(/This trial link has expired/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Request an invite" }).getAttribute("href")).toBe(
      "/auth/request",
    );
    expect(localStorage.getItem("nutritrack-trial-token")).toBeNull();
  });

  it("revoked after it was opened: the next scan shows the expired screen and forgets the token", async () => {
    render(<TrialLink token={TOKEN} />);
    mocks.parseTrialMeal.mockRejectedValueOnce(
      new TrialRequestError("This trial link has expired.", "trial_link_expired"),
    );
    await scanOnce(userEvent.setup());

    expect(await screen.findByRole("link", { name: "invites@tracknutri.app" })).toBeTruthy();
    expect(screen.getByText(/This trial link has expired/)).toBeTruthy();
    expect(localStorage.getItem("nutritrack-trial-token")).toBeNull();
  });

  it("says what went wrong when the service cannot be reached", async () => {
    mocks.verifyTrialLink.mockRejectedValue(new Error("Could not reach the meal service."));
    render(<TrialLink token={TOKEN} />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not reach the meal service.",
    );
  });
});
