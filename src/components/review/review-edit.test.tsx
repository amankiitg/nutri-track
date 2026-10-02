/**
 * The review screen as an edit: the footer's basis, the note it can now change, what it sends, and
 * what it warns about before a re-analysis.
 *
 * Driven through the screen rather than the sheet. The sheet loads a meal and re-reads its photos;
 * every rule about an edit lives here, and the meal's own items arrive as `initialItems`, which is
 * exactly what the sheet passes.
 *
 * The footer assertions are the ones that matter most. The day's remainder already counts this
 * meal, so subtracting the new total from it takes the meal off the day twice — which is the same
 * wrong-basis shape that once printed "1641 kcal left of today's 1771" on a phone. 408 left with a
 * 130 kcal meal in it must read 408, not 278.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** Every call `updateMeal` was given. */
const updated: Array<{ mealId: string; input: Record<string, unknown> }> = [];

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: vi.fn(),
    auth: { getSession: vi.fn(async () => ({ data: { session: null } })) },
  },
}));

vi.mock("@/lib/duplicates-repo", () => ({
  updateMeal: async (mealId: string, input: Record<string, unknown>) => {
    updated.push({ mealId, input });
    return { meal_id: mealId, updated: true };
  },
}));

import { reviewItemFromExisting } from "@/lib/review";
import { ReviewScreen, type ReviewEditContext } from "./ReviewScreen";

/** The phone's numbers: 408 kcal left of a 1,771 target, with this meal being 130 of what was eaten. */
const REMAINING_TODAY = 408;
const TARGET = 1771;

const storedItem = {
  id: "row-1",
  name: "Chicken salad",
  quantity: null,
  unit: null,
  grams: 300,
  calories: 130,
  protein_g: 12,
  carbs_g: 8,
  fat_g: 5,
  fiber_g: 2,
  sugar_g: 1,
  sodium_mg: 300,
  confidence: 0.8,
  user_edited: false,
  llm_raw: { name: "Chicken salad", calories: 130 },
};

function renderEdit(edit: ReviewEditContext, onDiscard = vi.fn()): void {
  render(
    <ReviewScreen
      edit={edit}
      meta={{ source: "photo", model: null, attempts: 0 }}
      initialItems={[reviewItemFromExisting(storedItem)]}
      photoPaths={["user-1/a.jpg"]}
      photoHashes={["hash-a"]}
      photoPreviews={[]}
      transcript={null}
      inputFingerprint="fp-1"
      idempotencyKey="key-1"
      targetCalories={TARGET}
      remainingToday={REMAINING_TODAY}
      eatenAt={new Date("2026-09-23T17:23:00Z")}
      mealType="lunch"
      notes="half portion"
      onSaved={vi.fn()}
      onDiscard={onDiscard}
      onReanalyze={async () => {}}
      isReanalyzing={false}
    />,
  );
}

const editable: ReviewEditContext = {
  mealId: "meal-1",
  canReanalyze: true,
  onUpdated: vi.fn(),
};

describe("the footer of an edit", () => {
  it("leaves the day alone while nothing has changed", () => {
    renderEdit(editable);

    // 408 and not 278: the meal is already inside the 408.
    expect(screen.getByText(/408 kcal left/)).toBeInTheDocument();
  });

  it("subtracts only what the correction added", async () => {
    renderEdit(editable);
    const user = userEvent.setup();
    const calories = screen.getByLabelText("Calories (kcal) for item 1");

    await user.clear(calories);
    await user.type(calories, "200");

    // 408 + 130 - 200. The correction was +70, so 70 kcal should be gone from the day.
    expect(screen.getByText(/338 kcal left/)).toBeInTheDocument();
  });
});

describe("what an edit shows", () => {
  it("offers the note as something that can be changed", () => {
    renderEdit(editable);

    expect(screen.getByLabelText("Notes")).toHaveValue("half portion");
  });

  it("says it is an edit rather than claiming a model produced these numbers", () => {
    renderEdit(editable);

    expect(screen.getByText(/editing a saved meal/)).toBeInTheDocument();
    expect(screen.queryByText(/copied from an earlier meal/)).not.toBeInTheDocument();
  });

  it("labels its buttons for an edit, not a capture", () => {
    renderEdit(editable);

    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Discard/ })).not.toBeInTheDocument();
  });
});

describe("saving an edit", () => {
  it("sends the row id with the item, the meal id, and the note as typed", async () => {
    updated.length = 0;
    const onUpdated = vi.fn();
    renderEdit({ ...editable, onUpdated });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onUpdated).toHaveBeenCalledWith({ meal_id: "meal-1", updated: true });
    expect(updated[0]?.mealId).toBe("meal-1");
    expect(updated[0]?.input["notes"]).toBe("half portion");
    expect(updated[0]?.input["mealType"]).toBe("lunch");
    const items = updated[0]?.input["items"] as Array<Record<string, unknown>>;
    expect(items[0]?.["existingItemId"]).toBe("row-1");
  });
});

describe("re-analysing during an edit", () => {
  it("warns that the model's original numbers for the replaced items go with them", async () => {
    renderEdit(editable);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Re-analyze with a hint/ }));
    await user.type(screen.getByLabelText("Hint for re-analysis"), "the rice was a small portion");
    await user.click(screen.getByRole("button", { name: "Go" }));

    // Nothing has been edited by hand here, and the confirmation appears anyway: re-analysing an
    // edit deletes the rows on screen, so what the model originally said about this meal is lost
    // whether or not the person touched a number themselves.
    expect(await screen.findByText(/will not be kept/)).toBeInTheDocument();
    expect(screen.getByText("Re-analyze this meal?")).toBeInTheDocument();
  });

  it("does not offer a second reading when there is nothing to read again", () => {
    renderEdit({ ...editable, canReanalyze: false });

    expect(screen.queryByRole("button", { name: /Re-analyze/ })).not.toBeInTheDocument();
    expect(screen.getByText(/no photos to read again/)).toBeInTheDocument();
  });
});
