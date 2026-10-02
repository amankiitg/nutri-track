/**
 * The row's two ways to delete, and the one thing that must not happen between them.
 *
 * Delete has always existed, but behind a swipe: discoverable with a finger and invisible with a
 * mouse. The overflow menu is the second path, and the one that needs no prior knowledge.
 *
 * The trap is that the menu's button lives *inside* the row that treats a pointerdown on itself
 * as the start of a drag. Radix opens the menu on pointerdown, so without a guard the menu would
 * open and the row would begin a swipe at the same time — and a drag that ends over the menu is
 * not a delete, it is a meal that slid sideways and sprang back.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MealTimeline } from "./MealTimeline";
import type { TimelineMeal } from "@/lib/dashboard";

afterEach(() => {
  // A Radix menu portals into document.body and, while it is open, marks the rest of the tree
  // aria-hidden. `cleanup` unmounts the container but leaves the portal, so a test that opens a
  // menu — even by pressing the trigger, which is what opening one means — would leave the next
  // test unable to find anything by role.
  cleanup();
  document.body.innerHTML = "";
});

const MEAL: TimelineMeal = {
  id: "meal-1",
  eaten_at: "2026-09-27T13:34:00Z",
  meal_type: "lunch",
  source: "photo",
  notes: null,
  photo_count: 1,
  calories: 420,
  protein_g: 35,
  carbs_g: 12,
  fat_g: 24,
  item_count: 1,
  items: [
    {
      id: "item-1",
      name: "Chicken salad",
      quantity: null,
      unit: null,
      grams: 300,
      calories: 420,
      protein_g: 35,
      carbs_g: 12,
      fat_g: 24,
      fiber_g: 3,
      confidence: 0.8,
      user_edited: false,
    },
  ],
};

function renderRow() {
  const onDelete = vi.fn();
  render(<MealTimeline meals={[MEAL]} timeZone="UTC" onDelete={onDelete} busyId={null} />);
  return { onDelete };
}

/** The row body, which owns the swipe. */
const row = () => screen.getByRole("group");
/** The always-visible control, which is inside the row. */
const menuTrigger = () => screen.getByRole("button", { name: /actions for lunch/i });

describe("the actions on a meal row", () => {
  it("offers Delete in an overflow menu, for someone who does not know the gesture", async () => {
    const { onDelete } = renderRow();
    // Radix sets pointer-events: none on the body while a menu is open, which user-event then
    // refuses to click through.
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(menuTrigger());
    const item = await screen.findByRole("menuitem", { name: /^delete$/i });
    await user.click(item);

    expect(onDelete).toHaveBeenCalledWith(MEAL);
  });

  it("opens the menu without deleting anything by itself", async () => {
    const { onDelete } = renderRow();
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(menuTrigger());
    await screen.findByRole("menuitem", { name: /^delete$/i });

    expect(onDelete).not.toHaveBeenCalled();
  });

  it("keeps the swipe target it always had, named for a screen reader", () => {
    renderRow();
    expect(screen.getByRole("button", { name: /^delete lunch$/i })).toBeInTheDocument();
  });

  it("does not start a swipe when the menu button is pressed", () => {
    renderRow();
    // Both queried before the press: opening the menu marks everything outside it aria-hidden,
    // so a role query afterwards finds nothing. Same reason as the reset in `afterEach`.
    const trigger = menuTrigger();
    const body = row();

    // A press on the button, then a drag: the guard stops the press reaching the row, so the
    // drag has nothing to move. Without it this ends at translateX(-96px).
    fireEvent.pointerDown(trigger, { clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(body, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(body, { pointerId: 1 });

    expect(body.style.transform).toBe("translateX(0px)");
  });

  it("still swipes when the drag starts on the row itself", () => {
    renderRow();
    const body = row();

    // The control for the test above: the same drag, started one element lower down the tree.
    fireEvent.pointerDown(body, { clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(body, { clientX: 100, pointerId: 1 });

    expect(body.style.transform).toBe("translateX(-96px)");
  });
});
