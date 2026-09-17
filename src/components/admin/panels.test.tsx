/**
 * The admin panels, driven as components.
 *
 * `fill()` sets a whole value in one event and would hide exactly the kind of bug the
 * height field taught: a value that only survives if it arrives complete. So the invite
 * field is typed into one character at a time and asserted after each keystroke.
 *
 * The other thing these tests are for is the boundary. What the panel sends is not
 * necessarily what was typed — it is normalised first — and that difference is invisible
 * in a screenshot, so it is asserted here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { InviteList, InviteRequestsPanel, SpendPanel } from "./panels";
import { supabase } from "@/integrations/supabase/client";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    auth: { getSession: vi.fn() },
  },
}));

// The invite goes to the service, not to PostgREST directly: it drafts the email and adds the
// address in one request. Only the URL is mocked here; `fetch` carries the rest.
vi.mock("@/lib/capture", () => ({
  parseMealUrl: () => "https://meals.example.com/parse-meal",
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const client = supabase as unknown as {
  from: ReturnType<typeof vi.fn>;
  rpc: ReturnType<typeof vi.fn>;
  auth: { getSession: ReturnType<typeof vi.fn> };
};

const INVITE_ROWS = [
  {
    email: "aman.iitg@gmail.com",
    added_by: null,
    created_at: "2026-09-07T12:00:00.000Z",
    signed_up_at: "2026-09-09T12:00:00.000Z",
    user_id: "user-1",
    is_admin: true,
  },
  {
    email: "friend@example.com",
    added_by: "Aman",
    created_at: "2026-09-10T12:00:00.000Z",
    signed_up_at: null,
    user_id: null,
    is_admin: false,
  },
];

/** Records what was inserted, and lets a test make it fail. */
let inserted: Array<Record<string, unknown>> = [];

/** Every request the panel made to the service. */
let requests: Array<{ url: string; body: unknown }> = [];

/** What the service replies with. */
function serviceSays(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  inserted = [];
  requests = [];
  vi.clearAllMocks();
  vi.unstubAllGlobals();

  client.auth.getSession.mockResolvedValue({
    data: { session: { access_token: "token-1" } },
    error: null,
  });

  client.rpc.mockImplementation((name: string) => {
    if (name === "admin_invites") return Promise.resolve({ data: INVITE_ROWS, error: null });
    if (name === "admin_spend") return Promise.resolve({ data: [], error: null });
    if (name === "admin_approve_request")
      return Promise.resolve({ data: "friend@example.com", error: null });
    return Promise.resolve({ data: null, error: null });
  });

  client.from.mockImplementation((table: string) => {
    if (table === "allowed_emails") {
      return {
        insert: (row: Record<string, unknown>) => {
          inserted.push(row);
          return Promise.resolve({ error: null });
        },
        delete: () => ({
          eq: () => Promise.resolve({ error: null }),
        }),
      };
    }
    if (table === "invite_requests") {
      return {
        select: () => ({
          order: () =>
            Promise.resolve({
              data: [
                {
                  id: "req-1",
                  email: "hopeful@example.com",
                  requested_at: "2026-09-11T09:00:00.000Z",
                  status: "pending",
                  handled_at: null,
                },
              ],
              error: null,
            }),
          limit: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
        }),
      };
    }
    return {};
  });
});

