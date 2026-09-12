/**
 * The admin data layer, against a fake Supabase client.
 *
 * These exist because a component test could not reach them. The panels normalise an
 * address before they send it, so `addInvite`'s own normalisation is dead code *from that
 * call path* — and a test driven through the panel passed with it removed. That is the
 * same trap the height field taught, so the contract is pinned here instead, at the layer
 * that owns it, where the caller cannot accidentally make it look correct.
 *
 * The most important assertion in this file is that `recordInviteRequest` sends nothing
 * but the row's defaults. The address is not a client-supplied value; if it ever becomes
 * one, this fails.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import {
  addInvite,
  approveRequest,
  fetchInviteRequests,
  fetchInvites,
  fetchIsAdmin,
  recordInviteRequest,
  removeInvite,
} from "./admin";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

const client = supabase as unknown as {
  from: ReturnType<typeof vi.fn>;
  rpc: ReturnType<typeof vi.fn>;
};

let inserted: Array<Record<string, unknown>> = [];
let deletedBy: Array<[string, unknown]> = [];
let insertResult: { error: { message: string } | null } = { error: null };

beforeEach(() => {
  inserted = [];
  deletedBy = [];
  insertResult = { error: null };
  vi.clearAllMocks();

  client.from.mockImplementation((table: string) => {
    if (table === "allowed_emails") {
      return {
        insert: (row: Record<string, unknown>) => {
          inserted.push(row);
          return Promise.resolve(insertResult);
        },
        delete: () => ({
          eq: (column: string, value: unknown) => {
            deletedBy.push([column, value]);
            return Promise.resolve({ error: null });
          },
        }),
      };
    }
    if (table === "invite_requests") {
      return {
        insert: (row: Record<string, unknown>) => {
          inserted.push(row);
          return Promise.resolve(insertResult);
        },
        select: () => ({
          order: () => Promise.resolve({ data: [], error: null }),
          limit: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
        }),
      };
    }
    return {};
  });
});

describe("addInvite", () => {
  it("normalises before it sends, whatever the caller passes", async () => {
    // The panel happens to normalise first. This is the layer that must not rely on that.
    const stored = await addInvite("  Aman.IITG@Gmail.COM ", "admin-1");

    expect(stored).toBe("aman.iitg@gmail.com");
    expect(inserted).toEqual([{ email: "aman.iitg@gmail.com", added_by: "admin-1" }]);
  });

  it("returns the stored form, so the caller can say what happened", async () => {
    expect(await addInvite("Mixed@Case.COM", "admin-1")).toBe("mixed@case.com");
  });

  it("surfaces a duplicate in words rather than as a constraint name", async () => {
    insertResult = { error: { message: 'duplicate key value violates unique constraint "x"' } };
    await expect(addInvite("a@b.co", "admin-1")).rejects.toThrow(/already on the list/);
  });
});

describe("removeInvite", () => {
  it("deletes by the normalised address, which is how it was stored", async () => {
    // Deleting by the raw string would silently match nothing and look like it worked.
    await removeInvite("  Aman.IITG@Gmail.COM ");
    expect(deletedBy).toEqual([["email", "aman.iitg@gmail.com"]]);
  });
});

describe("recordInviteRequest", () => {
  it("sends no address at all: the column default supplies it from the token", async () => {
    await recordInviteRequest();
    expect(inserted).toEqual([{}]);
  });

  it("does not throw when the database refuses, because the screen must still render", async () => {
    insertResult = { error: { message: "row-level security policy" } };
    await expect(recordInviteRequest()).resolves.toBe(false);
  });

  it("reports success when the row lands", async () => {
    await expect(recordInviteRequest()).resolves.toBe(true);
  });

  it("sends no status and no timestamp, so nothing an outsider writes can be believed", async () => {
    await recordInviteRequest();
    const body = inserted[0] ?? {};
    expect(Object.keys(body)).toEqual([]);
  });
});

describe("fetchInvites", () => {
  it("maps the joined rows into what the table shows", async () => {
    client.rpc.mockResolvedValue({
      data: [
        {
          email: "a@b.co",
          added_by: "Aman",
          created_at: "2026-09-07T12:00:00.000Z",
          signed_up_at: null,
          user_id: null,
          is_admin: false,
        },
      ],
      error: null,
    });

    expect(await fetchInvites()).toEqual([
      {
        email: "a@b.co",
        addedBy: "Aman",
        createdAt: "2026-09-07T12:00:00.000Z",
        signedUpAt: null,
        userId: null,
        isAdmin: false,
      },
    ]);
  });

  it("refuses to guess when the shape is wrong", async () => {
    client.rpc.mockResolvedValue({ data: [{ nope: true }], error: null });
    await expect(fetchInvites()).rejects.toThrow(/unexpected shape/);
  });

  it("turns the admin-only refusal into something readable", async () => {
    client.rpc.mockResolvedValue({ data: null, error: { message: "admin only" } });
    await expect(fetchInvites()).rejects.toThrow(/needs an admin account/);
  });
});

describe("fetchInviteRequests", () => {
  it("returns an empty list rather than throwing on an empty table", async () => {
    expect(await fetchInviteRequests()).toEqual([]);
  });
});

describe("approveRequest", () => {
  it("passes the request id and hands back the address that was approved", async () => {
    client.rpc.mockResolvedValue({ data: "friend@example.com", error: null });
    expect(await approveRequest("req-1")).toBe("friend@example.com");
    expect(client.rpc).toHaveBeenCalledWith("admin_approve_request", { p_request: "req-1" });
  });
});

describe("fetchIsAdmin", () => {
  it("reads false from a true value", async () => {
    client.rpc.mockResolvedValue({ data: true, error: null });
    expect(await fetchIsAdmin()).toBe(true);
  });

  it("treats a failure as not an admin, which is the safe direction", async () => {
    client.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await fetchIsAdmin()).toBe(false);
  });

  it("does not treat a truthy response as admin unless it is exactly true", async () => {
    client.rpc.mockResolvedValue({ data: "yes", error: null });
    expect(await fetchIsAdmin()).toBe(false);
  });
});
