/**
 * Copying, showing and revoking a personal trial link on an admin row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { TrialLinkControls } from "./TrialLinkControls";
import { useTrialLinks } from "./use-trial-links";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: vi.fn(), auth: { getSession: vi.fn() } },
}));
vi.mock("@/lib/capture", () => ({
  parseMealUrl: () => "https://meals.example.com/parse-meal",
}));
vi.mock("sonner", () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() });
  return { toast };
});

const client = supabase as unknown as {
  rpc: ReturnType<typeof vi.fn>;
  auth: { getSession: ReturnType<typeof vi.fn> };
};

const LINK = "https://tracknutri.app/t/eyJlbWFpbCI6InAifQ.c2ln";
let posted: Array<{ url: string; body: unknown; auth: string | null }> = [];
let written: string[] = [];

function Row({ email, firstName }: { email: string; firstName: string | null }) {
  const links = useTrialLinks([email]);
  return <TrialLinkControls email={email} firstName={firstName} sent={links.get(email)} />;
}

function renderRow(email = "priya@example.com", firstName: string | null = "Priya") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Row email={email} firstName={firstName} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  posted = [];
  written = [];
  vi.mocked(toast).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  client.auth.getSession.mockResolvedValue({ data: { session: { access_token: "admin-jwt" } } });
  client.rpc.mockImplementation(async () => ({ data: [], error: null }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      posted.push({ url, body: JSON.parse(String(init.body)), auth: headers.get("authorization") });
      return new Response(
        JSON.stringify({ url: LINK, email: "priya@example.com", firstName: "Priya" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * user-event's setup() installs its own clipboard, so the test's clipboard goes in after it.
 * jsdom has no ClipboardItem, so this is the writeText path.
 */
function userWithClipboard(writeText?: (text: string) => Promise<void>) {
  const user = userEvent.setup();
  vi.stubGlobal("ClipboardItem", undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(writeText ?? (async (text: string) => void written.push(text))) },
  });
  return user;
}

describe("Copy trial link", () => {
  it("asks the service for the person's link with the admin's token, copies it and says so", async () => {
    renderRow();
    const user = userWithClipboard();
    await user.click(screen.getByRole("button", { name: "Copy trial link for priya@example.com" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Trial link copied"));
    expect(posted).toEqual([
      {
        url: "https://meals.example.com/trial/link/issue",
        body: { email: "priya@example.com", firstName: "Priya" },
        auth: "Bearer admin-jwt",
      },
    ]);
    expect(written).toEqual([LINK]);
  });

  it("says what went wrong when the service refuses, and copies nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: "Only an admin can create trial links." } }),
            { status: 403 },
          ),
      ),
    );
    renderRow();
    const user = userWithClipboard();
    await user.click(screen.getByRole("button", { name: /copy trial link/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Only an admin can create trial links."),
    );
    expect(written).toEqual([]);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("shows the link to copy by hand when the browser refuses the copy", async () => {
    renderRow();
    const user = userWithClipboard(async () => Promise.reject(new Error("denied")));
    await user.click(screen.getByRole("button", { name: /copy trial link/i }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Trial link ready", { description: LINK }),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("a link already sent", () => {
  beforeEach(() => {
    client.rpc.mockImplementation(async (name: string) => {
      if (name === "admin_trial_links") {
        return {
          data: [
            {
              email: "priya@example.com",
              first_name: "Priya",
              link_sent_at: "2026-11-10T10:00:00Z",
              scans_used: 2,
              scans_limit: 10,
            },
          ],
          error: null,
        };
      }
      return { data: null, error: null };
    });
  });

  it("shows Trial link sent with the scans used, and Revoke", async () => {
    renderRow();
    expect(await screen.findByText("Trial link sent · 2/10 used")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Revoke trial link for priya@example.com" }),
    ).toBeTruthy();
    expect(client.rpc).toHaveBeenCalledWith("admin_trial_links", {
      p_emails: ["priya@example.com"],
    });
  });

  it("revokes through the database and says so", async () => {
    renderRow();
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: /revoke trial link/i }));
    await waitFor(() =>
      expect(client.rpc).toHaveBeenCalledWith("admin_trial_link_revoke", {
        p_email: "priya@example.com",
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Trial link revoked for priya@example.com");
  });

  it("offers no Revoke for an address with no link out", async () => {
    client.rpc.mockImplementation(async () => ({ data: [], error: null }));
    renderRow("nobody@example.com", null);
    await screen.findByRole("button", { name: /copy trial link/i });
    expect(screen.queryByRole("button", { name: /revoke/i })).toBeNull();
    expect(screen.queryByText(/trial link sent/i)).toBeNull();
  });
});
