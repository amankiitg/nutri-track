/**
 * The box that starts a meal, and the two inputs behind it.
 *
 * The whole point is the difference between them: the box carries `capture="environment"`, so a
 * phone opens the camera, and the link underneath does not, so a phone opens the library. Getting
 * those two the wrong way round would leave no way to pick a photo taken earlier.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SnapBox } from "./SnapBox";

function inputs(container: HTMLElement): {
  camera: HTMLInputElement;
  library: HTMLInputElement;
} {
  const camera = container.querySelector<HTMLInputElement>('input[data-snap-input="camera"]');
  const library = container.querySelector<HTMLInputElement>('input[data-snap-input="library"]');
  if (camera === null || library === null) throw new Error("an input is missing");
  return { camera, library };
}

describe("the snap box", () => {
  it("says what happens, in the words the brief asked for", () => {
    render(<SnapBox onPhoto={() => {}} />);

    expect(screen.getByRole("button", { name: /tap to snap your meal/i })).toBeInTheDocument();
    expect(screen.getByText("or choose a photo from your library")).toBeInTheDocument();
    expect(screen.getByText("Choose from photos")).toBeInTheDocument();
  });

  it("opens the camera from the box and the library from the link", () => {
    const { container } = render(<SnapBox onPhoto={() => {}} />);
    const { camera, library } = inputs(container);

    expect(camera.getAttribute("capture")).toBe("environment");
    expect(camera.accept).toBe("image/*");
    // The link has no capture, which is what makes it the library on a phone.
    expect(library.hasAttribute("capture")).toBe(false);
    expect(library.accept).toBe("image/*");
  });

  it("hands the chosen file back, from either input", async () => {
    const onPhoto = vi.fn();
    const { container } = render(<SnapBox onPhoto={onPhoto} />);
    const { camera, library } = inputs(container);
    const user = userEvent.setup();

    const first = new File(["a"], "camera.jpg", { type: "image/jpeg" });
    await user.upload(camera, first);
    expect(onPhoto).toHaveBeenCalledWith(first);

    const second = new File(["b"], "library.jpg", { type: "image/jpeg" });
    await user.upload(library, second);
    expect(onPhoto).toHaveBeenCalledWith(second);
  });

  it("cannot be pressed while it is disabled, which is what the photo limit does", async () => {
    const onPhoto = vi.fn();
    const { container } = render(<SnapBox onPhoto={onPhoto} disabled />);

    expect(screen.getByRole("button", { name: /tap to snap your meal/i })).toBeDisabled();
    const { camera } = inputs(container);
    const file = new File(["a"], "x.jpg", { type: "image/jpeg" });
    // The input still exists, but the box cannot open it; the sheet gates the count separately.
    expect(camera.disabled).toBe(false);
  });
});
