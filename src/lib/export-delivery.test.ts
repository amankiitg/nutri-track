/**
 * Where the export goes: the share sheet if there is one, a download if not.
 *
 * The platform is injected, because the interesting cases are the ones a desktop browser cannot
 * show: a phone that will share a CSV, one that will not, and a person who opens the sheet and
 * closes it again.
 */
import { describe, expect, it, vi } from "vitest";
import { deliverExport, type ExportFile } from "./export-delivery";

const FILE: ExportFile = {
  name: "meals.csv",
  mimeType: "text/csv",
  bytes: new TextEncoder().encode("date,time\n2026-11-18,18:30\n"),
};

const toFile = (file: ExportFile) => new File([file.bytes], file.name, { type: file.mimeType });

describe("deliverExport", () => {
  it("shares the file when the browser will take it", async () => {
    const share = vi.fn(async (_data: ShareData) => {});
    const save = vi.fn();

    const outcome = await deliverExport(FILE, {
      nav: { canShare: () => true, share },
      save,
      toFile,
    });

    expect(outcome).toBe("shared");
    expect(share).toHaveBeenCalledTimes(1);
    expect((share.mock.calls[0]?.[0] as ShareData).files?.map((file) => file.name)).toEqual([
      "meals.csv",
    ]);
    expect(save).not.toHaveBeenCalled();
  });

  it("downloads when nothing can be shared", async () => {
    const save = vi.fn();

    const outcome = await deliverExport(FILE, { nav: {}, save, toFile });

    expect(outcome).toBe("downloaded");
    expect(save).toHaveBeenCalledTimes(1);
    expect((save.mock.calls[0]?.[0] as ExportFile).name).toBe("meals.csv");
  });

  it("treats a closed share sheet as a decision, not a failure", async () => {
    const share = vi.fn(async () => {
      throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    });
    const save = vi.fn();

    const outcome = await deliverExport(FILE, {
      nav: { canShare: () => true, share },
      save,
      toFile,
    });

    expect(outcome).toBe("cancelled");
    expect(save).not.toHaveBeenCalled();
  });

  it("falls back to a download when sharing fails for another reason", async () => {
    const share = vi.fn(async () => {
      throw new Error("no permission");
    });
    const save = vi.fn();

    const outcome = await deliverExport(FILE, {
      nav: { canShare: () => true, share },
      save,
      toFile,
    });

    expect(outcome).toBe("downloaded");
    expect(save).toHaveBeenCalledTimes(1);
  });
});
