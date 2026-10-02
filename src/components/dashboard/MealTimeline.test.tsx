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
  const onEdit = vi.fn();
  render(
    <MealTimeline
      meals={[MEAL]}
      timeZone="UTC"
      onDelete={onDelete}
      onEdit={onEdit}
      busyId={null}
    />,
  );
  return { onDelete, onEdit };
}

/**
 * A real drag on the row: press on the row, move to one or two positions, release.
 *
 * Driven as pointer events on the DOM rather than by calling the handlers, because the thing
 * being tested is the gesture — the last two UI bugs in this codebase were both wiring that a
 * direct call to the function could not see.
 */
function drag(moves: readonly number[]): void {
  const body = row();
  fireEvent.pointerDown(body, { clientX: 400, pointerId: 1 });
  for (const move of moves) {
    fireEvent.pointerMove(body, { clientX: 400 + move, pointerId: 1 });
  }
  fireEvent.pointerUp(body, { pointerId: 1 });
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

  it("offers Edit in the same menu", async () => {
    const { onEdit } = renderRow();
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(menuTrigger());
    await user.click(await screen.findByRole("menuitem", { name: /^edit$/i }));

    expect(onEdit).toHaveBeenCalledWith(MEAL);
  });
});

/**
 * The two directions, and the drags that must decide neither.
 *
 * A left swipe reveals Delete and a right swipe reveals Edit — opposite actions on one row, one of
 * them destructive. Every case below starts from the same closed row, because a gesture that only
 * behaves when the row is already open is not the gesture anyone performs.
 *
 * The latched state is asserted through the row's own transform, which is what the gesture
 * actually changes: a reveal is not the action. The action is taken by the control it reveals, and
 * that is asserted separately.
 */
describe("the swipe, in both directions", () => {
  it("reveals Delete when dragged left", () => {
    renderRow();
    drag([-100]);
    expect(row().style.transform).toBe("translateX(-96px)");
  });

  it("reveals Edit when dragged right, from the same closed row", () => {
    renderRow();
    drag([100]);
    expect(row().style.transform).toBe("translateX(96px)");
  });

  it("commits nothing on a short drag in either direction", () => {
    renderRow();
    drag([-40]);
    expect(row().style.transform).toBe("translateX(0px)");

    drag([40]);
    expect(row().style.transform).toBe("translateX(0px)");
  });

  it("commits nothing when a drag goes one way and then the other just as far", () => {
    renderRow();

    // Out to the right, then out to the left past it — but by less than the margin that says
    // which one was meant. Between an edit and a delete, guessing is the wrong answer.
    drag([80, -100]);

    expect(row().style.transform).toBe("translateX(0px)");
  });

  it("still commits the direction a wobbling drag clearly resolved to", () => {
    renderRow();

    // The control for the case above: a brief wander the other way does not cancel a drag that
    // ends far out on one side.
    drag([-20, 100]);

    expect(row().style.transform).toBe("translateX(96px)");
  });

  it("holds the boundary on the constant, not on a feel", () => {
    renderRow();

    // 58 is COMMIT_TRAVEL. One pixel short latches nothing at all; this is the pair of asserts
    // that makes the number a decision rather than a magic one.
    drag([-57]);
    expect(row().style.transform).toBe("translateX(0px)");

    drag([-58]);
    expect(row().style.transform).toBe("translateX(-96px)");
  });

  it("takes the action from the control each direction reveals", async () => {
    const { onDelete, onEdit } = renderRow();
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    drag([-100]);
    await user.click(screen.getByRole("button", { name: /^delete lunch$/i }));
    expect(onDelete).toHaveBeenCalledWith(MEAL);
    expect(onEdit).not.toHaveBeenCalled();

    drag([100]);
    await user.click(screen.getByRole("button", { name: /^edit lunch$/i }));
    expect(onEdit).toHaveBeenCalledWith(MEAL);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
