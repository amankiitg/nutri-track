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
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { InviteList, InviteRequestsPanel, SpendPanel, TrialCard } from "./panels";
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
    email: "test.user@gmail.com",
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
      // A GET has no body, and one of the panel's calls is a GET. Parsing a missing body would throw
      // and turn the reply into a network failure.
      const sent =
        init?.body === undefined || init.body === null ? null : JSON.parse(String(init.body));
      requests.push({ url, body: sent });
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

/** Opens a collapsed section, leaving an already-open one alone. */
async function openSection(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  const header = await screen.findByRole("button", { name });
  if (header.getAttribute("aria-expanded") === "false") await user.click(header);
}

/** The request rows the panels read, replaceable per test. */
let requestRows: Array<Record<string, unknown>> = [];

/** What `declineRequest` wrote, and the filter it wrote it through. */
let updated: Array<Record<string, unknown>> = [];
let updatedBy: Array<[string, unknown]> = [];

beforeEach(() => {
  inserted = [];
  requests = [];
  updated = [];
  updatedBy = [];
  requestRows = [
    {
      id: "req-1",
      email: "hopeful@example.com",
      requested_at: "2026-09-11T09:00:00.000Z",
      status: "pending",
      handled_at: null,
      first_name: "Hope",
    },
  ];
  vi.clearAllMocks();
  vi.unstubAllGlobals();

  client.auth.getSession.mockResolvedValue({
    data: { session: { access_token: "token-1" } },
    error: null,
  });

  client.rpc.mockImplementation((name: string) => {
    if (name === "admin_invites") return Promise.resolve({ data: INVITE_ROWS, error: null });
    if (name === "admin_spend") return Promise.resolve({ data: [], error: null });
    if (name === "admin_trial_list") return Promise.resolve({ data: [], error: null });
    if (name === "admin_approve_request")
      return Promise.resolve({ data: "hopeful@example.com", error: null });
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
        update: (row: Record<string, unknown>) => {
          updated.push(row);
          return {
            eq: (column: string, value: unknown) => {
              updatedBy.push([column, value]);
              // A real update changes the row, and the panel refetches afterwards. A fake that does
              // not would keep showing the request it just decided, and the test would be asserting
              // the fake rather than the panel.
              requestRows = requestRows.map((existing) =>
                column === "id" && existing["id"] === value ? { ...existing, ...row } : existing,
              );
              return Promise.resolve({ error: null });
            },
          };
        },
        select: () => ({
          order: () => Promise.resolve({ data: requestRows, error: null }),
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
    // The collapsed header carries the count, so the list can stay shut.
    expect(screen.getByText("Invites (2)")).toBeInTheDocument();
    expect(screen.getByText("1 signed up so far, 1 still to arrive.")).toBeInTheDocument();
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
    await openSection(user, /^Invites/);

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
      kind: "invite",
    });
    expect(inserted).toEqual([]);
  });

  it("will not send an address that could never match, or an invite with no name", async () => {
    const user = userEvent.setup();
    serviceSays(200, {});
    renderWithQuery(<InviteList adminId="admin-1" />);
    await openSection(user, /^Invites/);

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
    await openSection(user, /^Invites/);

    await user.type(screen.getByLabelText("Their first name"), "Priya");
    await user.type(screen.getByLabelText("Address to invite"), "friend@example.com");
    await user.click(screen.getByRole("button", { name: /draft the invite/i }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("already on the list"));
    });
  });

  it("shows what the service's own refusal says rather than a generic failure", async () => {
    const user = userEvent.setup();
    serviceSays(403, { error: { code: "forbidden", message: "Only an admin can invite people." } });
    renderWithQuery(<InviteList adminId="admin-1" />);
    await openSection(user, /^Invites/);

    await user.type(screen.getByLabelText("Their first name"), "Priya");
    await user.type(screen.getByLabelText("Address to invite"), "friend@example.com");
    await user.click(screen.getByRole("button", { name: /draft the invite/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Only an admin can invite people.");
  });

  it("shows a removed invitation as Removed, with the one click that puts it back", async () => {
    requestRows = [
      {
        id: "req-gone",
        email: "gone@example.com",
        requested_at: "2026-09-11T09:00:00.000Z",
        status: "revoked",
        handled_at: "2026-09-12T09:00:00.000Z",
        first_name: "Hope",
      },
    ];
    const user = userEvent.setup();
    renderWithQuery(<InviteList adminId="admin-1" />);
    await openSection(user, /^Invites/);

    expect(await screen.findByText("gone@example.com")).toBeInTheDocument();
    const row = screen.getByText("gone@example.com").closest("li");
    expect(row).not.toBeNull();
    // Grey, and labelled: a removed invite is a record of something that happened, not an error.
    expect(within(row as HTMLElement).getByText("Removed")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /approve again/i }));

    // The same RPC as a first approval: it adds the address to the list and marks the row approved.
    await waitFor(() =>
      expect(client.rpc).toHaveBeenCalledWith("admin_approve_request", { p_request: "req-gone" }),
    );
  });
});

