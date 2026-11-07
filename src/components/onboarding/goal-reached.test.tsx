/**
 * The goal group when the target is already behind you.
 *
 * The bug this pins: the screen went on projecting a date for a target that had already been
 * passed, so somebody who had lost the weight they meant to lose was told they would arrive in a
 * few weeks and kept a deficit they no longer needed. The date has to disappear, and the notice
 * has to take its place, from the same numbers.
 */
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GoalStep } from "./steps";
import { DEFAULT_ONBOARDING_FORM, type OnboardingForm } from "@/lib/onboarding";

/** Holds the form the way the wizard and the settings form do, so the button has something to do. */
function Harness({ initial }: { initial: OnboardingForm }) {
  const [form, setForm] = useState(initial);
  return (
    <GoalStep
      form={form}
      errors={{}}
      setField={(key, value) => setForm((previous) => ({ ...previous, [key]: value }))}
    />
  );
}

const base = (over: Partial<OnboardingForm>): OnboardingForm => ({
  ...DEFAULT_ONBOARDING_FORM,
  goal: "lose",
  weight_kg: 80,
  target_weight_kg: 70,
  pace_kg_per_week: 0.5,
  ...over,
});

describe("a target that is still ahead", () => {
  it("keeps the projection and shows no notice", () => {
    render(<Harness initial={base({})} />);

    expect(screen.getByText(/you'd reach/i)).toBeInTheDocument();
    expect(screen.queryByText(/you're at your target weight/i)).toBeNull();
  });
});

describe("a target that has been passed", () => {
  it("replaces the projection with the notice, rather than dating a target behind you", () => {
    render(<Harness initial={base({ weight_kg: 69 })} />);

    expect(screen.getByText(/you're at your target weight/i)).toBeInTheDocument();
    expect(screen.getByText(/switch to maintain to stop the deficit/i)).toBeInTheDocument();
    // The date is the thing that must not be there.
    expect(screen.queryByText(/you'd reach/i)).toBeNull();
  });

  it("treats landing exactly on the target as arrived", () => {
    render(<Harness initial={base({ weight_kg: 70 })} />);

    expect(screen.getByText(/you're at your target weight/i)).toBeInTheDocument();
    expect(screen.queryByText(/you'd reach/i)).toBeNull();
  });

  it("switches the form to Maintain on one tap, leaving the Save to the person", async () => {
    const user = userEvent.setup();
    render(<Harness initial={base({ weight_kg: 69 })} />);

    await user.click(screen.getByRole("button", { name: /switch to maintain/i }));

    // The notice is gone because the goal is now maintain, which is the visible proof the tap
    // changed the form rather than only the notice.
    expect(screen.queryByText(/you're at your target weight/i)).toBeNull();
    expect(screen.getByRole("radio", { name: /maintain/i })).toBeChecked();
  });

  it("does not submit anything: the button sits inside the settings form", async () => {
    const user = userEvent.setup();
    render(<Harness initial={base({ weight_kg: 69 })} />);

    const button = screen.getByRole("button", { name: /switch to maintain/i });
    expect(button).toHaveAttribute("type", "button");
  });
});

describe("a gain goal", () => {
  it("is only arrived when the weight is at or above the target", () => {
    const { unmount } = render(<Harness initial={base({ goal: "gain", weight_kg: 70 })} />);
    expect(screen.getByText(/you're at your target weight/i)).toBeInTheDocument();
    unmount();

    render(<Harness initial={base({ goal: "gain", weight_kg: 65 })} />);
    expect(screen.queryByText(/you're at your target weight/i)).toBeNull();
    expect(screen.getByText(/you'd reach/i)).toBeInTheDocument();
  });
});
