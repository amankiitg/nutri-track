/**
 * What the screens say and refuse, driven through the real inputs.
 *
 * The rules themselves are unit-tested in `src/lib/onboarding-choices.test.ts`. This file proves
 * the wiring: that Continue is actually stopped, that the message actually appears under the field
 * it is about, and that a box holding a rejected value keeps what was typed into it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { OnboardingWizard, ReviewProblems } from "./OnboardingWizard";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn(), getSession: vi.fn() } },
}));

const WORKED_EXAMPLE_DOB = "1994-01-01";

beforeEach(() => {
  window.sessionStorage.clear();
  vi.clearAllMocks();
});

function renderWizard() {
  render(<OnboardingWizard userId="user-1" onConfirm={vi.fn()} onSaved={vi.fn()} />);
}

function start() {
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
}

function setInput(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function chooseRadio(name: RegExp) {
  fireEvent.click(screen.getByRole("radio", { name }));
}

function continueStep() {
  fireEvent.click(screen.getByRole("button", { name: /continue/i }));
}

/** Through the welcome and the about step, on to the body step. */
function toBody() {
  renderWizard();
  start();
  setInput(/display name/i, "Ada");
  setInput(/date of birth/i, WORKED_EXAMPLE_DOB);
  chooseRadio(/^female/i);
  continueStep();
}

/** Metric body numbers for the worked example, then on to the goal step. */
function toGoal(weight = "70") {
  toBody();
  chooseRadio(/^metric\b/i);
  setInput(/height/i, "165");
  setInput(/weight/i, weight);
  continueStep();
  chooseRadio(/^moderately active/i);
  continueStep();
}

describe("the welcome", () => {
  it("says what this is and how long it takes, before asking anything", () => {
    renderWizard();

    expect(screen.getByRole("heading", { name: "NutriTrack" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "A few questions to set your daily calorie and protein targets. About a minute.",
      ),
    ).toBeInTheDocument();
    // Nothing is being asked yet, so there is no question, no progress and no Back.
    expect(screen.queryByRole("heading", { name: "About you" })).not.toBeInTheDocument();
    expect(screen.queryByText(/step 1 of/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /back/i })).not.toBeInTheDocument();
  });

  it("starts the questions when Start is pressed", () => {
    renderWizard();
    start();

    expect(screen.getByRole("heading", { name: "About you" })).toBeInTheDocument();
    expect(screen.getByText(/step 1 of/i)).toBeInTheDocument();
  });
});

describe("a choice that has not been made", () => {
  it("asks for a sex rather than having one already chosen", () => {
    renderWizard();
    start();

    expect(screen.getByRole("radio", { name: /^female/i })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /^male/i })).not.toBeChecked();

    setInput(/display name/i, "Ada");
    setInput(/date of birth/i, WORKED_EXAMPLE_DOB);
    continueStep();

    expect(screen.getByText("Please choose one.")).toBeInTheDocument();
    // Still on the same step.
    expect(screen.getByRole("heading", { name: "About you" })).toBeInTheDocument();
  });

  it("asks for a goal rather than having one already chosen", () => {
    toGoal();

    expect(screen.getByRole("radio", { name: /^lose weight/i })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /^maintain/i })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /^gain weight/i })).not.toBeChecked();

    continueStep();

    expect(screen.getByText("Please choose one.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your goal" })).toBeInTheDocument();
  });

  it("hides the target weight until a direction is chosen", () => {
    // A box for the target asks a question only a chosen goal can answer.
    toGoal();
    expect(screen.queryByLabelText(/target weight/i)).not.toBeInTheDocument();

    chooseRadio(/^lose weight/i);
    expect(screen.getByLabelText(/target weight/i)).toBeInTheDocument();
  });
});

describe("a target on the wrong side of the current weight", () => {
  it("stops a losing goal with a target above the current weight", () => {
    toGoal("70");
    chooseRadio(/^lose weight/i);
    setInput(/target weight/i, "75");
    continueStep();

    expect(
      screen.getByText(
        "Your target is above your current weight. Choose Gain weight, or lower the target.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your goal" })).toBeInTheDocument();
  });

  it("stops a gaining goal with a target below the current weight", () => {
    toGoal("70");
    chooseRadio(/^gain weight/i);
    setInput(/target weight/i, "65");
    continueStep();

    expect(
      screen.getByText(
        "Your target is below your current weight. Choose Lose weight, or raise the target.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your goal" })).toBeInTheDocument();
  });

  it("points at Maintain when the target is the weight they already are", () => {
    toGoal("70");
    chooseRadio(/^lose weight/i);
    setInput(/target weight/i, "70");
    continueStep();

    expect(
      screen.getByText(
        "Your target is your current weight. Choose Maintain to stay where you are.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your goal" })).toBeInTheDocument();
  });

  it("moves on once the target is on the right side", () => {
    toGoal("70");
    chooseRadio(/^lose weight/i);
    setInput(/target weight/i, "75");
    continueStep();
    setInput(/target weight/i, "65");
    continueStep();

    expect(screen.getByRole("heading", { name: "Preferences" })).toBeInTheDocument();
  });

  it("checks the direction after the unit conversion, not the digits", () => {
    // 154 lb is 69.9 kg, so a lose target of 160 lb is 72.6 kg: above it, in kg, even though the
    // digits are smaller than each other in neither direction a person could read off the keyboard.
    toBody();
    chooseRadio(/^imperial\b/i);
    setInput(/feet/i, "5");
    setInput(/inches/i, "5");
    setInput(/^weight/i, "154");
    continueStep();
    chooseRadio(/^moderately active/i);
    continueStep();

    chooseRadio(/^lose weight/i);
    setInput(/target weight/i, "160");
    continueStep();

    expect(
      screen.getByText(
        "Your target is above your current weight. Choose Gain weight, or lower the target.",
      ),
    ).toBeInTheDocument();
  });
});