describe("requests from people who are not on the list", () => {
  it("lists a waiting request with the one click that resolves it", async () => {
    renderWithQuery(<InviteRequestsPanel />);

    // The name is what the approval email will greet them by, so it is the line the admin reads.
    expect(await screen.findByText("Hope")).toBeInTheDocument();
    expect(screen.getByText("hopeful@example.com")).toBeInTheDocument();
    expect(screen.getByText("Pending requests (1)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^decline$/i })).toBeInTheDocument();
  });

  it("shows only what is waiting, because a decision is not work", async () => {
    requestRows = [
      {
        id: "req-approved",
        email: "already@example.com",
        requested_at: "2026-09-10T09:00:00.000Z",
        status: "approved",
        handled_at: "2026-09-10T10:00:00.000Z",
        first_name: "Ada",
      },
      {
        id: "req-declined",
        email: "refused@example.com",
        requested_at: "2026-09-11T09:00:00.000Z",
        status: "declined",
        handled_at: "2026-09-11T10:00:00.000Z",
        first_name: "Bo",
      },
      {
        id: "req-revoked",
        email: "removed@example.com",
        requested_at: "2026-09-12T09:00:00.000Z",
        status: "revoked",
        handled_at: "2026-09-12T10:00:00.000Z",
        first_name: "Cy",
      },
      {
        id: "req-pending",
        email: "waiting@example.com",
        requested_at: "2026-09-13T09:00:00.000Z",
        status: "pending",
        handled_at: null,
        first_name: null,
      },
    ];
    renderWithQuery(<InviteRequestsPanel />);

    expect(await screen.findByText("waiting@example.com")).toBeInTheDocument();
    expect(screen.queryByText("already@example.com")).toBeNull();
    expect(screen.queryByText("refused@example.com")).toBeNull();
    expect(screen.queryByText("removed@example.com")).toBeNull();
    expect(screen.getByText("Pending requests (1)")).toBeInTheDocument();
  });

  it("approves through the RPC that does the insert and the marking in one transaction", async () => {
    const user = userEvent.setup();
    renderWithQuery(<InviteRequestsPanel />);

    await user.click(await screen.findByRole("button", { name: /approve/i }));

    await waitFor(() => {
      expect(client.rpc).toHaveBeenCalledWith("admin_approve_request", { p_request: "req-1" });
    });
  });

  it("declines by writing the decision onto the row, and shows no request afterwards", async () => {
    const user = userEvent.setup();
    renderWithQuery(<InviteRequestsPanel />);

    await user.click(await screen.findByRole("button", { name: /^decline$/i }));

    await waitFor(() =>
      expect(updated).toEqual([{ status: "declined", handled_at: expect.any(String) }]),
    );
    expect(updatedBy).toEqual([["id", "req-1"]]);
    // A decline approves nothing and drafts nothing.
    expect(client.rpc).not.toHaveBeenCalledWith("admin_approve_request", expect.anything());
    expect(requests).toEqual([]);
    await waitFor(() => expect(screen.queryByText("hopeful@example.com")).toBeNull());
  });

  it("drafts the approval with the name on the request, through the same /invite route", async () => {
    const user = userEvent.setup();
    serviceSays(200, {
      email: "hopeful@example.com",
      firstName: "Hope",
      draftId: "d1",
      alreadyInvited: true,
    });
    renderWithQuery(<InviteRequestsPanel />);

    await user.click(await screen.findByRole("button", { name: /^approve$/i }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.url).toBe("https://meals.example.com/invite");
    // The kind is what picks the message; the name is what the greeting uses.
    expect(requests[0]?.body).toEqual({
      email: "hopeful@example.com",
      firstName: "Hope",
      kind: "approved",
    });
  });

  it("does not draft again for something already approved", async () => {
    // A second Approve on an approved request is the case that would put a second welcome email in
    // Gmail for the same person. The only thing that may draft again is the Retry button.
    requestRows = [
      {
        id: "req-1",
        email: "hopeful@example.com",
        requested_at: "2026-09-11T09:00:00.000Z",
        status: "approved",
        handled_at: "2026-09-11T10:00:00.000Z",
        first_name: "Hope",
      },
    ];
    serviceSays(200, {
      email: "hopeful@example.com",
      firstName: "Hope",
      draftId: "d1",
      alreadyInvited: true,
    });
    renderWithQuery(<InviteRequestsPanel />);

    // The row is not in the pending list at all, which is the first half of the protection.
    await waitFor(() => expect(screen.getByText("Nobody is waiting.")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /^approve$/i })).toBeNull();
    expect(requests).toEqual([]);
  });

  it("keeps the approval when the draft fails, and retries only the draft", async () => {
    const user = userEvent.setup();
    renderWithQuery(<InviteRequestsPanel />);

    // The draft fails on the first attempt, which is the case the panel has to handle without
    // making the admin think the approval was lost.
    serviceSays(502, { error: { message: "Could not create the draft in Gmail." } });
    await user.click(await screen.findByRole("button", { name: /^approve$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not create the draft in Gmail.");
    expect(alert).toHaveTextContent(/was approved and can sign in/i);

    serviceSays(200, {
      email: "hopeful@example.com",
      firstName: "Hope",
      draftId: "d1",
      alreadyInvited: true,
    });
    await user.click(screen.getByRole("button", { name: /retry draft/i }));

    await waitFor(() => expect(requests).toHaveLength(2));
    // The retry drafts again and writes nothing: the approval already happened. Reads (the trial
    // links on the rows) are not writes, so only the approval itself is counted.
    const approvals = client.rpc.mock.calls.filter(([name]) => name === "admin_approve_request");
    expect(approvals).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("the trial card", () => {
  it("reads the single row a table-returning RPC sends as an array", async () => {
    // PostgREST answers `returns table` with an array of rows even when the function can
    // only return one, so the card reads the first row rather than the reply as an object.
    client.rpc.mockImplementation((name: string) => {
      if (name === "admin_trial_stats") {
        return Promise.resolve({
          data: [{ scans_today: 47, budget: 200, user_count: 12 }],
          error: null,
        });
      }
      if (name === "admin_trial_list") return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: null, error: null });
    });

    renderWithQuery(<TrialCard />);

    expect(await screen.findByText("47 of 200 scans used today")).toBeInTheDocument();
    expect(screen.getByText("12 trials recorded")).toBeInTheDocument();
    expect(screen.getByText("12 started, 47 scans today.")).toBeInTheDocument();
  });

  it("still refuses a payload that is not a row", async () => {
    client.rpc.mockImplementation((name: string) =>
      name === "admin_trial_stats"
        ? Promise.resolve({ data: [{}], error: null })
        : Promise.resolve({ data: [], error: null }),
    );
    const user = userEvent.setup();

    renderWithQuery(<TrialCard />);
    await openSection(user, /^Trials/);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load the trial figures. The trial figures came back in an unexpected shape.",
    );
  });

  it("shows the database's own error for the figures, not a generic line", async () => {
    client.rpc.mockImplementation((name: string) =>
      name === "admin_trial_stats"
        ? Promise.resolve({
            data: null,
            error: {
              message: "permission denied for function admin_trial_stats",
              code: "42501",
            },
          })
        : Promise.resolve({ data: [], error: null }),
    );
    const user = userEvent.setup();

    renderWithQuery(<TrialCard />);
    await openSection(user, /^Trials/);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load the trial figures. permission denied for function admin_trial_stats (42501)",
    );
  });

  it("shows the database's own error for the list, not a generic line", async () => {
    client.rpc.mockImplementation((name: string) =>
      name === "admin_trial_stats"
        ? Promise.resolve({
            data: [{ scans_today: 0, budget: 200, user_count: 0 }],
            error: null,
          })
        : Promise.resolve({
            data: null,
            error: {
              message: "permission denied for function admin_trial_list",
              code: "42501",
            },
          }),
    );
    const user = userEvent.setup();

    renderWithQuery(<TrialCard />);
    await openSection(user, /^Trials/);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load the trial list. permission denied for function admin_trial_list (42501)",
    );
  });

  const TRIAL_ROWS = [
    {
      email: "priya@example.com",
      source: "link",
      invited: true,
      scans_used: 7,
      scans_limit: 10,
      first_seen: "2026-11-10T09:00:00.000Z",
      last_active: "2026-11-12T08:00:00.000Z",
      requested_after: true,
    },
    {
      email: "sam@example.com",
      source: "code",
      invited: false,
      scans_used: 2,
      scans_limit: 10,
      first_seen: "2026-11-11T09:00:00.000Z",
      last_active: null,
      requested_after: false,
    },
  ];

  /** Stats plus a list that answers the search argument the way the RPC would. */
  function trialRows(): void {
    client.rpc.mockImplementation((name: string, args?: { p_search?: string | null }) => {
      if (name === "admin_trial_stats") {
        return Promise.resolve({
          data: [{ scans_today: 9, budget: 200, user_count: 2 }],
          error: null,
        });
      }
      if (name === "admin_trial_list") {
        const term = args?.p_search ?? "";
        return Promise.resolve({
          data: term === "" ? TRIAL_ROWS : TRIAL_ROWS.filter((row) => row.email.includes(term)),
          error: null,
        });
      }
      return Promise.resolve({ data: [], error: null });
    });
  }

  it("shows one row per trial with how they arrived, scans, dates and the later request", async () => {
    trialRows();
    const user = userEvent.setup();

    renderWithQuery(<TrialCard />);
    await openSection(user, /^Trials/);

    expect(await screen.findByText("priya@example.com")).toBeInTheDocument();
    // The link route and the code route are different funnels, so the row says which.
    expect(screen.getByText(/\/t\/ link · Invited: yes · 7 of 10 scans/)).toBeInTheDocument();
    expect(
      screen.getByText(/First seen 10 Nov 2026 · Last active 12 Nov 2026/),
    ).toBeInTheDocument();
    expect(screen.getByText("Asked to join afterwards: yes")).toBeInTheDocument();

    expect(screen.getByText("sam@example.com")).toBeInTheDocument();
    expect(screen.getByText(/Email code · Invited: no · 2 of 10 scans/)).toBeInTheDocument();
    // Never active is a fact about the trial, not a missing value to hide.
    expect(screen.getByText(/Last active never/)).toBeInTheDocument();
    expect(screen.getByText("Asked to join afterwards: no")).toBeInTheDocument();
  });

  it("filters the list through the search box, through the RPC", async () => {
    trialRows();
    const user = userEvent.setup();

    renderWithQuery(<TrialCard />);
    await openSection(user, /^Trials/);
    expect(await screen.findByText("sam@example.com")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search recent trials"), "priya");

    await waitFor(
      () => {
        expect(screen.queryByText("sam@example.com")).toBeNull();
        expect(screen.getByText("priya@example.com")).toBeInTheDocument();
      },
      { timeout: 2000 },
    );
    await waitFor(
      () =>
        expect(client.rpc).toHaveBeenCalledWith("admin_trial_list", {
          p_search: "priya",
          p_limit: 50,
        }),
      { timeout: 2000 },
    );
  });
});

describe("the spend panel", () => {
  /** Two rows: the reader (an admin) and an ordinary account. Their ceilings differ. */
  function spendRows(): void {
    client.rpc.mockImplementation((name: string) => {
      if (name === "admin_spend") {
        const row = (userId: string, email: string) => ({
          user_id: userId,
          email,
          timezone: "America/New_York",
          calls_today: 11,
          resets_today: "2026-09-12T04:00:00.000Z",
          calls_month: 38,
          tokens_month: 150_045,
          calls_total: 1_203,
          tokens_total: 4_511_002,
          last_call_at: "2026-09-07T18:02:00.000Z",
        });
        return Promise.resolve({
          data: [row("user-1", "test.user@gmail.com"), row("user-2", "friend@example.com")],
          error: null,
        });
      }
      return Promise.resolve({ data: [], error: null });
    });
  }

  it("shows tokens and says there is no price", async () => {
    spendRows();
    // The limits come from the service, which is what makes the two rows below say different
    // numbers. A test without this would be exercising the fallback instead.
    serviceSays(200, { daily: 20, admin: 60, limit: 60 });

    renderWithQuery(<SpendPanel viewerId="user-1" />);

    expect(await screen.findByText("49 of 60 left today")).toBeInTheDocument();
    // Two rows, so this line appears twice; the assertion is about its shape, not its count.
    expect(screen.getAllByText(/150,045 tokens this month/)[0]).toBeInTheDocument();
    expect(screen.getByText(/no price in here on purpose/i)).toBeInTheDocument();
    // Two rows at 38 calls each, in the collapsed header.
    expect(screen.getByText("76 calls this month.")).toBeInTheDocument();
  });

  it("counts each row down from that row's own ceiling", async () => {
    spendRows();
    serviceSays(200, { daily: 20, admin: 60, limit: 60 });

    renderWithQuery(<SpendPanel viewerId="user-1" />);

    // The reader's row is an admin's: 60 - 11. Everybody else's is 20 - 11, which is the number a
    // normal account reads on this page and in Settings.
    expect(await screen.findByText("49 of 60 left today")).toBeInTheDocument();
    expect(screen.getByText("9 of 20 left today")).toBeInTheDocument();
  });
});
