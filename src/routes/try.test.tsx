/**
 * The meal-first trial page: the visitor starts at the meal step, and only after the
 * 6-digit code is verified does the meal get analysed. These cover the photo and the
 * typed paths, the reload that keeps the meal, and the invited/uninvited end screens.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { TrialPage } from "./try";

const mocks = vi.hoisted(() => ({
  sendTrialCode: vi.fn(),
  verifyTrialCode: vi.fn(),
  parseTrialMeal: vi.fn(),
  getTrialSettings: vi.fn(),
  startAnonymousTrial: vi.fn(),
  preparePhoto: vi.fn(),
  requestInvite: vi.fn(),
  reportPageFunnelEvent: vi.fn(),
  turnstileCallback: null as ((token: string) => void) | null,
  /** The options the page passed to turnstile.render, which is what this file guards. */
  turnstileOptions: null as Record<string, unknown> | null,
  /** Set for the test that reproduces Cloudflare refusing the widget outright. */
  turnstileThrows: false,
}));

vi.mock("@/lib/trial", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/trial")>();
  return {
    ...actual,
    sendTrialCode: (...args: unknown[]) => mocks.sendTrialCode(...args),
    verifyTrialCode: (...args: unknown[]) => mocks.verifyTrialCode(...args),
    parseTrialMeal: (...args: unknown[]) => mocks.parseTrialMeal(...args),
    getTrialSettings: (...args: unknown[]) => mocks.getTrialSettings(...args),
    startAnonymousTrial: (...args: unknown[]) => mocks.startAnonymousTrial(...args),
    reportPageFunnelEvent: (...args: unknown[]) => mocks.reportPageFunnelEvent(...args),
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
      mocks.turnstileOptions = options;
      if (mocks.turnstileThrows) {
        // What the live page actually threw: Cloudflare's client rejects the parameters it used
        // to accept, before any widget exists.
        throw new Error(
          'TurnstileError: [Cloudflare Turnstile] Invalid value for parameter "size"',
        );
      }
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
  mocks.turnstileOptions = null;
  mocks.turnstileThrows = false;
  // The email flow is the default in these tests; the anonymous cases set this false.
  mocks.getTrialSettings.mockResolvedValue({ scansLimit: 10, requireEmail: true });
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
    expect(mocks.startAnonymousTrial).not.toHaveBeenCalled();
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
    // The camera input behind the box: the box is a button that opens it, so the file goes to the
    // input the box clicks.
    const camera = document.querySelector<HTMLInputElement>('input[data-snap-input="camera"]');
    if (camera === null) throw new Error("the snap box has no camera input");
    await user.upload(camera, file);

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
    expect(screen.getByRole("link", { name: "Create an account" }).getAttribute("href")).toBe(
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
    expect(mocks.startAnonymousTrial).not.toHaveBeenCalled();
  });
});

const ANON_DEVICE = "11111111-1111-4111-8111-111111111111";

