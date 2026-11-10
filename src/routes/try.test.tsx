/**
 * The meal-first trial page: the visitor starts at the meal step, and only after the
 * 6-digit code is verified does the meal get analysed. These cover the photo and the
 * typed paths, the reload that keeps the meal, and the invited/uninvited end screens.
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
  getTrialScansLimit: vi.fn(),
  preparePhoto: vi.fn(),
  requestInvite: vi.fn(),
  turnstileCallback: null as ((token: string) => void) | null,
}));

vi.mock("@/lib/trial", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/trial")>();
  return {
    ...actual,
    sendTrialCode: (...args: unknown[]) => mocks.sendTrialCode(...args),
    verifyTrialCode: (...args: unknown[]) => mocks.verifyTrialCode(...args),
    parseTrialMeal: (...args: unknown[]) => mocks.parseTrialMeal(...args),
    getTrialScansLimit: (...args: unknown[]) => mocks.getTrialScansLimit(...args),
  };
});

vi.mock("@/lib/capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/capture")>();
  return {
    ...actual,
    preparePhoto: (...args: unknown[]) => mocks.preparePhoto(...args),
  };
});

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
      mocks.turnstileCallback = options["callback"] as (token: string) => void;
      return "widget-1";
    },
    execute: () => {
      mocks.turnstileCallback?.("test-token");
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

// The page renders router <Link>s; render them as plain anchors carrying the email.
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

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  for (const mock of Object.values(mocks)) {
    if (typeof mock === "function") (mock as { mockReset?: () => void }).mockReset?.();
  }
  mocks.turnstileCallback = null;
  mocks.getTrialScansLimit.mockResolvedValue(10);
  mocks.requestInvite.mockResolvedValue("requested");
});

function parsedWith(scansLeft: number) {
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

async function finishCodeStep(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Email"), "trial@example.com");
  await user.click(screen.getByRole("button", { name: /email me a code/i }));
  await user.type(screen.getByLabelText("Code"), "123456");
  await user.click(screen.getByRole("button", { name: /continue/i }));
}

describe("the meal-first trial page", () => {
  it("opens at the meal step, not the email form", async () => {
    render(<TrialPage />);

    expect(await screen.findByRole("heading", { name: "Try a meal" })).toBeTruthy();
    expect(screen.getByPlaceholderText(/type what you ate/i)).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(mocks.sendTrialCode).not.toHaveBeenCalled();
  });

  it("analyses typed text only after the code is verified, without retyping", async () => {
    mocks.sendTrialCode.mockResolvedValue({
      status: "sent",
      email: "trial@example.com",
      invited: false,
    });
    mocks.verifyTrialCode.mockResolvedValue({ status: "ok", token: "token-1" });
    mocks.parseTrialMeal.mockResolvedValue(parsedWith(9));

    render(<TrialPage />);
    const user = userEvent.setup();

    await user.type(await screen.findByPlaceholderText(/type what you ate/i), "dal and roti");
    await user.click(screen.getByRole("button", { name: /analyse/i }));

    // No analysis before the email and code.
    expect(mocks.parseTrialMeal).not.toHaveBeenCalled();

    expect(
      await screen.findByRole("heading", { name: "Enter your email to see your results" }),
    ).toBeTruthy();
    await finishCodeStep(user);

    expect(await screen.findByRole("button", { name: /scan another meal/i })).toBeTruthy();
    expect(mocks.parseTrialMeal).toHaveBeenCalledTimes(1);
    expect(mocks.parseTrialMeal).toHaveBeenCalledWith(
      expect.objectContaining({ token: "token-1", text: "dal and roti" }),
    );
  });

  it("analyses a photo after the email and code, without re-picking it", async () => {
    mocks.sendTrialCode.mockResolvedValue({
      status: "sent",
      email: "trial@example.com",
      invited: false,
    });
    mocks.verifyTrialCode.mockResolvedValue({ status: "ok", token: "token-1" });
    mocks.parseTrialMeal.mockResolvedValue(parsedWith(9));
    mocks.preparePhoto.mockResolvedValue({
      blob: { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer },
      sha256: "abc",
      width: 100,
      height: 100,
      bytes: 3,
    });

    render(<TrialPage />);
    const user = userEvent.setup();

    const file = new File(["x"], "plate.jpg", { type: "image/jpeg" });
    await user.upload(screen.getByLabelText(/snap or upload a photo/i), file);

    expect(
      await screen.findByRole("heading", { name: "Enter your email to see your results" }),
    ).toBeTruthy();
    expect(mocks.parseTrialMeal).not.toHaveBeenCalled();

    await finishCodeStep(user);

    expect(await screen.findByRole("button", { name: /scan another meal/i })).toBeTruthy();
    expect(mocks.parseTrialMeal).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "token-1",
        photos: [{ base64: expect.any(String), mimeType: "image/jpeg" }],
      }),
    );
  });

  it("keeps the meal across a reload during the code step", async () => {
    mocks.sendTrialCode.mockResolvedValue({
      status: "sent",
      email: "trial@example.com",
      invited: false,
    });
    mocks.verifyTrialCode.mockResolvedValue({ status: "ok", token: "token-1" });
    mocks.parseTrialMeal.mockResolvedValue(parsedWith(9));

    const first = render(<TrialPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText(/type what you ate/i), "dal and roti");
    await user.click(screen.getByRole("button", { name: /analyse/i }));
    await user.type(screen.getByLabelText("Email"), "trial@example.com");
    await user.click(screen.getByRole("button", { name: /email me a code/i }));
    expect(await screen.findByRole("heading", { name: "Enter the code" })).toBeTruthy();

    // Reload: remount. sessionStorage still holds the pending meal and the code step.
    first.unmount();
    render(<TrialPage />);

    expect(await screen.findByRole("heading", { name: "Enter the code" })).toBeTruthy();
    await user.type(screen.getByLabelText("Code"), "123456");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(await screen.findByRole("button", { name: /scan another meal/i })).toBeTruthy();
    expect(mocks.parseTrialMeal).toHaveBeenCalledWith(
      expect.objectContaining({ text: "dal and roti" }),
    );
  });

  it("never calls the parser before the code is verified", async () => {
    mocks.sendTrialCode.mockResolvedValue({
      status: "sent",
      email: "trial@example.com",
      invited: false,
    });
    mocks.verifyTrialCode.mockResolvedValue({ status: "ok", token: "token-1" });
    mocks.parseTrialMeal.mockResolvedValue(parsedWith(9));

    render(<TrialPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText(/type what you ate/i), "dal");
    await user.click(screen.getByRole("button", { name: /analyse/i }));
    expect(mocks.parseTrialMeal).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Email"), "trial@example.com");
    await user.click(screen.getByRole("button", { name: /email me a code/i }));
    expect(mocks.parseTrialMeal).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Code"), "123456");
    await user.click(screen.getByRole("button", { name: /continue/i }));
    expect(mocks.parseTrialMeal).toHaveBeenCalledTimes(1);
  });

  it("gives an invited address a code and a trial, with the sign-in line under results", async () => {
    mocks.sendTrialCode.mockResolvedValue({
      status: "sent",
      email: "invited@example.com",
      invited: true,
    });
    mocks.verifyTrialCode.mockResolvedValue({ status: "ok", token: "token-1" });
    mocks.parseTrialMeal.mockResolvedValue(parsedWith(9));

    render(<TrialPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText(/type what you ate/i), "dal");
    await user.click(screen.getByRole("button", { name: /analyse/i }));
    await user.type(screen.getByLabelText("Email"), "invited@example.com");
    await user.click(screen.getByRole("button", { name: /email me a code/i }));
    await user.type(screen.getByLabelText("Code"), "123456");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(await screen.findByRole("button", { name: /scan another meal/i })).toBeTruthy();
    const signInLink = screen.getByRole("link", { name: "Sign in" });
    expect(signInLink.getAttribute("href")).toBe("/auth?email=invited@example.com");
    expect(signInLink.closest("p")?.textContent).toContain("You're invited");
  });

  it("leads an invited address to sign in when the trial runs out", async () => {
    mocks.sendTrialCode.mockResolvedValue({
      status: "sent",
      email: "invited@example.com",
      invited: true,
    });
    mocks.verifyTrialCode.mockResolvedValue({ status: "ok", token: "token-1" });
    mocks.parseTrialMeal.mockResolvedValue(parsedWith(0));

    render(<TrialPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText(/type what you ate/i), "dal");
    await user.click(screen.getByRole("button", { name: /analyse/i }));
    await user.type(screen.getByLabelText("Email"), "invited@example.com");
    await user.click(screen.getByRole("button", { name: /email me a code/i }));
    await user.type(screen.getByLabelText("Code"), "123456");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(await screen.findByRole("heading", { name: /Your trial is done/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      "/auth?email=invited@example.com",
    );
    expect(screen.queryByRole("button", { name: /request an invite/i })).toBeNull();
  });

  it("asks an uninvited visitor for an invite when the trial runs out", async () => {
    mocks.sendTrialCode.mockResolvedValue({
      status: "sent",
      email: "trial@example.com",
      invited: false,
    });
    mocks.verifyTrialCode.mockResolvedValue({ status: "ok", token: "token-1" });
    mocks.parseTrialMeal.mockResolvedValue(parsedWith(0));

    render(<TrialPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText(/type what you ate/i), "dal");
    await user.click(screen.getByRole("button", { name: /analyse/i }));
    await user.type(screen.getByLabelText("Email"), "trial@example.com");
    await user.click(screen.getByRole("button", { name: /email me a code/i }));
    await user.type(screen.getByLabelText("Code"), "123456");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(await screen.findByRole("heading", { name: /used your 10 free scans/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /request an invite/i })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
  });

  it("analyses straight away for a returning visitor with a stored token", async () => {
    localStorage.setItem("nutritrack-trial-token", "token-1");
    localStorage.setItem("nutritrack-trial-email", "trial@example.com");
    localStorage.setItem("nutritrack-trial-invited", "0");
    mocks.parseTrialMeal.mockResolvedValue(parsedWith(9));

    render(<TrialPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText(/type what you ate/i), "dal");
    await user.click(screen.getByRole("button", { name: /analyse/i }));

    expect(await screen.findByRole("button", { name: /scan another meal/i })).toBeTruthy();
    expect(mocks.parseTrialMeal).toHaveBeenCalledWith(
      expect.objectContaining({ token: "token-1", text: "dal" }),
    );
    expect(mocks.sendTrialCode).not.toHaveBeenCalled();
  });
});
