/**
 * The shape of the Settings form: what is open, what is folded, what the folds say, and whether
 * a value edited inside one survives being folded again.
 *
 * These are the four things that go wrong with a collapsed form. A panel that opens when it should
 * not; a summary that stops matching the numbers inside it; a save that drops a value because the
 * field was hidden when it ran; and a fold that forgets itself on the next page load. The field
 * logic itself is `fields.test.tsx` and the maths is `targets.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Profile } from "@/lib/profile";
import { lbToKg } from "@/lib/units";
import { ProfileForm } from "./ProfileForm";

// The form reaches the database through this client, which needs environment variables that are
// not in the repository.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

// The save itself is not what this file is about: it is mocked so the test can read what the form
// would have written. Everything else in the module (formFromProfile, saveFailureDetail) stays real.
const { saved } = vi.hoisted(() => ({ saved: vi.fn(async (_profile: unknown) => ({})) }));
vi.mock("@/lib/profile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/profile")>();
  return { ...actual, saveProfileWithTargets: saved };
});

/** Settings as it receives the row: a complete profile, so a save passes validation. */
const PROFILE = {
  user_id: "user-1",
  display_name: "Aman",
  dob: "1994-01-01",
  sex: "female",
  height_cm: 165,
  weight_kg: 70,
  target_weight_kg: 65,
  activity_level: "moderately_active",
  goal: "lose",
  pace_kg_per_week: 0.5,
  units: "metric",
  dietary_tags: [],
  timezone: "America/New_York",
  reminder_time: null,
  protein_g_per_kg: 1.6,
  fat_share: 0.3,
  fiber_target_g: 30,
  created_at: "2026-03-01T00:00:00Z",
  updated_at: "2026-03-01T00:00:00Z",
} as unknown as Profile;

/** The same row in the other unit system: imperial, 5 ft 9 in. */
const IMPERIAL_PROFILE = {
  ...PROFILE,
  sex: "male",
  height_cm: 175,
  units: "imperial",
} as unknown as Profile;

/** Maintain has no target to arrive at, which is the case the line has to disappear for. */
const MAINTAIN_PROFILE = {
  ...PROFILE,
  goal: "maintain",
  target_weight_kg: null,
} as unknown as Profile;

/** An imperial profile chasing 165 lb from a 170 lb week. */
const IMPERIAL_GOAL_PROFILE = {
  ...IMPERIAL_PROFILE,
  target_weight_kg: Number(lbToKg(165).toFixed(2)),
} as unknown as Profile;

const GOAL_BUTTON = /^Goal /;
const MACRO_BUTTON = /macro preferences/i;
const DETAILS_BUTTON = /profile details/i;

/** Opens the goal fold, which every form starts with shut. */
async function openGoal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: GOAL_BUTTON }));
}

