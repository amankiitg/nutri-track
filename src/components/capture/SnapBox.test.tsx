/**
 * The box that starts a meal, and the single input behind it.
 *
 * The attribute that is deliberately absent is the point: no `capture`, so a phone shows its own
 * sheet with Take Photo and Photo Library rather than going straight to the camera.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SnapBox } from "./SnapBox";

function input(container: HTMLElement): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>('input[data-snap-input="photo"]');
  if (found === null) throw new Error("the photo input is missing");
  return found;
}

describe("the snap box", () => {
  it("says what happens, in the words the brief asked for", () => {
    render(<SnapBox onPhoto={() => {}} />);

    expect(
      screen.getByRole("button", { name: /tap to add a photo of your meal/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Take one now or pick from your photos")).toBeInTheDocument();
  });

  it("opens the native picker, with no capture attribute and no second control", () => {
    const { container } = render(<SnapBox onPhoto={() => {}} />);
    const photo = input(container);

    expect(photo.accept).toBe("image/*");
    // No capture: iOS and Android then offer Take Photo and Photo Library on their own sheet.
    expect(photo.hasAttribute("capture")).toBe(false);
    // One input only, and no separate library link to keep in step with it.
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(screen.queryByText(/choose from photos/i)).toBeNull();
  });

  it("hands the chosen file back", async () => {
    const onPhoto = vi.fn();
    const { container } = render(<SnapBox onPhoto={onPhoto} />);
    const user = userEvent.setup();

    const file = new File(["a"], "plate.jpg", { type: "image/jpeg" });
    await user.upload(input(container), file);
    expect(onPhoto).toHaveBeenCalledWith(file);
  });

  it("cannot be pressed while it is disabled, which is what the photo limit does", () => {
    render(<SnapBox onPhoto={() => {}} disabled />);

    expect(screen.getByRole("button", { name: /tap to add a photo of your meal/i })).toBeDisabled();
  });
});
