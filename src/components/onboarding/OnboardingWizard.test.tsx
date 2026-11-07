import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { OnboardingWizard } from "./OnboardingWizard";
import { saveProfileWithTargets, type ProfileInsert } from "@/lib/profile";
import {
  DEFAULT_ONBOARDING_FORM,
  saveOnboardingDraft,
  type OnboardingForm,
} from "@/lib/onboarding";
import { supabase } from "@/integrations/supabase/client";

// Mocked so we can prove that *nothing* touches the database before Confirm.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    auth: {
      getUser: vi.fn(),
      getSession: vi.fn(),
      signOut: vi.fn(),
    },
  },
}));

/** The worked example from the spec: female, 32 y, 165 cm, 70 kg, moderately active, lose 0.5 kg/week. */
const WORKED_EXAMPLE_DOB = "1994-01-01";

beforeEach(() => {
  window.sessionStorage.clear();
  vi.clearAllMocks();
});

type Confirm = (profile: ProfileInsert) => Promise<unknown>;

function renderWizard(onConfirm: Confirm = vi.fn().mockResolvedValue(undefined)) {
  const onSaved = vi.fn();
  render(<OnboardingWizard userId="user-1" onConfirm={onConfirm} onSaved={onSaved} />);
  // Every fresh start begins at the welcome; a saved draft resumes past it.
  const start = screen.queryByRole("button", { name: "Start" });
  if (start) fireEvent.click(start);
  return { onSaved };
}

