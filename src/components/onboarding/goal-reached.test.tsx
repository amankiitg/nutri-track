/**
 * The at-target notice, and which screens may show it.
 *
 * The bug this pins: on 77 kg against an 85 kg lose target, both "your target is above your current
 * weight" and "you're at your target weight" appeared at once. They are two answers to one
 * question, so distance now decides which one is honest — a kilogram either side of the target is
 * being there, more than a kilogram on the wrong side is a mistake.
 *
 * The notice is also not onboarding's to show. A new user has no weigh-ins, so "you're at your
 * target" would be a claim about history they do not have; Settings is where the weight has moved.
 */
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GoalStep } from "./steps";
import { ProfileForm } from "./ProfileForm";
import { DEFAULT_ONBOARDING_FORM, type OnboardingForm } from "@/lib/onboarding";
import type { Profile } from "@/lib/profile";
import { lbToKg } from "@/lib/units";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    storage: { from: vi.fn() },
    auth: { getSession: vi.fn(), getUser: vi.fn() },
  },
}));

const NOTICE = /you're at your target weight/i;

/** Holds the form the way the wizard and the settings form do, so the button has something to do. */
function Harness({
  initial,
  showReachedNotice = false,
}: {
  initial: OnboardingForm;
  showReachedNotice?: boolean;
}) {
  const [form, setForm] = useState(initial);
  return (
    <GoalStep
      form={form}
      errors={{}}
      setField={(key, value) => setForm((previous) => ({ ...previous, [key]: value }))}
      showReachedNotice={showReachedNotice}
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

describe("onboarding: the notice is never shown", () => {
  it("says nothing when the weight is already on the target", () => {
    render(<Harness initial={base({ weight_kg: 70 })} />);

    expect(screen.queryByText(NOTICE)).toBeNull();
    // And no date either: there is nothing left to wait for.
    expect(screen.queryByText(/you'd reach/i)).toBeNull();
  });

  it("says nothing when the target has just been passed", () => {
    render(<Harness initial={base({ weight_kg: 69 })} />);

    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it("keeps the projection for a target that is still ahead", () => {
    render(<Harness initial={base({})} />);

    expect(screen.getByText(/you'd reach/i)).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});

describe("settings: the notice belongs here", () => {
  it("shows it once the weight is within a kilogram of the target", () => {
    render(<Harness initial={base({ weight_kg: 69.5 })} showReachedNotice />);

    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(screen.getByText(/switch to maintain to stop the deficit/i)).toBeInTheDocument();
    // The date is the other thing that must not be there: it is not still to come.
    expect(screen.queryByText(/you'd reach/i)).toBeNull();
  });

  it("does not show it for a target that is ahead", () => {
    render(<Harness initial={base({ weight_kg: 65, target_weight_kg: 55 })} showReachedNotice />);

    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.getByText(/you'd reach/i)).toBeInTheDocument();
  });

  it("switches the form to Maintain on one tap, leaving the Save to the person", async () => {
    const user = userEvent.setup();
    render(<Harness initial={base({ weight_kg: 69.5 })} showReachedNotice />);

    await user.click(screen.getByRole("button", { name: /switch to maintain/i }));

    // The notice is gone because the goal is now maintain, which is the visible proof the tap
    // changed the form rather than only the notice.
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.getByRole("radio", { name: /maintain/i })).toBeChecked();
  });

  it("does not submit anything: the button sits inside the settings form", () => {
    render(<Harness initial={base({ weight_kg: 69.5 })} showReachedNotice />);

    const button = screen.getByRole("button", { name: /switch to maintain/i });
    expect(button).toHaveAttribute("type", "button");
  });

  it("is the same rule when gaining", () => {
    const { unmount } = render(
      <Harness
        initial={base({ goal: "gain", weight_kg: 70.5, target_weight_kg: 70 })}
        showReachedNotice
      />,
    );
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    unmount();

    render(<Harness initial={base({ goal: "gain", weight_kg: 65 })} showReachedNotice />);
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.getByText(/you'd reach/i)).toBeInTheDocument();
  });
});

/** Settings as the app renders it: the whole profile form, with its own validation. */
const STORED_PROFILE = {
  user_id: "user-1",
  display_name: "Aman",
  dob: "1994-01-01",
  sex: "female",
  height_cm: 175,
  activity_level: "moderately_active",
  pace_kg_per_week: 0.5,
  units: "imperial",
  dietary_tags: [],
  timezone: "America/New_York",
  reminder_time: null,
  protein_g_per_kg: 1.6,
};

type StoredProfile = Omit<Profile, "goal" | "weight_kg" | "target_weight_kg">;

/** The lb pair from the report: 169.8 lb against a 170 lb target, which is 90 g apart in kg. */
const profile = (over: Partial<Profile>): Profile =>
  ({
    ...(STORED_PROFILE as unknown as StoredProfile),
    goal: "lose",
    weight_kg: lbToKg(169.8),
    target_weight_kg: lbToKg(170),
    ...over,
  }) as Profile;

describe("settings, driven through the form", () => {
  it("shows the notice for 169.8 lb against a 170 lb target, and no direction error", () => {
    render(<ProfileForm profile={profile({})} onSaved={vi.fn()} />);

    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(screen.queryByText(/your target is above your current weight/i)).toBeNull();
    expect(screen.queryByText(/your target is below your current weight/i)).toBeNull();
    // 1 lb apart, so there is no date to print either.
    expect(screen.queryByText(/you'd reach/i)).toBeNull();
  });

  it("shows the error for 77 kg against an 85 kg lose target, and never the notice", async () => {
    const user = userEvent.setup();
    render(
      <ProfileForm
        profile={profile({ units: "metric", weight_kg: 77, target_weight_kg: 85 })}
        onSaved={vi.fn()}
      />,
    );

    // Nothing is refused until Save, which is the moment the form validates.
    expect(screen.queryByText(NOTICE)).toBeNull();
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(
      screen.getByText(
        "Your target is above your current weight. Choose Gain weight, or lower the target.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
