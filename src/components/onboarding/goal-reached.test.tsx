/**
 * The at-target notice, and which screens may show it.
 *
 * The rule is `maintainSuggestion`'s: the trailing 7-day average, at least three weigh-ins, and
 * within 0.5 kg of the target or past it. Settings used to answer the same question from the
 * stored weight alone, which is how 167.2 lb against a 165 lb target showed a notice Today hid.
 * The screen now renders only the decision the route made, so the form's own numbers cannot
 * produce a notice of their own.
 *
 * The notice is also not onboarding's to show. A new user has no weigh-ins, so "you're at your
 * target" would be a claim about history they do not have.
 */
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GoalStep } from "./steps";
import { ProfileForm } from "./ProfileForm";
import { DEFAULT_ONBOARDING_FORM, type OnboardingForm } from "@/lib/onboarding";
import type { MaintainSuggestion } from "@/lib/maintain-suggestion";
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
  maintain = null,
  today = "2026-11-19",
}: {
  initial: OnboardingForm;
  maintain?: MaintainSuggestion | null;
  today?: string;
}) {
  const [form, setForm] = useState(initial);
  return (
    <GoalStep
      form={form}
      errors={{}}
      setField={(key, value) => setForm((previous) => ({ ...previous, [key]: value }))}
      maintain={maintain}
      today={today}
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
    expect(screen.queryByText(/you'll reach/i)).toBeNull();
  });

  it("says nothing when the target has just been passed", () => {
    render(<Harness initial={base({ weight_kg: 69 })} />);

    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it("projects from the weight typed on the body step", () => {
    // A new user has no week of weigh-ins, so the typed weight is the basis here. 72 kg to
    // 70 kg at 0.5 kg/week is four weeks, and 19 Nov plus 28 days is 17 Dec.
    render(<Harness initial={base({ weight_kg: 72, target_weight_kg: 70 })} />);

    expect(
      screen.getByText("You'll reach 70.0 kg around 17 Dec at 0.5 kg/week."),
    ).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it("does the same in pounds", () => {
    // 170 lb to 165 lb is 2.27 kg, which at 0.5 kg/week is 32 days from 19 Nov: 21 Dec.
    render(
      <Harness
        initial={base({
          units: "imperial",
          weight_kg: Number(lbToKg(170).toFixed(2)),
          target_weight_kg: Number(lbToKg(165).toFixed(2)),
        })}
      />,
    );

    expect(
      screen.getByText(/You'll reach 165\.0 lb around 21 Dec at 1\.1 lb\/week\./),
    ).toBeInTheDocument();
  });

  it("moves when the pace or the target changes, before anything is saved", async () => {
    const user = userEvent.setup();
    render(<Harness initial={base({ weight_kg: 72, target_weight_kg: 70 })} />);
    expect(screen.getByText(/around 17 Dec/)).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /0\.25 kg\/week/i }));
    // 2 kg at 0.25 kg/week is eight weeks: 19 Nov plus 56 days is 14 Jan.
    expect(screen.getByText(/around 14 Jan/)).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /0\.5 kg\/week/i }));
    const target = screen.getByLabelText("Target weight");
    await user.clear(target);
    await user.type(target, "68");
    await user.tab();
    // 4 kg at 0.5 kg/week is eight weeks again, so the same day.
    expect(screen.getByText(/around 14 Jan/)).toBeInTheDocument();
  });

  it("is hidden on maintain, where there is nowhere to arrive", () => {
    render(<Harness initial={base({ goal: "maintain", weight_kg: 72 })} />);

    expect(screen.queryByText(/you'll reach/i)).toBeNull();
  });

  it("is hidden once the typed weight is already at the target", () => {
    // Settings says "you're at your target" here; onboarding does not, because this step is
    // asking where they want to go and the answer is the maintain choice.
    render(<Harness initial={base({ weight_kg: 70, target_weight_kg: 70 })} />);

    expect(screen.queryByText(/you'll reach/i)).toBeNull();
    expect(screen.queryByText(/at your target/i)).toBeNull();
  });

  it("follows the weight the form holds when the wizard renders it again", () => {
    const first = render(<Harness initial={base({ weight_kg: 72 })} />);
    expect(screen.getByText(/around 17 Dec/)).toBeInTheDocument();
    first.unmount();

    // 71 kg to 70 kg at 0.5 kg/week is two weeks: 3 Dec.
    render(<Harness initial={base({ weight_kg: 71 })} />);
    expect(screen.getByText(/around 3 Dec/)).toBeInTheDocument();
  });
});

describe("settings: it shows Today's decision, not its own", () => {
  const AT_TARGET: MaintainSuggestion = { averageKg: 69.5, crossed: false };

  it("shows the decision it was handed, with the average in the reader's units", () => {
    // The form's stored weight is two kilos from the target, which used to hide the notice here.
    // The week of weigh-ins is what decides now.
    render(<Harness initial={base({ weight_kg: 72 })} maintain={AT_TARGET} />);

    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(screen.getByText(/switch to maintain to stop the deficit/i)).toBeInTheDocument();
    expect(screen.getByText(/your 7-day average is 69\.5 kg/i)).toBeInTheDocument();
    // The date is the other thing that must not be there: the average has arrived.
    expect(screen.queryByText(/you'll reach/i)).toBeNull();
  });

  it("says nothing when the route passed nothing, even with the form weight on the target", () => {
    // The old Settings-only check, deleted: a stored 70 kg against a 70 kg target was enough on
    // this screen whatever the week said.
    render(<Harness initial={base({ weight_kg: 70, target_weight_kg: 70 })} />);

    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.queryByText(/7-day average/i)).toBeNull();
  });

  it("prints the average in pounds", () => {
    render(
      <Harness
        initial={base({
          units: "imperial",
          weight_kg: lbToKg(170),
          target_weight_kg: lbToKg(170),
        })}
        maintain={{ averageKg: lbToKg(169.4), crossed: false }}
      />,
    );

    expect(screen.getByText(/your 7-day average is 169\.4 lb/i)).toBeInTheDocument();
  });

  it('says "past" when the week has crossed the target', () => {
    render(<Harness initial={base({})} maintain={{ averageKg: 69.2, crossed: true }} />);

    expect(screen.getByText(/you're past your target weight/i)).toBeInTheDocument();
  });

  it("switches the form to Maintain on one tap, leaving the Save to the person", async () => {
    const user = userEvent.setup();
    render(<Harness initial={base({ weight_kg: 72 })} maintain={AT_TARGET} />);

    await user.click(screen.getByRole("button", { name: /switch to maintain/i }));

    // The notice is gone because the goal is now maintain, which is the visible proof the tap
    // changed the form rather than only the notice.
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.getByRole("radio", { name: /maintain/i })).toBeChecked();
  });

  it("does not submit anything: the button sits inside the settings form", () => {
    render(<Harness initial={base({})} maintain={AT_TARGET} />);

    const button = screen.getByRole("button", { name: /switch to maintain/i });
    expect(button).toHaveAttribute("type", "button");
  });

  it("is the same rule when gaining", () => {
    const { unmount } = render(
      <Harness
        initial={base({ goal: "gain", weight_kg: 70.5, target_weight_kg: 70 })}
        maintain={{ averageKg: 70.5, crossed: false }}
      />,
    );
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    unmount();

    render(<Harness initial={base({ goal: "gain", weight_kg: 65, target_weight_kg: 70 })} />);
    expect(screen.queryByText(NOTICE)).toBeNull();
    // Gaining projects the same way: 5 kg at 0.5 kg/week is ten weeks, and 19 Nov plus 70
    // days is 28 Jan.
    expect(screen.getByText(/around 28 Jan/)).toBeInTheDocument();
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
  it("carries the route's decision into the form, average included", () => {
    render(
      <ProfileForm
        profile={profile({})}
        maintain={{ averageKg: lbToKg(166.4), crossed: false }}
        today="2026-11-19"
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(screen.getByText(/your 7-day average is 166\.4 lb/i)).toBeInTheDocument();
    expect(screen.queryByText(/within a kilogram of your current weight/i)).toBeNull();
  });

  it("never decides from the stored weight: 167.2 lb against a 165 lb target stays quiet", () => {
    // 0.998 kg apart, inside the old one-kilogram Settings check, so this screen used to say
    // "at your target" while Today's week of weigh-ins did not.
    render(
      <ProfileForm
        profile={profile({ weight_kg: lbToKg(167.2), target_weight_kg: lbToKg(165) })}
        today="2026-11-19"
        onSaved={vi.fn()}
      />,
    );

    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.queryByText(/7-day average/i)).toBeNull();
  });

  it("still refuses a target above the current weight, and the notice is not its business", async () => {
    const user = userEvent.setup();
    render(
      <ProfileForm
        profile={profile({ units: "metric", weight_kg: 77, target_weight_kg: 85 })}
        today="2026-11-19"
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