describe("the invite list", () => {
  it("shows who has arrived and who has only been invited", async () => {
    renderWithQuery(<InviteList adminId="admin-1" />);

    expect(await screen.findByText("friend@example.com")).toBeInTheDocument();
    // The join against auth.users is what makes this distinction possible, so it is the
    // one thing worth asserting about the list itself. Matched loosely because the label
    // shares its line with when the invite was added.
    expect(screen.getByText(/Invited, not arrived/)).toBeInTheDocument();
    expect(screen.getByText(/Joined · admin/)).toBeInTheDocument();
  });

  it("keeps every partial value while an address is typed, character by character", async () => {
    const user = userEvent.setup();
    renderWithQuery(<InviteList adminId="admin-1" />);

    const field = screen.getByLabelText("Address to invite");
    let typed = "";
    for (const character of "New.Friend@Example.COM") {
      await user.type(field, character);
      typed += character;
      expect(field).toHaveValue(typed);
    }
  });

  it("shows what will actually be stored before it is stored", async () => {
    const user = userEvent.setup();
    renderWithQuery(<InviteList adminId="admin-1" />);

    await user.type(screen.getByLabelText("Address to invite"), "New.Friend@Example.COM");

    // The lookup is case- and space-insensitive, so this is the address that will match.
    // Showing it is the difference between an invite that works and one that looks like
    // it worked.
    expect(await screen.findByText("new.friend@example.com")).toBeInTheDocument();
  });

  it("sends the normalised address to the service, and does not write the list itself", async () => {
    const user = userEvent.setup();
    serviceSays(200, {
      email: "new.friend@example.com",
      firstName: "Priya",
      draftId: "draft-1",
      alreadyInvited: false,
    });
    renderWithQuery(<InviteList adminId="admin-1" />);

    await user.type(screen.getByLabelText("Their first name"), "Priya");
    await user.type(screen.getByLabelText("Address to invite"), "  New.Friend@Example.COM ");
    await user.click(screen.getByRole("button", { name: /draft the invite/i }));

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    // The address the database will match, and it goes to /invite rather than into the table: the
    // service adds it in the same request that drafts the email, so the two cannot drift.
    expect(requests[0]?.url).toBe("https://meals.example.com/invite");
    expect(requests[0]?.body).toEqual({
      email: "new.friend@example.com",
      firstName: "Priya",
    });
    expect(inserted).toEqual([]);
  });

  it("will not send an address that could never match, or an invite with no name", async () => {
    const user = userEvent.setup();
    serviceSays(200, {});
    renderWithQuery(<InviteList adminId="admin-1" />);

    await user.type(screen.getByLabelText("Address to invite"), "not-an-address");
    expect(screen.getByRole("button", { name: /draft the invite/i })).toBeDisabled();

    // A name is needed for the greeting, so an invite without one is not sent either.
    await user.clear(screen.getByLabelText("Address to invite"));
    await user.type(screen.getByLabelText("Address to invite"), "friend@example.com");
    expect(screen.getByRole("button", { name: /draft the invite/i })).toBeDisabled();

    expect(requests).toEqual([]);
  });

  it("says an address was already on the list rather than claiming it was added", async () => {
    const user = userEvent.setup();
    serviceSays(200, {
      email: "friend@example.com",
      firstName: "Priya",
      draftId: "draft-2",
      alreadyInvited: true,
    });
    renderWithQuery(<InviteList adminId="admin-1" />);

    await user.type(screen.getByLabelText("Their first name"), "Priya");
    await user.type(screen.getByLabelText("Address to invite"), "friend@example.com");
    await user.click(screen.getByRole("button", { name: /draft the invite/i }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("already on the list"));
    });
  });

  it("shows the service's own refusal, which is written for a phone", async () => {
    const user = userEvent.setup();
    serviceSays(403, { error: { code: "forbidden", message: "Only an admin can invite people." } });
    renderWithQuery(<InviteList adminId="admin-1" />);

    await user.type(screen.getByLabelText("Their first name"), "Priya");
    await user.type(screen.getByLabelText("Address to invite"), "friend@example.com");
    await user.click(screen.getByRole("button", { name: /draft the invite/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Only an admin can invite people.");
  });
});

describe("requests from people who are not on the list", () => {
  it("lists a waiting request with the one click that resolves it", async () => {
    renderWithQuery(<InviteRequestsPanel />);

    expect(await screen.findByText("hopeful@example.com")).toBeInTheDocument();
    expect(screen.getByText("1 waiting")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
  });

  it("approves through the RPC that does the insert and the marking in one transaction", async () => {
    const user = userEvent.setup();
    renderWithQuery(<InviteRequestsPanel />);

    await user.click(await screen.findByRole("button", { name: /approve/i }));

    await waitFor(() => {
      expect(client.rpc).toHaveBeenCalledWith("admin_approve_request", { p_request: "req-1" });
    });
  });
});

describe("the spend panel", () => {
  it("shows tokens and says there is no price", async () => {
    client.rpc.mockImplementation((name: string) => {
      if (name === "admin_spend") {
        return Promise.resolve({
          data: [
            {
              user_id: "user-1",
              email: "aman.iitg@gmail.com",
              timezone: "America/New_York",
              calls_today: 11,
              resets_today: "2026-09-12T04:00:00.000Z",
              calls_month: 38,
              tokens_month: 150_045,
              calls_total: 1_203,
              tokens_total: 4_511_002,
              last_call_at: "2026-09-07T18:02:00.000Z",
            },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: [], error: null });
    });

    renderWithQuery(<SpendPanel />);

    expect(await screen.findByText("49 of 60 left today")).toBeInTheDocument();
    expect(screen.getByText(/150,045 tokens this month/)).toBeInTheDocument();
    expect(screen.getByText(/no price in here on purpose/i)).toBeInTheDocument();
  });
});