describe("the inches box", () => {
  it("refuses a number above eleven and says why", () => {
    toBody();
    chooseRadio(/^imperial\b/i);
    setInput(/feet/i, "5");
    setInput(/inches/i, "12");

    expect(screen.getByText("Inches must be 0 to 11.")).toBeInTheDocument();
    continueStep();
    expect(screen.getByRole("heading", { name: "Your body" })).toBeInTheDocument();
  });

  it("keeps the rejected digits on screen, because they are what went wrong", () => {
    toBody();
    chooseRadio(/^imperial\b/i);
    setInput(/feet/i, "5");
    setInput(/inches/i, "13");
    fireEvent.blur(screen.getByLabelText(/inches/i));

    expect(screen.getByLabelText(/inches/i)).toHaveValue("13");
    expect(screen.getByText("Inches must be 0 to 11.")).toBeInTheDocument();
  });

  it("accepts eleven, which is a real number of inches", () => {
    toBody();
    chooseRadio(/^imperial\b/i);
    setInput(/feet/i, "5");
    setInput(/inches/i, "11");
    setInput(/^weight/i, "154");

    expect(screen.queryByText("Inches must be 0 to 11.")).not.toBeInTheDocument();
    continueStep();
    expect(screen.getByRole("heading", { name: "Activity level" })).toBeInTheDocument();
  });

  it("clears the message once the box is corrected", () => {
    toBody();
    chooseRadio(/^imperial\b/i);
    setInput(/feet/i, "5");
    setInput(/inches/i, "12");
    setInput(/inches/i, "10");

    expect(screen.queryByText("Inches must be 0 to 11.")).not.toBeInTheDocument();
  });
});

describe("the units a new profile starts on", () => {
  it("starts imperial on an en-US device and says so in the boxes", () => {
    // jsdom reports navigator.language as en-US, which is the device signal the rule uses.
    toBody();

    expect(screen.getByRole("radio", { name: /^imperial/i })).toBeChecked();
    expect(screen.getByLabelText(/feet/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/inches/i)).toBeInTheDocument();
  });

  it("obeys the choice over the default once one is made", () => {
    toBody();
    chooseRadio(/^metric\b/i);

    expect(screen.getByRole("radio", { name: /^metric/i })).toBeChecked();
    expect(screen.getByLabelText(/height/i)).toHaveValue("");
  });
});

describe("the review step", () => {
  it("explains the calorie number in one line", () => {
    toGoal("70");
    chooseRadio(/^lose weight/i);
    setInput(/target weight/i, "65");
    continueStep();
    continueStep();

    // The arithmetic, in the units on screen: maintenance minus the daily cost of the pace.
    expect(
      screen.getByText(/^Maintenance ≈ [\d,]+ kcal − [\d,]+ kcal for 0\.5 kg\/week$/),
    ).toBeInTheDocument();
  });

  it("says there is no adjustment when the goal is maintain", () => {
    toGoal("70");
    chooseRadio(/^maintain/i);
    continueStep();
    continueStep();

    expect(
      screen.getByText(/^Maintenance ≈ [\d,]+ kcal, with no adjustment\.$/),
    ).toBeInTheDocument();
  });

  it("has nothing to refuse when every answer holds", () => {
    toGoal("70");
    chooseRadio(/^lose weight/i);
    setInput(/target weight/i, "65");
    continueStep();
    continueStep();

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your daily targets" })).toBeInTheDocument();
  });
});

describe("Review refusing to summarise", () => {
  /**
   * The banner is a guard rather than a route: a form that fails is now redirected to its own step
   * on load, so nothing reaches Review while it fails. It is tested directly because it is exactly
   * what would have to keep working if that redirect ever missed a case.
   */
  it("states the problem in the words of the step that can fix it", () => {
    render(
      <ReviewProblems
        step="goal"
        message="Your target is above your current weight. Choose Gain weight, or lower the target."
        onEdit={vi.fn()}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "Your target is above your current weight. Choose Gain weight, or lower the target.",
    );
    expect(screen.getByRole("button", { name: "Edit Your goal" })).toBeInTheDocument();
  });

  it("sends the person to that step, not to the first field on this screen", () => {
    const onEdit = vi.fn();
    render(<ReviewProblems step="body" message="That weight looks too low." onEdit={onEdit} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit Your body" }));

    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});
