/**
 * What the review screen says about where the numbers came from.
 *
 * The model id and the fact that it had to try twice are diagnostics. The person logging
 * lunch has no use for either and cannot act on them, so they are shown to an admin only;
 * everyone else reads the item count and nothing else.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: vi.fn(),
    auth: { getSession: vi.fn(async () => ({ data: { session: null } })) },
  },
}));

vi.mock("@/lib/duplicates-repo", () => ({
  updateMeal: vi.fn(),
}));

import { reviewItemFromExisting } from "@/lib/review";
import { ReviewScreen } from "./ReviewScreen";

const item = reviewItemFromExisting({
  id: "row-1",
  name: "Ramen",
  quantity: 1,
  unit: "bowl",
  grams: 500,
  calories: 620,
  protein_g: 28,
  carbs_g: 70,
  fat_g: 24,
  fiber_g: 4,
  sugar_g: 6,
  sodium_mg: 1800,
  confidence: 0.7,
  user_edited: false,
  llm_raw: { name: "Ramen" },
});

function renderReview(isAdmin: boolean): void {
  render(
    <ReviewScreen
      meta={{ source: "photo", model: "gemini-3.8-flash", attempts: 2 }}
      isAdmin={isAdmin}
      initialItems={[item]}
      photoPaths={["user-1/a.jpg"]}
      photoHashes={["hash-a"]}
      photoPreviews={[]}
      transcript={null}
      inputFingerprint="fp-1"
      idempotencyKey="key-1"
      targetCalories={2000}
      remainingToday={1200}
      eatenAt={new Date("2026-11-10T18:00:00Z")}
      mealType="dinner"
      notes={null}
      onSaved={vi.fn()}
      onDiscard={vi.fn()}
      onReanalyze={async () => {}}
      isReanalyzing={false}
    />,
  );
}

describe("the review screen's provenance line", () => {
  it("names the model and its retry for an admin", () => {
    renderReview(true);

    expect(screen.getByText(/^1 item · gemini-3\.8-flash · retried$/)).toBeInTheDocument();
  });

  it("shows a regular user the item count and nothing else", () => {
    renderReview(false);

    expect(screen.getByText(/^1 item$/)).toBeInTheDocument();
    expect(screen.queryByText(/gemini/)).not.toBeInTheDocument();
    expect(screen.queryByText(/retried/)).not.toBeInTheDocument();
  });
});
