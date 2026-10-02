/**
 * Both duplicate queries must exclude deleted meals.
 *
 * Asserted against the query the builder was asked to make, rather than against a database,
 * because the defect was the absence of a clause. A test that only checked the returned rows would
 * need a database and would still pass on a query that happened to return nothing.
 */
import { describe, expect, it, vi } from "vitest";

/** Every builder call either query makes, in order. */
const chain: string[] = [];

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
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

import { fetchMealForEdit, fetchRecentMeals, findMealByPhotoHashes } from "./duplicates-repo";

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
