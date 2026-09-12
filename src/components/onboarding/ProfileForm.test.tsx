/**
 * The daily reminder, at the form level.
 *
 * The field is `<input type="time">` and the validator demands `HH:MM`. The database
 * column is `time without time zone`, which PostgREST serialises as `HH:MM:SS`. So the
 * thing this file pins down is the round trip: a reminder that was saved once must still
 * be a valid value when it comes back, or the form refuses to save itself and the field
 * it blames is the one the user did not touch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Profile } from "@/lib/profile";
import { saveProfileWithTargets } from "@/lib/profile";
import { ProfileForm } from "./ProfileForm";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    storage: { from: vi.fn() },
    auth: { getSession: vi.fn(), getUser: vi.fn() },
  },
}));

vi.mock("@/lib/profile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/profile")>();
  return { ...actual, saveProfileWithTargets: vi.fn().mockResolvedValue(undefined) };
});

const saved = saveProfileWithTargets as unknown as ReturnType<typeof vi.fn>;

/** `activity_level` must be the real enum value, or validation fails for the wrong reason. */
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

function renderForm(overrides: Partial<{ reminder_time: string | null }> = {}) {
  const user = userEvent.setup();
  render(<ProfileForm profile={{ ...PROFILE, ...overrides } as Profile} onSaved={vi.fn()} />);
  return user;
}

async function save(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /save changes/i }));
}

beforeEach(() => {
  saved.mockClear();
});

describe("a reminder that came back from the database", () => {
  it("reads as valid, so the field is not blamed for a value the user never typed", async () => {
    // This is exactly what supabase-js delivers for a `time` column: seconds included.
    renderForm({ reminder_time: "20:00:00" });

    expect(screen.queryByText(/Use a time like 19:30/)).toBeNull();
  });

  it("does not stop the form saving", async () => {
    const user = renderForm({ reminder_time: "20:00:00" });
    await save(user);

    expect(saved).toHaveBeenCalledTimes(1);
  });

  it("stores it in the form the column accepts", async () => {
    const user = renderForm({ reminder_time: "20:00:00" });
    await save(user);

    // `time` takes 19:30 or 19:30:00, so either is storable — but the value has to be
    // something the validator agreed to first.
    expect(saved.mock.calls[0]?.[0]?.reminder_time).toMatch(/^20:00(:00)?$/);
  });

  it("survives the round trip more than once, which is where it used to break", async () => {
    // Save it, hand the stored value back, save again. A field that only works until the
    // first reload is a field that looks broken the second time you open Settings.
    const first = render(
      <ProfileForm
        profile={{ ...PROFILE, reminder_time: "20:00:00" } as Profile}
        onSaved={vi.fn()}
      />,
    );
    await save(userEvent.setup());
    const stored = saved.mock.calls[0]?.[0]?.reminder_time as string | null;
    first.unmount();

    saved.mockClear();
    renderForm({ reminder_time: stored });
    await save(userEvent.setup());

    expect(saved).toHaveBeenCalledTimes(1);
  });
});

describe("no reminder", () => {
  it("shows an empty field and saves nothing", async () => {
    const user = renderForm({ reminder_time: null });

    expect(screen.getByLabelText("Daily reminder")).toHaveValue("");
    await save(user);

    expect(saved.mock.calls[0]?.[0]?.reminder_time).toBeNull();
  });

  it("treats blank as no reminder rather than as a bad time", async () => {
    // Optional means optional: an empty string is a value the schema allows.
    const user = renderForm({ reminder_time: null });
    await save(user);

    expect(screen.queryByText(/Use a time like 19:30/)).toBeNull();
  });
});

describe("a time the picker produced", () => {
  it("accepts what the input emits", async () => {
    const user = renderForm({ reminder_time: null });

    // What a browser hands over when a time is chosen.
    const field = screen.getByLabelText("Daily reminder");
    await user.clear(field);
    await user.type(field, "19:30");

    await save(user);
    expect(saved).toHaveBeenCalledTimes(1);
    expect(saved.mock.calls[0]?.[0]?.reminder_time).toBe("19:30");
  });
});
