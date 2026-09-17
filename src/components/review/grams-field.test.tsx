/**
 * TEMPORARY probe: drives the real grams field with keystrokes, the way a person clears and retypes.
 * Prints the item after every change. Delete after use.
 */
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MealItemCard } from "./MealItemCard";
import { reviewItemFromDraft, type ReviewItem } from "@/lib/review";

const DRAFT = {
  name: "Toast with butter",
  quantity: 1,
  unit: "slice",
  grams: 100,
  calories: 200,
  protein_g: 8,
  carbs_g: 24,
  fat_g: 9,
  fiber_g: 2,
  sugar_g: 3,
  sodium_mg: 300,
  confidence: 0.8,
};

function Harness({ onEach }: { onEach: (item: ReviewItem) => void }) {
  const [item, setItem] = useState<ReviewItem>(() => reviewItemFromDraft(DRAFT as never));
  return (
    <MealItemCard
      item={item}
      index={0}
      onChange={(next) => {
        onEach(next);
        setItem(next);
      }}
      onDelete={() => undefined}
    />
  );
}

/**
 * The reproduction is keystrokes, not a call with clean values, because the defect lives in the
 * sequence. Clearing the box commits `grams: null`, and the digit typed afterwards has no previous
 * grams to form a ratio from. Calling `rescaleForGrams(item, 50)` directly cannot see it.
 */
async function typeNewWeight(): Promise<ReviewItem[]> {
  const user = userEvent.setup();
  const seen: ReviewItem[] = [];
  render(<Harness onEach={(item) => seen.push(item)} />);

  const grams = screen.getByLabelText(/grams of item 1/i);
  await user.clear(grams);
  await user.type(grams, "5");
  await user.type(grams, "0");
  await user.tab();
  return seen;
}

describe("clearing the grams box and typing a new weight", () => {
  it("scales at the first digit, not only once the number is complete", async () => {
    const seen = await typeNewWeight();

    // One change per keystroke: the clear, then "5", then "50".
    expect(seen.map((item) => item.grams)).toEqual([null, 5, 50]);

    // 200 kcal at 100 g is 2 kcal per gram, so 5 g is 10 and 50 g is 100.
    // The middle value is the fix: it used to stay at 200, which anchored 200 kcal to 5 g and
    // then multiplied from that on the next keystroke.
    expect(seen.map((item) => item.calories)).toEqual([200, 10, 100]);
    expect(seen.map((item) => item.protein_g)).toEqual([8, 0.4, 4]);
    expect(seen.map((item) => item.carbs_g)).toEqual([24, 1.2, 12]);
  });

  it("leaves the nutrients alone while the box is empty, because nothing has been asked for", async () => {
    const [cleared] = await typeNewWeight();

    expect(cleared?.grams).toBeNull();
    expect(cleared?.calories).toBe(200);
  });

  it("uses the density rather than the last absolute value, so a wild value cannot compound", async () => {
    const seen = await typeNewWeight();

    // The shape of the reported bug: 100 g -> 50 g came back at 2000 kcal instead of 100.
    expect(seen[seen.length - 1]?.calories).toBe(100);
  });
});
