/**
 * The control in Settings, driven through its choices.
 *
 * What matters on screen is the edges: an empty range for the chosen file says so instead of
 * handing over a header-only file, a refused query says why (the lesson from the fat-share save),
 * and each choice writes its own file.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { fetchMock, deliverMock, toastMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  deliverMock: vi.fn(async (_file: unknown) => "downloaded" as const),
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock("@/lib/export-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/export-data")>();
  return { ...actual, fetchExportData: fetchMock };
});
vi.mock("@/lib/export-delivery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/export-delivery")>();
  return { ...actual, deliverExport: deliverMock };
});
vi.mock("sonner", () => ({ toast: toastMock }));

import { ExportData } from "./ExportData";

const MEAL = {
  id: "m1",
  local_date: "2026-11-18",
  eaten_at: "2026-11-18T23:30:00Z",
  meal_type: "dinner",
};
const ITEM = {
  meal_id: "m1",
  name: "Porridge",
  quantity: 2,
  unit: "tbsp",
  grams: null,
  calories: 210.5,
  protein_g: 8,
  carbs_g: 30,
  fat_g: 5.5,
  fiber_g: 4,
};
const WEIGH_IN = { logged_on: "2026-11-18", weight_kg: 79.2, waist_cm: null };

function renderControl() {
  render(
    <ExportData userId="user-1" timeZone="America/New_York" units="metric" today="2026-11-19" />,
  );
  return userEvent.setup();
}

async function exportWith(user: ReturnType<typeof userEvent.setup>, what: string) {
  await user.selectOptions(screen.getByLabelText("What to export"), what);
  await user.click(screen.getByRole("button", { name: /export my data/i }));
}

function delivered() {
  return deliverMock.mock.calls.at(-1)?.[0] as { name: string; bytes: Uint8Array };
}

describe("Export my data", () => {
  it("says there is nothing to export rather than handing over a header-only file", async () => {
    fetchMock.mockResolvedValueOnce({ meals: [], items: [], weights: [] });
    const user = renderControl();

    await user.click(screen.getByRole("button", { name: /export my data/i }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith("Nothing to export", expect.anything()),
    );
    expect(deliverMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("writes the meals file by default, named for the range", async () => {
    fetchMock.mockResolvedValueOnce({ meals: [MEAL], items: [ITEM], weights: [] });
    const user = renderControl();

    await user.click(screen.getByRole("button", { name: /export my data/i }));

    await waitFor(() => expect(deliverMock).toHaveBeenCalledTimes(1));
    // The default range is the last 30 days, and the name says which days the file covers.
    expect(delivered().name).toBe("meals_2026-10-21_to_2026-11-19.csv");
    expect(new TextDecoder().decode(delivered().bytes)).toContain(
      "2026-11-18,18:30,dinner,Porridge,2 tbsp",
    );
  });

  it("writes the daily totals when that is chosen", async () => {
    fetchMock.mockResolvedValueOnce({ meals: [MEAL], items: [ITEM], weights: [] });
    const user = renderControl();

    await exportWith(user, "totals");

    await waitFor(() => expect(deliverMock).toHaveBeenCalledTimes(1));
    expect(delivered().name).toBe("daily-totals_2026-10-21_to_2026-11-19.csv");
    expect(new TextDecoder().decode(delivered().bytes)).toBe(
      "date,kcal,protein,carbs,fat,fibre\n2026-11-18,210.5,8,30,5.5,4\n",
    );
  });

  it("writes the weigh-ins when that is chosen", async () => {
    fetchMock.mockResolvedValueOnce({ meals: [], items: [], weights: [WEIGH_IN] });
    const user = renderControl();

    await exportWith(user, "weights");

    await waitFor(() => expect(deliverMock).toHaveBeenCalledTimes(1));
    expect(delivered().name).toBe("weights_2026-10-21_to_2026-11-19.csv");
    expect(new TextDecoder().decode(delivered().bytes)).toBe(
      "date,weight_kg,waist_cm\n2026-11-18,79.2,\n",
    );
    expect(toastMock).not.toHaveBeenCalledWith("Nothing to export", expect.anything());
  });

  it("says nothing to export when only the chosen file is empty", async () => {
    // Meals for the range, but no weigh-ins: Weights is the empty choice.
    fetchMock.mockResolvedValueOnce({ meals: [MEAL], items: [ITEM], weights: [] });
    const user = renderControl();

    await exportWith(user, "weights");

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith("Nothing to export", expect.anything()),
    );
    expect(toastMock).toHaveBeenCalledWith("Nothing to export", {
      description: "No weigh-ins are logged in that range.",
    });
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it("shows the database's own reason when the query is refused", async () => {
    fetchMock.mockRejectedValueOnce({
      code: "42501",
      message: "permission denied for table meals",
    });
    const user = renderControl();

    await user.click(screen.getByRole("button", { name: /export my data/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("permission denied for table meals");
    expect(alert.textContent).toContain("42501");
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it("asks for the range the picker shows", async () => {
    fetchMock.mockResolvedValue({ meals: [], items: [], weights: [] });
    const user = renderControl();

    await user.click(screen.getByRole("button", { name: /export my data/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // The default is the last 30 days: 19 Nov minus 29 is 21 Oct.
    expect(fetchMock).toHaveBeenLastCalledWith({
      userId: "user-1",
      from: "2026-10-21",
      to: "2026-11-19",
    });

    await user.selectOptions(screen.getByLabelText("Export range"), "7");
    await user.click(screen.getByRole("button", { name: /export my data/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith({
      userId: "user-1",
      from: "2026-11-13",
      to: "2026-11-19",
    });

    await user.selectOptions(screen.getByLabelText("Export range"), "all");
    await user.click(screen.getByRole("button", { name: /export my data/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenLastCalledWith({ userId: "user-1", from: null, to: "2026-11-19" });
  });
});
