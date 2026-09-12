/**
 * The numeric fields, typed one character at a time.
 *
 * `fill()` sets a whole value in a single event, which is exactly what hides this class
 * of bug: a value that only survives if it arrives complete. Someone typing 165 passes
 * through "1" and "16", and both have to sit in the box untouched while they are being
 * typed. Every test here types character by character and asserts after each keystroke.
 *
 * Each field also round-trips through a real parent holding the stored value, because
 * the thing that was broken was not the display — it was whether the keystrokes ever
 * reached the parent, and whether what the user typed was still there after they left.
 */
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Profile } from "@/lib/profile";
import { HeightField, WeightField } from "./fields";
import { ProfileForm } from "./ProfileForm";
import type { UnitSystem } from "@/lib/units";

// The form reaches the database through this client, which needs environment variables
// that are not in the repository. Mocked so nothing here depends on .env existing.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    storage: { from: vi.fn() },
    auth: { getSession: vi.fn(), getUser: vi.fn() },
  },
}));

/** The worked example, as Settings receives it. `activity_level` must be the real enum
 *  value: a plausible-looking string silently fails validation and the form never saves. */
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
} as unknown as Profile;

/** Shows the stored value next to the field, so a test can see what was committed. */
function stored(): string {
  return screen.getByTestId("stored").textContent ?? "";
}

function HeightHarness({ initialCm, units }: { initialCm: number | null; units: UnitSystem }) {
  const [cm, setCm] = useState<number | null>(initialCm);
  return (
    <>
      <HeightField valueCm={cm} units={units} onChange={setCm} />
      <p data-testid="stored">{cm === null ? "none" : String(cm)}</p>
    </>
  );
}

function WeightHarness({ initialKg, units }: { initialKg: number | null; units: UnitSystem }) {
  const [kg, setKg] = useState<number | null>(initialKg);
  return (
    <>
      <WeightField valueKg={kg} units={units} onChange={setKg} />
      <p data-testid="stored">{kg === null ? "none" : String(kg)}</p>
    </>
  );
}

/**
 * Types `text` one character at a time, asserting the box after every keystroke.
 *
 * Asserts the display and nothing else: this is the promise that a partial entry is
 * never rejected or rewritten.
 */
async function typeCharByChar(
  user: ReturnType<typeof userEvent.setup>,
  field: HTMLElement,
  text: string,
) {
  let expected = "";
  for (const character of text) {
    await user.type(field, character);
    expected += character;
    expect(field).toHaveValue(expected);
  }
}

/** Tabs out of the field, which is when a field that never committed wipes itself. */
async function leave(user: ReturnType<typeof userEvent.setup>, times = 1) {
  for (let i = 0; i < times; i += 1) await user.tab();
}

describe("height, metric", () => {
  it("keeps every partial value while 165 is typed, and stores 165", async () => {
    const user = userEvent.setup();
    render(<HeightHarness initialCm={160} units="metric" />);

    const height = screen.getByLabelText("Height");
    await user.clear(height);
    expect(stored()).toBe("none");

    await typeCharByChar(user, height, "165");
    expect(stored()).toBe("165");

    await leave(user);
    expect(height).toHaveValue("165");
    expect(stored()).toBe("165");
  });

  it("keeps a value typed into a field that started empty", async () => {
    const user = userEvent.setup();
    render(<HeightHarness initialCm={null} units="metric" />);

    const height = screen.getByLabelText("Height");
    await typeCharByChar(user, height, "172");
    await leave(user);

    expect(height).toHaveValue("172");
    expect(stored()).toBe("172");
  });

  it("does not lose the value when the field is left mid-entry", async () => {
    // "16" is a complete number, so it is committed as the user passes through it.
    const user = userEvent.setup();
    render(<HeightHarness initialCm={160} units="metric" />);

    const height = screen.getByLabelText("Height");
    await user.clear(height);
    await user.type(height, "16");
    await leave(user);

    expect(height).toHaveValue("16");
    expect(stored()).toBe("16");
  });
});

