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

const MACRO_BUTTON = /macro preferences/i;
const DETAILS_BUTTON = /profile details/i;

beforeEach(() => {
  saved.mockClear();
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("the Settings form is collapsed where it should be", () => {
  it("shuts both panels by default", () => {
    render(<ProfileForm profile={PROFILE} onSaved={vi.fn()} />);

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

  it("keeps the goal and the weights open, in the order they are read", () => {
    render(<ProfileForm profile={PROFILE} onSaved={vi.fn()} />);

    expect(screen.getByRole("radio", { name: /lose weight/i })).toBeChecked();
    expect(screen.getByLabelText("Current weight")).toHaveValue("70");
    expect(screen.getByLabelText("Target weight")).toHaveValue("65");
    expect(screen.getByRole("radio", { name: /moderately active/i })).toBeChecked();
  });

  it("says what is inside each fold without opening it", () => {
    render(<ProfileForm profile={PROFILE} onSaved={vi.fn()} />);

    expect(screen.getByText("Protein 1.6 g/kg · Fat 30% · Fibre 30 g")).toBeInTheDocument();
    expect(screen.getByText("Female · 165 cm · America/New_York")).toBeInTheDocument();
  });
});

describe("a value edited inside a fold is still saved", () => {
  it("keeps the display name typed in Profile details after the panel is shut again", async () => {
    const user = userEvent.setup();
    render(<ProfileForm profile={PROFILE} onSaved={vi.fn()} />);

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

  it("keeps a protein target changed in the macro panel, and says so in the summary", async () => {
    const user = userEvent.setup();
    render(<ProfileForm profile={PROFILE} onSaved={vi.fn()} />);

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
    const first = render(<ProfileForm profile={PROFILE} onSaved={vi.fn()} />);

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
    render(<ProfileForm profile={PROFILE} onSaved={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: MACRO_BUTTON })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
  });

  it("leaves the other panel where it was", async () => {
    const user = userEvent.setup();
    render(<ProfileForm profile={PROFILE} onSaved={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: MACRO_BUTTON }));
    expect(screen.getByRole("button", { name: DETAILS_BUTTON })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});
