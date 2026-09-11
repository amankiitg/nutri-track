import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("onboarding — age validation", () => {
  it("blocks a date of birth below the age of 13", () => {
    renderWizard();
    fillAbout("2020-01-01");
    continueStep();

    expect(screen.getByText(/between 13 and 100 years old/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "About you" })).toBeInTheDocument();
  });

  it("blocks a date of birth above the age of 100", () => {
    renderWizard();
    fillAbout("1900-01-01");
    continueStep();

    expect(screen.getByText(/between 13 and 100 years old/i)).toBeInTheDocument();
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

  it("refuses to submit a below-floor target even when Confirm is pressed from review", async () => {
    // A draft restored mid-wizard, so the goal step is never re-entered by hand.
    const draftForm: OnboardingForm = {
      ...DEFAULT_ONBOARDING_FORM,
      display_name: "Ada",
      dob: WORKED_EXAMPLE_DOB,
      height_cm: 165,
      weight_kg: 70,
      goal: "lose",
      target_weight_kg: 40,
      pace_kg_per_week: 0.5,
    };
    saveOnboardingDraft({ step: "review", form: draftForm });

    const onConfirm = vi.fn<Confirm>().mockResolvedValue(undefined);
    renderWizard(onConfirm);

    fireEvent.click(screen.getByRole("button", { name: /confirm and save/i }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(await screen.findByText(/below a BMI of 18.5/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your goal" })).toBeInTheDocument();
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