beforeEach(() => {
  saved.mockClear();
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("the Settings form is collapsed where it should be", () => {
  it("shuts every panel by default", () => {
    render(<ProfileForm profile={PROFILE} onSaved={vi.fn()} today="2026-11-19" />);

    expect(screen.getByRole("button", { name: GOAL_BUTTON })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: MACRO_BUTTON })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: DETAILS_BUTTON })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    // Shut means not reachable: neither the sliders nor the body details are in the tree a
    // screen reader walks until the panel is opened.
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByRole("textbox", { name: /display name/i })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: /height/i })).toBeNull();
  });

  it("holds the goal, the weights, the pace and the activity in that one fold", async () => {
    const user = userEvent.setup();
    render(<ProfileForm profile={PROFILE} onSaved={vi.fn()} today="2026-11-19" />);
    await openGoal(user);

    expect(screen.getByRole("radio", { name: /lose weight/i })).toBeChecked();
    expect(screen.getByLabelText("Current weight")).toHaveValue("70");
    expect(screen.getByLabelText("Target weight")).toHaveValue("65");
    expect(screen.getByRole("radio", { name: /moderately active/i })).toBeChecked();
  });

  it("summarises the goal in kilograms while it is shut", () => {
    // 70 kg to 65 kg at 0.5 kg/week, with the week's 66 kg average: one kg away is two weeks.
    render(<ProfileForm profile={PROFILE} averageKg={66} onSaved={vi.fn()} today="2026-11-19" />);

    expect(screen.getByText("Lose · 70 → 65 kg · 0.5 kg/week · reach ~3 Dec")).toBeInTheDocument();
  });

  it("summarises it in pounds for an imperial profile", () => {
    render(
      <ProfileForm
        profile={IMPERIAL_GOAL_PROFILE}
        averageKg={Number(lbToKg(170).toFixed(2))}
        today="2026-11-19"
        onSaved={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/^Lose · [\d.]+ → 165 lb · 1\.1 lb\/week · reach ~21 Dec$/),
    ).toBeInTheDocument();
  });

  it("says what is inside each fold without opening it", () => {
    render(<ProfileForm profile={PROFILE} onSaved={vi.fn()} today="2026-11-19" />);

    expect(screen.getByText("Protein 1.6 g/kg · Fat 30% · Fibre 30 g")).toBeInTheDocument();
    expect(screen.getByText("Female · 165 cm · America/New_York")).toBeInTheDocument();
  });

  it("remembers the goal fold like the other two", async () => {
    const user = userEvent.setup();
    const first = render(<ProfileForm profile={PROFILE} onSaved={vi.fn()} today="2026-11-19" />);

    await openGoal(user);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: GOAL_BUTTON })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
    expect(
      JSON.parse(window.localStorage.getItem("nutritrack.admin.sections") ?? "{}"),
    ).toMatchObject({
      "settings-goal": true,
    });
    first.unmount();

    render(<ProfileForm profile={PROFILE} onSaved={vi.fn()} today="2026-11-19" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: GOAL_BUTTON })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
  });

  it("uses feet and inches for an imperial profile, in the height field’s own format", () => {
    // 175 cm is 68.9 inches, which rounds to 5 ft 9 in.
    render(<ProfileForm profile={IMPERIAL_PROFILE} onSaved={vi.fn()} today="2026-11-19" />);

    expect(screen.getByText("Male · 5′ 9″ · America/New_York")).toBeInTheDocument();
  });

  it("follows a unit change made inside the shut panel", async () => {
    const user = userEvent.setup();
    render(<ProfileForm profile={PROFILE} onSaved={vi.fn()} today="2026-11-19" />);

    expect(screen.getByText("Female · 165 cm · America/New_York")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: DETAILS_BUTTON }));
    await user.click(screen.getByRole("radio", { name: /imperial/i }));
    await user.click(screen.getByRole("button", { name: DETAILS_BUTTON }));

    // 165 cm is 64.96 inches: 5 ft 5 in once the field rounds it, which is what the field shows.
    expect(screen.getByText("Female · 5′ 5″ · America/New_York")).toBeInTheDocument();
  });
});