function setInput(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function continueStep() {
  fireEvent.click(screen.getByRole("button", { name: /continue/i }));
}

function chooseRadio(name: RegExp) {
  fireEvent.click(screen.getByRole("radio", { name }));
}

function fillAbout(dob: string) {
  setInput(/display name/i, "Ada");
  setInput(/date of birth/i, dob);
  chooseRadio(/^female/i);
}

function fillBody(height: string, weight: string) {
  // jsdom reports en-US, so the units default is imperial. These numbers are the metric worked
  // example, so the harness selects metric rather than relying on the default.
  chooseRadio(/^metric\b/i);
  setInput(/height/i, height);
  setInput(/weight/i, weight);
}

/** Walks the wizard to the review step with the worked-example answers. */
function fillToReview() {
  fillAbout(WORKED_EXAMPLE_DOB);
  continueStep();
  fillBody("165", "70");
  continueStep();
  chooseRadio(/moderately active/i);
  continueStep();
  chooseRadio(/lose weight/i);
  setInput(/target weight/i, "65");
  continueStep();
  continueStep();
  return screen.getByRole("heading", { name: "Review" });
}

describe("the first paint", () => {
  it("is the loading state, not the draft, so the server and the client agree", () => {
    // The draft lives in sessionStorage, which a server render cannot read. Painting the resume
    // before it has been read is the hydration mismatch recorded in AGENTS.md, so the wizard draws
    // a spinner until the effect that reads it has run.
    saveOnboardingDraft({
      step: "about",
      form: { ...DEFAULT_ONBOARDING_FORM, display_name: "Ada" },
    });

    const html = renderToString(
      <OnboardingWizard userId="user-1" onConfirm={vi.fn()} onSaved={vi.fn()} />,
    );

    expect(html).toContain("Loading your answers");
    // Neither the welcome nor a question, which are the two things the first paint could have
    // claimed to know before it could know them.
    expect(html).not.toContain("A few questions");
    expect(html).not.toContain("About you");
  });

  it("reads the draft once mounted, and resumes where it was left", () => {
    saveOnboardingDraft({
      step: "body",
      form: {
        ...DEFAULT_ONBOARDING_FORM,
        display_name: "Ada",
        dob: WORKED_EXAMPLE_DOB,
        sex: "female",
      },
    });

    renderWizard();

    expect(screen.getByRole("heading", { name: "Your body" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("onboarding — age validation", () => {
  it("blocks a date of birth below the age of 13", () => {
    renderWizard();
    fillAbout("2020-01-01");
    continueStep();

    expect(
      screen.getByText("You must be between 13 and 100 to use NutriTrack."),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "About you" })).toBeInTheDocument();
  });

  it("blocks a date of birth above the age of 100", () => {
    renderWizard();
    fillAbout("1900-01-01");
    continueStep();

    expect(
      screen.getByText("You must be between 13 and 100 to use NutriTrack."),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "About you" })).toBeInTheDocument();
  });

  it("accepts an age inside the allowed range", () => {
    renderWizard();
    fillAbout(WORKED_EXAMPLE_DOB);
    continueStep();

    expect(screen.getByRole("heading", { name: "Your body" })).toBeInTheDocument();
  });
});

describe("onboarding — BMI floor", () => {
  it("blocks a target weight that implies a BMI below 18.5", () => {
    renderWizard();
    fillAbout(WORKED_EXAMPLE_DOB);
    continueStep();
    fillBody("165", "70");
    continueStep();
    continueStep();
    chooseRadio(/lose weight/i);
    // 40 kg at 165 cm is a BMI of ~14.7, well under the 18.5 floor.
    setInput(/target weight/i, "40");
    continueStep();

    expect(screen.getByText(/below a BMI of 18.5/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your goal" })).toBeInTheDocument();
  });

  it("allows a target weight above the floor", () => {
    renderWizard();
    fillAbout(WORKED_EXAMPLE_DOB);
    continueStep();
    fillBody("165", "70");
    continueStep();
    continueStep();
    chooseRadio(/lose weight/i);
    setInput(/target weight/i, "65");
    continueStep();

    expect(screen.getByRole("heading", { name: "Preferences" })).toBeInTheDocument();
  });

  it("opens on the goal step for a restored draft whose target is below the floor", () => {
    // A draft restored mid-wizard, so the goal step is never re-entered by hand. Review used to be
    // where this was caught, on Confirm; now it cannot be reached at all.
    const draftForm: OnboardingForm = {
      ...DEFAULT_ONBOARDING_FORM,
      display_name: "Ada",
      dob: WORKED_EXAMPLE_DOB,
      sex: "female",
      height_cm: 165,
      weight_kg: 70,
      goal: "lose",
      target_weight_kg: 40,
      pace_kg_per_week: 0.5,
    };
    saveOnboardingDraft({ step: "review", form: draftForm });

    renderWizard();

    expect(screen.getByRole("heading", { name: "Your goal" })).toBeInTheDocument();
    expect(screen.getByText(/below a BMI of 18.5/i)).toBeInTheDocument();
    // And there is no Confirm button to press while it stands.
    expect(screen.queryByRole("button", { name: /confirm and save/i })).not.toBeInTheDocument();
  });
});

describe("onboarding — a draft that a rule has outgrown", () => {
  /** The draft that exposed the gap: saved on Review, with a target 8 kg above the current weight. */
  const STALE_DRAFT: OnboardingForm = {
    ...DEFAULT_ONBOARDING_FORM,
    display_name: "Ada",
    dob: WORKED_EXAMPLE_DOB,
    sex: "female",
    height_cm: 170,
    weight_kg: 77,
    goal: "lose",
    target_weight_kg: 85,
    pace_kg_per_week: 0.5,
    units: "metric",
    timezone: "Europe/London",
  };

  const ABOVE =
    "Your target is above your current weight. Choose Gain weight, or lower the target.";

  it("lands on the goal step, not on Review, with the message that step would give", () => {
    saveOnboardingDraft({ step: "review", form: STALE_DRAFT });

    renderWizard();

    expect(screen.getByRole("heading", { name: "Your goal" })).toBeInTheDocument();
    expect(screen.getByText("Step 4 of 6")).toBeInTheDocument();
    expect(screen.getByText(ABOVE)).toBeInTheDocument();
    // The summary it used to show, for answers the app would refuse to save.
    expect(screen.queryByRole("heading", { name: "Review" })).not.toBeInTheDocument();
    expect(screen.queryByText(/your daily targets/i)).not.toBeInTheDocument();
  });

  it("marks the target box itself, so the message is next to the answer it is about", () => {
    saveOnboardingDraft({ step: "review", form: STALE_DRAFT });

    renderWizard();

    expect(screen.getByLabelText(/target weight/i)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/target weight/i)).toHaveValue("85");
  });

  it("leaves a sound draft where it was, which is the point of saving one", () => {
    saveOnboardingDraft({ step: "review", form: { ...STALE_DRAFT, target_weight_kg: 70 } });

    renderWizard();

    expect(screen.getByRole("heading", { name: "Review" })).toBeInTheDocument();
    expect(screen.queryByText(ABOVE)).not.toBeInTheDocument();
  });

  it("sends an older draft that never chose a sex back to the first question", () => {
    // Written before sex was a choice, so the key holds null rather than a value.
    saveOnboardingDraft({
      step: "review",
      form: { ...STALE_DRAFT, target_weight_kg: 70, sex: null },
    });

    renderWizard();

    expect(screen.getByRole("heading", { name: "About you" })).toBeInTheDocument();
    expect(screen.getByText("Please choose one.")).toBeInTheDocument();
  });
});

describe("onboarding — review screen", () => {
  it("shows the worked-example targets", () => {
    renderWizard();
    fillToReview();

    expect(screen.getByText("1,636")).toBeInTheDocument();
    expect(screen.getByText("112 g")).toBeInTheDocument();
    expect(screen.getByText("196 g")).toBeInTheDocument();
    expect(screen.getByText("45 g")).toBeInTheDocument();
  });
});

describe("onboarding — nothing is written before Confirm", () => {
  it("does not call onConfirm until Confirm is pressed", async () => {
    const onConfirm = vi.fn<Confirm>().mockResolvedValue(undefined);
    renderWizard(onConfirm);
    fillToReview();

    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /confirm and save/i }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm.mock.calls[0]?.[0]).toMatchObject({
      user_id: "user-1",
      display_name: "Ada",
      height_cm: 165,
      weight_kg: 70,
      goal: "lose",
      target_weight_kg: 65,
      pace_kg_per_week: 0.5,
    });
  });

  it("makes zero Supabase calls while walking the wizard to review", () => {
    renderWizard(saveProfileWithTargets);
    fillToReview();

    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});