describe("the anonymous trial (flag false)", () => {
  beforeEach(() => {
    mocks.getTrialSettings.mockResolvedValue({ scansLimit: 10, requireEmail: false });
    mocks.startAnonymousTrial.mockResolvedValue({
      token: "device-token",
      deviceId: ANON_DEVICE,
      scansLeft: 10,
      scansTotal: 10,
    });
    mocks.parseTrialMeal.mockResolvedValue(parsedWith(9));
  });

  /** The invisible widget has to be rendered before a click can run its challenge. */
  async function waitForTurnstile(): Promise<void> {
    await waitFor(() => expect(mocks.turnstileCallback).not.toBeNull());
  }

  it("answers an empty photo with the two ways forward, and keeps the scan count the service sent", async () => {
    // The service refunds a no-food scan and answers with the count from before the attempt, so
    // the page shows 3 scans left — not 2 — and the trial's promise is not spent on a wall.
    mocks.parseTrialMeal.mockResolvedValue({ ...parsedWith(3), items: [] });

    render(<TrialPage />);
    const user = userEvent.setup();
    await waitForTurnstile();

    await user.type(await screen.findByPlaceholderText(/type what you ate/i), "a blurry photo");
    await user.click(screen.getByRole("button", { name: /analyse/i }));

    expect(await screen.findByText(/couldn't find any food in that/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retake photo/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /type it instead/i })).toBeInTheDocument();
    // Nothing to review, so the results screen never opened.
    expect(screen.queryByRole("button", { name: /scan another meal/i })).toBeNull();
    // The number the service sent, unmodified: the refund is the service's business.
    expect(screen.getByText(/3 scans left/i)).toBeInTheDocument();
  });

  it("puts the caret in the text field when they choose to type instead", async () => {
    mocks.parseTrialMeal.mockResolvedValue({ ...parsedWith(9), items: [] });

    render(<TrialPage />);
    const user = userEvent.setup();
    await waitForTurnstile();

    await user.type(await screen.findByPlaceholderText(/type what you ate/i), "toast");
    await user.click(screen.getByRole("button", { name: /analyse/i }));
    await user.click(await screen.findByRole("button", { name: /type it instead/i }));

    expect(screen.queryByText(/couldn't find any food/i)).toBeNull();
    expect(document.activeElement).toBe(screen.getByPlaceholderText(/type what you ate/i));
  });

  it("asks for no email: Turnstile, a device token, then the analysis", async () => {
    render(<TrialPage />);
    const user = userEvent.setup();
    await waitForTurnstile();

    await user.type(await screen.findByPlaceholderText(/type what you ate/i), "dal and roti");
    await user.click(screen.getByRole("button", { name: /analyse/i }));

    expect(await screen.findByRole("button", { name: /scan another meal/i })).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByRole("button", { name: /email me a code/i })).toBeNull();
    expect(mocks.sendTrialCode).not.toHaveBeenCalled();
    expect(mocks.startAnonymousTrial).toHaveBeenCalledWith("test-token", null);
    expect(mocks.parseTrialMeal).toHaveBeenCalledWith(
      expect.objectContaining({ token: "device-token", text: "dal and roti" }),
    );
    expect(localStorage.getItem("nutritrack-trial-anonymous")).toBe("1");
    expect(localStorage.getItem("nutritrack-trial-device")).toBe(ANON_DEVICE);
  });

  it("never analyses before the device token is issued", async () => {
    let release: (value: {
      token: string;
      deviceId: string;
      scansLeft: number;
      scansTotal: number;
    }) => void = () => {};
    mocks.startAnonymousTrial.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    render(<TrialPage />);
    const user = userEvent.setup();
    await waitForTurnstile();
    await user.type(await screen.findByPlaceholderText(/type what you ate/i), "dal");
    await user.click(screen.getByRole("button", { name: /analyse/i }));

    await waitFor(() => expect(mocks.startAnonymousTrial).toHaveBeenCalled());
    expect(mocks.parseTrialMeal).not.toHaveBeenCalled();

    release({
      token: "device-token",
      deviceId: ANON_DEVICE,
      scansLeft: 10,
      scansTotal: 10,
    });
    expect(await screen.findByRole("button", { name: /scan another meal/i })).toBeTruthy();
    expect(mocks.parseTrialMeal).toHaveBeenCalledTimes(1);
  });

  it("reuses a stored anonymous token without Turnstile", async () => {
    localStorage.setItem("nutritrack-trial-token", "device-token");
    localStorage.setItem("nutritrack-trial-anonymous", "1");
    localStorage.setItem("nutritrack-trial-device", ANON_DEVICE);

    render(<TrialPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText(/type what you ate/i), "dal");
    await user.click(screen.getByRole("button", { name: /analyse/i }));

    expect(await screen.findByRole("button", { name: /scan another meal/i })).toBeTruthy();
    expect(mocks.startAnonymousTrial).not.toHaveBeenCalled();
    expect(mocks.parseTrialMeal).toHaveBeenCalledWith(
      expect.objectContaining({ token: "device-token" }),
    );
  });

  it("asks for an email only at the end screen, and offers sign-in", async () => {
    mocks.parseTrialMeal.mockResolvedValue(parsedWith(0));

    render(<TrialPage />);
    const user = userEvent.setup();
    await waitForTurnstile();
    await user.type(await screen.findByPlaceholderText(/type what you ate/i), "dal");
    await user.click(screen.getByRole("button", { name: /analyse/i }));

    expect(
      await screen.findByRole("heading", {
        name: "Your trial is done. Create a free account to keep tracking.",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /create a free account/i })).toBeTruthy();

    await user.type(screen.getByLabelText("Email"), "late@example.com");
    await user.click(screen.getByRole("button", { name: /request an invite/i }));

    expect(mocks.requestInvite).toHaveBeenCalledWith("late@example.com", { fromTrial: true });
    expect(await screen.findByText(/Request sent/)).toBeTruthy();
  });
});

/**
 * The page's half of the funnel.
 *
 * Eight steps are counted; six belong to the service because only it knows whether a
 * token was issued or an analysis came back. These two are the ones the browser knows
 * first, and they are asserted through the rendered page rather than the helper, because
 * the place they are called from is the thing that decides whether they mean anything.
 */
describe("the funnel steps the page reports", () => {
  it("counts one visit when the page opens, not one per render", async () => {
    render(<TrialPage />);
    await screen.findByRole("heading", { name: "Try a meal" });

    await waitFor(() => expect(mocks.reportPageFunnelEvent).toHaveBeenCalledTimes(1));
    expect(mocks.reportPageFunnelEvent).toHaveBeenCalledWith("try_page_view");
  });

  it("counts the tap on Analyse once, even though the analysis waits for the code", async () => {
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
    await screen.findByRole("heading", { name: "Enter your email to see your results" });
    await finishCodeStep(user);
    await screen.findByRole("button", { name: /scan another meal/i });

    // The meal parked at the email step is analysed after the code, without a second tap;
    // that replay is not a visit of its own, so it must not be counted again.
    expect(mocks.parseTrialMeal).toHaveBeenCalledTimes(1);
    const analyseTaps = mocks.reportPageFunnelEvent.mock.calls.filter(
      (call) => call[0] === "analyse_tapped",
    );
    expect(analyseTaps).toHaveLength(1);
  });
});

/**
 * The Turnstile widget, and the parameters Cloudflare will accept.
 *
 * This is a regression test for a live outage rather than a hypothetical: the page passed
 * `size: "invisible"`, which Cloudflare's client now rejects before any widget exists. The throw
 * was swallowed, the widget id stayed null, and every Analyse tap stopped at "Complete the check
 * to continue" — a dead button on a page that looked fine. Nothing about that is visible without
 * asserting on the options, so here they are.
 */
describe("the Turnstile widget", () => {
  it("renders with the parameters the current API accepts", async () => {
    render(<TrialPage />);
    await waitFor(() => expect(mocks.turnstileOptions).not.toBeNull());

    const options = mocks.turnstileOptions ?? {};
    // Invisible is the sitekey's mode now. "size" only takes normal, compact or flexible, and
    // sending anything else throws — so the key is absent rather than set to a word that means
    // something else here.
    expect(options).not.toHaveProperty("size");
    expect(options["appearance"]).toBe("interaction-only");
    expect(options["execution"]).toBe("execute");
    expect(options["sitekey"]).toBe("test-site-key");
  });

  it("says the check could not load when Cloudflare refuses to render it", async () => {
    mocks.turnstileThrows = true;
    // The anonymous flow, because that is the one that needs the widget before it can scan.
    mocks.getTrialSettings.mockResolvedValue({ scansLimit: 10, requireEmail: false });

    render(<TrialPage />);
    await waitFor(() => expect(mocks.turnstileOptions).not.toBeNull());
    const user = userEvent.setup();

    await user.type(await screen.findByPlaceholderText(/type what you ate/i), "dal and roti");
    await user.click(screen.getByRole("button", { name: /analyse/i }));

    // Not "Complete the check to continue": there was never a check to complete.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The security check could not load. Reload the page and try again.",
    );
    expect(mocks.parseTrialMeal).not.toHaveBeenCalled();
  });
});
