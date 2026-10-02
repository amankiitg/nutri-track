/**
 * Both duplicate queries must exclude deleted meals.
 *
 * Asserted against the query the builder was asked to make, rather than against a database,
 * because the defect was the absence of a clause. A test that only checked the returned rows would
 * need a database and would still pass on a query that happened to return nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Every builder call either query makes, in order. */
const chain: string[] = [];

/** What `rpc` was asked for, and what it should answer next. */
const rpcCalls: Array<{ name: string; args: unknown }> = [];
let rpcReply: { data: unknown; error: { code?: string; message: string } | null } = {
  data: { meal_id: "meal-1", updated: true },
  error: null,
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return rpcReply;
    },
    from: () => {
      const calls: Array<[string, unknown[]]> = [];
      const builder: Record<string, unknown> = {
        then: (resolve: (value: unknown) => void) => {
          chain.push(...calls.map(([name, args]) => `${name}(${args.join(",")})`));
          return resolve({ data: [], error: null });
        },
      };
      for (const name of ["select", "gte", "lte", "overlaps", "order", "limit", "is", "in", "eq"]) {
        builder[name] = (...args: unknown[]) => {
          calls.push([name, args]);
          return builder;
        };
      }
      // The edit query loads one meal, so it ends in `maybeSingle` rather than being awaited
      // directly. Recorded like the rest so the select list can be asserted.
      builder["maybeSingle"] = async () => {
        chain.push(...calls.map(([name, args]) => `${name}(${args.join(",")})`));
        return {
          data: {
            id: "meal-1",
            eaten_at: "2026-10-02T13:34:00Z",
            meal_type: "lunch",
            source: "photo",
            notes: null,
            photo_paths: [],
            photo_hashes: [],
            input_fingerprint: "fp",
          },
          error: null,
        };
      };
      return builder;
    },
  },
}));

import {
  fetchMealForEdit,
  fetchRecentMeals,
  findMealByPhotoHashes,
  updateMeal,
} from "./duplicates-repo";
import { blankReviewItem } from "./review";

describe("the duplicate queries exclude deleted meals", () => {
  it("the photo-hash lookup, which is the one that named a deleted lunch", async () => {
    chain.length = 0;
    await findMealByPhotoHashes(["hash-1"], new Date("2026-09-19T12:00:00Z"));

    // Recorded as `is(deleted_at,)`: `Array.join` renders the null operand as an empty field.
    expect(chain.join(" ")).toContain("is(deleted_at,");
  });

  it("the name-similarity lookup, which had the same gap", async () => {
    chain.length = 0;
    await fetchRecentMeals(new Date("2026-09-19T12:00:00Z"));

    expect(chain.join(" ")).toContain("is(deleted_at,");
  });
});

describe("writing an edit", () => {
  const input = {
    items: [blankReviewItem()],
    mealType: "lunch" as const,
    eatenAt: new Date("2026-10-02T13:34:00Z"),
    notes: null,
  };

  beforeEach(() => {
    rpcCalls.length = 0;
    rpcReply = { data: { meal_id: "meal-1", updated: true }, error: null };
  });

  it("calls update_meal with the meal id and the payload it takes", async () => {
    const result = await updateMeal("meal-1", input);

    expect(rpcCalls[0]?.name).toBe("update_meal");
    const args = rpcCalls[0]?.args as { _meal_id: string; _meal: Record<string, unknown> };
    expect(args._meal_id).toBe("meal-1");
    // The provenance fields are absent, not empty: the RPC refuses to write them, so sending them
    // would describe a write that does not happen.
    expect(Object.keys(args._meal).sort()).toEqual(["eaten_at", "meal_type", "notes"]);
    expect(result).toEqual({ meal_id: "meal-1", updated: true });
  });

  it("turns the refusal into a sentence rather than Postgres text", async () => {
    // P0002 covers "not this user's", "gone" and "soft-deleted", which are one answer to someone
    // who cannot act on the difference.
    rpcReply = {
      data: null,
      error: { code: "P0002", message: "update_meal: that meal is not on this user's record" },
    };

    await expect(updateMeal("meal-1", input)).rejects.toThrow(
      "That meal is no longer on your record.",
    );
  });

  it("says so when the payload cannot be honoured", async () => {
    rpcReply = { data: null, error: { code: "22023", message: "update_meal: no items" } };

    await expect(updateMeal("meal-1", input)).rejects.toThrow("A meal needs at least one item.");
  });

  it("does not dress a real failure up as one of those two", async () => {
    // A dropped connection must not send someone looking for a meal that is perfectly fine.
    rpcReply = { data: null, error: { code: "08006", message: "connection failure" } };

    await expect(updateMeal("meal-1", input)).rejects.toThrow("connection failure");
  });

  it("refuses to call a reply without a meal id a save", async () => {
    rpcReply = { data: {}, error: null };

    await expect(updateMeal("meal-1", input)).rejects.toThrow("The change was not saved.");
  });
});

describe("loading a meal to edit", () => {
  it("asks for the row id and the model's raw output, which the copy query does not", async () => {
    chain.length = 0;
    await fetchMealForEdit("meal-1");
    const asked = chain.join(" ");

    // Without `id` the save cannot tell an update from an insert; without `llm_raw` the update
    // has nothing to leave alone, and the model's original would be lost on the first edit.
    expect(asked).toContain("id");
    expect(asked).toContain("llm_raw");
    // A deleted meal is not on the record, so it is not editable.
    expect(asked).toContain("deleted_at");
  });
});