describe("a value edited inside a fold is still saved", () => {
  it("keeps the display name typed in Profile details after the panel is shut again", async () => {
    const user = userEvent.setup();
    render(<ProfileForm profile={PROFILE} onSaved={vi.fn()} today="2026-11-19" />);

    await user.click(screen.getByRole("button", { name: DETAILS_BUTTON }));
    const name = screen.getByLabelText("Display name");
    await user.clear(name);
    await user.type(name, "Aman K");
    // Shut it again before saving: the fields stay mounted behind the hidden panel, which is
    // what keeps this value, and a form that unmounts them would send the old one.
    await user.click(screen.getByRole("button", { name: DETAILS_BUTTON }));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    const payload = saved.mock.calls[0]?.[0] as { display_name: string };
    expect(payload.display_name).toBe("Aman K");
  });

  it("keeps a current weight typed in the goal panel after it is shut again", async () => {
    const user = userEvent.setup();
    render(<ProfileForm profile={PROFILE} onSaved={vi.fn()} today="2026-11-19" />);
    await openGoal(user);

    const weight = screen.getByLabelText("Current weight");
    await user.clear(weight);
    await user.type(weight, "68");
    await user.tab();
    await openGoal(user);

    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    expect((saved.mock.calls[0]?.[0] as { weight_kg: number }).weight_kg).toBe(68);
  });

  it("keeps a protein target changed in the macro panel, and says so in the summary", async () => {
    const user = userEvent.setup();
    render(<ProfileForm profile={PROFILE} onSaved={vi.fn()} today="2026-11-19" />);

    await user.click(screen.getByRole("button", { name: MACRO_BUTTON }));
    const protein = screen.getByRole("slider", {
      name: /protein grams per kilogram/i,
    });
    protein.focus();
    await user.keyboard("{ArrowRight}");
    await user.click(screen.getByRole("button", { name: MACRO_BUTTON }));

    // The summary reads the form, so it moves with the value even while the panel is shut.
    expect(screen.getByText("Protein 1.7 g/kg · Fat 30% · Fibre 30 g")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    const payload = saved.mock.calls[0]?.[0] as { protein_g_per_kg: number };
    expect(payload.protein_g_per_kg).toBeCloseTo(1.7, 5);
  });
});

describe("the folds are remembered", () => {
  it("stores the open state and restores it on the next mount", async () => {
    const user = userEvent.setup();
    const first = render(<ProfileForm profile={PROFILE} onSaved={vi.fn()} today="2026-11-19" />);

    await user.click(screen.getByRole("button", { name: MACRO_BUTTON }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: MACRO_BUTTON })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
    expect(
      JSON.parse(window.localStorage.getItem("nutritrack.admin.sections") ?? "{}"),
    ).toMatchObject({
      "settings-macros": true,
    });
    first.unmount();

    // A fresh mount reads it back in an effect, so the panel is shut for one frame and then open.
    render(<ProfileForm profile={PROFILE} onSaved={vi.fn()} today="2026-11-19" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: MACRO_BUTTON })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
  });

  it("leaves the other panel where it was", async () => {
    const user = userEvent.setup();
    render(<ProfileForm profile={PROFILE} onSaved={vi.fn()} today="2026-11-19" />);

    await user.click(screen.getByRole("button", { name: MACRO_BUTTON }));
    expect(screen.getByRole("button", { name: DETAILS_BUTTON })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});

/**
 * The line under the pace options.
 *
 * It is projected from the trailing 7-day average, not from the weight typed in the field above:
 * one reading is noise, and the same average decides the reached-target notice.
 */
describe("the arrival date under the pace options", () => {
  const today = "2026-11-19";

  it("dates the target from the average, even when the typed weight disagrees", () => {
    // The form says 70 kg; the week says 66. The line follows the week.
    render(<ProfileForm profile={PROFILE} averageKg={66} today={today} onSaved={vi.fn()} />);

    expect(
      screen.getByText("You'll reach 65.0 kg around 3 Dec at 0.5 kg/week."),
    ).toBeInTheDocument();
  });

  it("moves when the pace changes, before anything is saved", async () => {
    const user = userEvent.setup();
    render(<ProfileForm profile={PROFILE} averageKg={66} today={today} onSaved={vi.fn()} />);
    await openGoal(user);

    await user.click(screen.getByRole("radio", { name: /0\.25 kg\/week/i }));

    // 1 kg at 0.5 kg/week is two weeks; at 0.25 it is four, so 19 Nov becomes 17 Dec.
    expect(screen.getByText(/around 17 Dec/)).toBeInTheDocument();
    expect(screen.queryByText(/around 3 Dec/)).toBeNull();
  });

  it("says the target has been reached rather than dating it", () => {
    render(<ProfileForm profile={PROFILE} averageKg={65.2} today={today} onSaved={vi.fn()} />);

    expect(screen.getByText("You're at your target.")).toBeInTheDocument();
    // No date beside it: a day to arrive contradicts having arrived.
    expect(screen.queryByText(/around \d/)).toBeNull();
  });

  it("has no line on maintain, where there is nowhere to arrive", () => {
    render(
      <ProfileForm profile={MAINTAIN_PROFILE} averageKg={66} today={today} onSaved={vi.fn()} />,
    );

    expect(screen.queryByText(/you'll reach/i)).toBeNull();
    expect(screen.queryByText(/at your target/i)).toBeNull();
  });

  it("says it in pounds for an imperial profile", () => {
    render(
      <ProfileForm
        profile={IMPERIAL_GOAL_PROFILE}
        averageKg={Number(lbToKg(170).toFixed(2))}
        today={today}
        onSaved={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/You'll reach 165\.0 lb around 21 Dec at 1\.1 lb\/week\./),
    ).toBeInTheDocument();
  });
});