describe("height, imperial", () => {
  it("accepts feet into an empty pair, where there is nothing to combine with", async () => {
    // The case that was completely broken: a profile with no height yet, imperial, so
    // both boxes start empty. Feet cannot be combined with inches because there are
    // none, and refusing to commit is not an option.
    const user = userEvent.setup();
    render(<HeightHarness initialCm={null} units="imperial" />);

    const feet = screen.getByLabelText("Feet");
    await typeCharByChar(user, feet, "5");
    await leave(user, 2);

    expect(feet).toHaveValue("5");
    expect(stored()).toBe(String(5 * 30.48));
  });

  it("accepts inches into an empty pair", async () => {
    const user = userEvent.setup();
    render(<HeightHarness initialCm={null} units="imperial" />);

    const inches = screen.getByLabelText("Inches");
    await typeCharByChar(user, inches, "11");
    await leave(user, 2);

    expect(inches).toHaveValue("11");
    expect(stored()).toBe(String(11 * 2.54));
  });

  it("keeps the value typed into the feet box of a filled pair", async () => {
    const user = userEvent.setup();
    render(<HeightHarness initialCm={180} units="imperial" />);

    const feet = screen.getByLabelText("Feet");
    await user.clear(feet);
    await typeCharByChar(user, feet, "6");
    await leave(user, 2);

    // 6 ft 10 in: 180 cm is 5 ft 11 in, so the inches box still holds 11 while the feet
    // box says 6. What matters is that neither box was thrown away.
    expect(feet).toHaveValue("6");
    expect(stored()).toBe(String(6 * 30.48 + 11 * 2.54));
  });

  it("keeps the value typed into the inches box of a filled pair", async () => {
    const user = userEvent.setup();
    render(<HeightHarness initialCm={180} units="imperial" />);

    const inches = screen.getByLabelText("Inches");
    await user.clear(inches);
    await typeCharByChar(user, inches, "7");
    await leave(user, 2);

    expect(inches).toHaveValue("7");
    expect(stored()).toBe(String(5 * 30.48 + 7 * 2.54));
  });

  it("still accepts feet after the inches box has been emptied", async () => {
    // Clearing one box of a two-box value is ordinary, and it must not leave the other
    // box permanently unwritable. This is the exact shape of the original bug.
    const user = userEvent.setup();
    render(<HeightHarness initialCm={165} units="imperial" />);

    await user.clear(screen.getByLabelText("Inches"));
    const feet = screen.getByLabelText("Feet");
    await user.clear(feet);
    await typeCharByChar(user, feet, "6");
    await leave(user, 2);

    expect(feet).toHaveValue("6");
    expect(stored()).toBe(String(6 * 30.48));
  });

  it("combines the two boxes as feet and inches, not as a puzzle", async () => {
    const user = userEvent.setup();
    render(<HeightHarness initialCm={null} units="imperial" />);

    await typeCharByChar(user, screen.getByLabelText("Feet"), "5");
    await typeCharByChar(user, screen.getByLabelText("Inches"), "11");
    await leave(user, 2);

    expect(screen.getByLabelText("Feet")).toHaveValue("5");
    expect(screen.getByLabelText("Inches")).toHaveValue("11");
    expect(stored()).toBe(String(5 * 30.48 + 11 * 2.54));
  });

  it("does not reformat one box while the other is being typed in", async () => {
    const user = userEvent.setup();
    render(<HeightHarness initialCm={165} units="imperial" />);

    const inches = screen.getByLabelText("Inches");
    await user.clear(inches);
    await user.type(inches, "1");
    expect(inches).toHaveValue("1");

    // Focus is still inside the pair, so neither box may be resynced from the stored
    // centimetres mid-entry.
    await user.click(screen.getByLabelText("Feet"));
    expect(screen.getByLabelText("Feet")).toHaveValue("5");
    expect(inches).toHaveValue("1");
  });
});

describe("weight", () => {
  it("keeps every partial value in metric, and stores it", async () => {
    const user = userEvent.setup();
    render(<WeightHarness initialKg={70} units="metric" />);

    const weight = screen.getByLabelText("Weight");
    await user.clear(weight);
    await typeCharByChar(user, weight, "70.5");
    await leave(user);

    expect(weight).toHaveValue("70.5");
    expect(stored()).toBe("70.5");
  });

  it("keeps a trailing decimal point, which is not yet a number", async () => {
    const user = userEvent.setup();
    render(<WeightHarness initialKg={70} units="metric" />);

    const weight = screen.getByLabelText("Weight");
    await user.clear(weight);

    await user.type(weight, "7");
    await user.type(weight, "0");
    await user.type(weight, ".");
    // "70." parses to 70, so a field that round-trips through the value drops the dot
    // and the next digit lands as 705.
    expect(weight).toHaveValue("70.");

    await user.type(weight, "5");
    expect(weight).toHaveValue("70.5");
  });

  it("keeps every partial value in imperial, and stores kilograms", async () => {
    const user = userEvent.setup();
    render(<WeightHarness initialKg={70} units="imperial" />);

    const weight = screen.getByLabelText("Weight");
    await user.clear(weight);
    await typeCharByChar(user, weight, "155.5");
    await leave(user);

    expect(weight).toHaveValue("155.5");
    expect(Number(stored())).toBeCloseTo(70.53, 1);
  });
});

describe("the fields are labelled, and their ids are unique", () => {
  it("gives two weight fields two different ids", async () => {
    // Both used to render `id="weight"`, which is invalid markup and pointed the
    // "Target weight" label's htmlFor at the body weight box.
    render(
      <>
        <WeightField valueKg={70} units="metric" onChange={vi.fn()} />
        <WeightField
          id="target-weight"
          label="Target weight"
          valueKg={65}
          units="metric"
          onChange={vi.fn()}
        />
      </>,
    );

    const ids = screen.getAllByRole("textbox").map((input) => input.id);
    expect(ids).toEqual(["weight", "target-weight"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("points each label at its own input", () => {
    render(
      <>
        <WeightField valueKg={70} units="metric" onChange={vi.fn()} />
        <WeightField
          id="target-weight"
          label="Target weight"
          valueKg={65}
          units="metric"
          onChange={vi.fn()}
        />
      </>,
    );

    // getByLabelText resolves through htmlFor, so this fails if they collide.
    expect(screen.getByLabelText("Weight")).toHaveValue("70");
    expect(screen.getByLabelText("Target weight")).toHaveValue("65");
  });

  it("renders no two inputs sharing an id across the whole Settings form", () => {
    // The wiring, not just the field: the collision was in the two call sites, so this
    // is the test that would have caught it.
    render(<ProfileForm profile={PROFILE} onSaved={vi.fn()} />);

    const ids = screen
      .getAllByRole("textbox")
      .map((input) => input.id)
      .filter((id) => id !== "");
    expect(ids.length).toBeGreaterThan(3);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives the target weight label its own box on the Settings form", () => {
    render(<ProfileForm profile={PROFILE} onSaved={vi.fn()} />);

    expect(screen.getByLabelText("Weight")).toHaveValue("70");
    expect(screen.getByLabelText("Target weight")).toHaveValue("65");
  });
});
