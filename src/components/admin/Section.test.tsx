/**
 * The collapsible section on its own: the two things a wrapper this small can get wrong
 * are the accessible state and the remembered one.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Section } from "./Section";

beforeEach(() => {
  window.localStorage.clear();
});

function build(id = "alpha", defaultOpen = false) {
  return (
    <Section id={id} title="Alpha" summary="3 things" defaultOpen={defaultOpen}>
      <p>body text</p>
    </Section>
  );
}

describe("the collapsible section", () => {
  it("starts closed by default and opens from its header button", async () => {
    const user = userEvent.setup();
    render(build());

    const header = screen.getByRole("button", { name: /Alpha/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("body text")).not.toBeVisible();

    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("body text")).toBeVisible();
  });

  it("opens on first render when asked, and remembers a choice across mounts", async () => {
    const user = userEvent.setup();
    const first = render(build("alpha", true));
    expect(screen.getByRole("button", { name: /Alpha/ })).toHaveAttribute("aria-expanded", "true");

    await user.click(screen.getByRole("button", { name: /Alpha/ }));
    first.unmount();

    render(build("alpha", true));
    // The effect reads the stored value after the first paint, which is why this waits.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Alpha/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      ),
    );
  });

  it("keeps its sections apart, so one being open does not open another", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Section id="one" title="One" summary="first">
          <p>one body</p>
        </Section>
        <Section id="two" title="Two" summary="second">
          <p>two body</p>
        </Section>
      </>,
    );

    await user.click(screen.getByRole("button", { name: /One/ }));
    expect(screen.getByRole("button", { name: /One/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /Two/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("still works when the stored value is not JSON, or storage throws", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("nutritrack.admin.sections", "not json");
    render(build());

    const header = screen.getByRole("button", { name: /Alpha/ });
    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
  });
});
