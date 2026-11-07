/**
 * The request page, one answer at a time.
 *
 * Five things can happen when somebody asks, and four of them are not "thanks". The messages are
 * asserted in full because the difference between them is the whole point: "we have it" and "you
 * already have it" send a person to two different places, and "nothing was recorded" is the one that
 * must never look like success.
 *
 * The honeypot is here too, and it is asserted at the boundary that matters: the page says what it
 * would have said and calls nothing. A test that only checked the sentence would pass with the field
 * wired to a real request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  requestInvite: vi.fn(),
  replace: vi.fn(),
  search: {} as Record<string, unknown>,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: { component: React.ComponentType }) => ({
    options,
    useSearch: () => h.search,
  }),
  useRouter: () => ({ history: { replace: h.replace } }),
  Link: ({
    to,
    search,
    children,
  }: {
    to: string;
    search?: Record<string, unknown>;
    children: ReactNode;
  }) => {
    const query = search === undefined ? "" : new URLSearchParams(search as Record<string, string>);
    const suffix = query === "" ? "" : `?${query.toString()}`;
    return createElement("a", { href: `${to}${suffix}` }, children);
  },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: () => Promise.resolve({ data: { session: null } }) } },
}));

vi.mock("@/lib/invite-request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/invite-request")>()),
  requestInvite: h.requestInvite,
}));

import { Route } from "@/routes/auth_.request";

const Page = (Route as unknown as { options: { component: React.ComponentType } }).options
  .component;

async function send(): Promise<void> {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.click(screen.getByRole("button", { name: /request invite/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.search = {};
  h.requestInvite.mockResolvedValue("requested");
});

describe("the form", () => {
  it("asks for an email and an optional first name, nothing else", () => {
    render(<Page />);

    expect(screen.getByRole("heading", { name: "Request an invite" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/first name \(optional\)/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^password$/i)).toBeNull();
  });

  it("prefills the address the sign-in page handed over", async () => {
    h.search = { email: "stranger@example.com" };
    render(<Page />);

    expect(screen.getByLabelText(/^email$/i)).toHaveValue("stranger@example.com");
    // Prefilled is not sent: nothing has been asked yet.
    expect(h.requestInvite).not.toHaveBeenCalled();
  });

  it("refuses an address that is not one, under the field rather than over the button", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<Page />);

    await user.type(screen.getByLabelText(/^email$/i), "not-an-address");
    await user.click(screen.getByRole("button", { name: /request invite/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/enter an email address/i);
    // The field is marked, which is what a screen reader reads as "this one is wrong".
    expect(screen.getByLabelText(/^email$/i)).toHaveAttribute("aria-invalid", "true");
    expect(h.requestInvite).not.toHaveBeenCalled();
  });
});

describe("what the database says", () => {
  it("says the request was sent, names the address, and says what to do next", async () => {
    render(<Page />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.type(screen.getByLabelText(/^email$/i), "Stranger@Example.com");
    await user.type(screen.getByLabelText(/first name \(optional\)/i), "  Priya  ");
    await send();

    await waitFor(() =>
      expect(h.requestInvite).toHaveBeenCalledWith("stranger@example.com", {
        firstName: "  Priya  ",
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Request sent. We'll email you at stranger@example.com when you're approved. Then come back and sign in.",
    );
  });

  it("says it was already waiting, which is not the same sentence", async () => {
    h.requestInvite.mockResolvedValue("already_pending");
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<Page />);
    await user.type(screen.getByLabelText(/^email$/i), "stranger@example.com");
    await send();

    expect(await screen.findByRole("status")).toHaveTextContent(
      "You've already requested an invite. We'll email you at stranger@example.com as soon as you're approved.",
    );
  });

  it("sends an invited address to sign in, with the address to carry", async () => {
    h.requestInvite.mockResolvedValue("already_invited");
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<Page />);
    await user.type(screen.getByLabelText(/^email$/i), "invited@example.com");
    await send();

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("You're already invited.");
    expect(within(status).getByRole("link", { name: /sign in/i })).toHaveAttribute(
      "href",
      "/auth?email=invited%40example.com",
    );
  });

  it("offers the mailbox when the request was rate limited", async () => {
    h.requestInvite.mockResolvedValue("rate_limited");
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<Page />);
    await user.type(screen.getByLabelText(/^email$/i), "stranger@example.com");
    await send();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't send the request right now. Email invites@tracknutri.app instead.",
    );
    // The fallback line and its copy button are the things that sentence points at.
    expect(screen.getByText(/or email/i)).toHaveTextContent("Or email invites@tracknutri.app");
    expect(screen.getByRole("button", { name: /^copy$/i })).toBeInTheDocument();
    // The old promise that a mail app would open is gone: it no longer does.
    expect(screen.queryByText(/your email app will open/i)).toBeNull();
  });

  it("treats a call that never answered exactly like a rate limit", async () => {
    h.requestInvite.mockResolvedValue(null);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<Page />);
    await user.type(screen.getByLabelText(/^email$/i), "stranger@example.com");
    await send();

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't send the request/i);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("the honeypot", () => {
  it("says the request was sent and calls nothing when the hidden field is filled", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<Page />);
    await user.type(screen.getByLabelText(/^email$/i), "bot@example.com");
    // A person cannot reach this field: it is off the tab order and hidden. A script fills every
    // input it finds, which is the whole assumption.
    const trap = document.getElementById("request-website");
    expect(trap).not.toBeNull();
    expect(trap).toHaveAttribute("tabindex", "-1");
    await user.type(trap as HTMLElement, "http://spam.example");
    await send();

    expect(await screen.findByRole("status")).toHaveTextContent(/request sent/i);
    expect(h.requestInvite).not.toHaveBeenCalled();
  });
});

describe("somebody already signed in", () => {
  it("goes to Today, because there is nothing to request", async () => {
    vi.resetModules();
    // The signed-in case is one getSession away from the same page, so the module is re-mocked with
    // a session rather than the component being told about it.
    vi.doMock("@/integrations/supabase/client", () => ({
      supabase: {
        auth: { getSession: () => Promise.resolve({ data: { session: { access_token: "t" } } }) },
      },
    }));
    const { Route: Fresh } = await import("@/routes/auth_.request");
    const FreshPage = (Fresh as unknown as { options: { component: React.ComponentType } }).options
      .component;
    render(<FreshPage />);

    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/today"));
    vi.doUnmock("@/integrations/supabase/client");
  });
});
