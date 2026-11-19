/**
 * Where the export goes: the share sheet if there is one, a download if not.
 *
 * The platform is injected, because the interesting cases are the ones a desktop browser cannot
 * show: a phone that will share a zip, one that will only share CSV, one that shares nothing, and
 * a person who opens the sheet and closes it again.
 */
import { describe, expect, it, vi } from "vitest";
import { deliverExport, type ExportFile } from "./export-delivery";

const bytes = (text: string) => new TextEncoder().encode(text);

const FILES: ExportFile[] = [
  { name: "nutritrack.zip", mimeType: "application/zip", bytes: bytes("zip") },
  { name: "meals.csv", mimeType: "text/csv", bytes: bytes("meals") },
  { name: "daily-totals.csv", mimeType: "text/csv", bytes: bytes("totals") },
];

const toFile = (file: ExportFile) => new File([file.bytes], file.name, { type: file.mimeType });

describe("deliverExport", () => {
  it("shares the zip when the browser will take it", async () => {
    const share = vi.fn(async (_data: ShareData) => {});
    const canShare = vi.fn((data: ShareData) => (data.files?.length ?? 0) === 1);
    const save = vi.fn();

    const outcome = await deliverExport(FILES, { nav: { canShare, share }, save, toFile });

    expect(outcome).toBe("shared");
    expect(share).toHaveBeenCalledTimes(1);
    expect((share.mock.calls[0]?.[0] as ShareData).files?.map((file) => file.name)).toEqual([
      "nutritrack.zip",
    ]);
    expect(save).not.toHaveBeenCalled();
  });

  it("offers the two CSVs when a zip cannot be shared", async () => {
    const share = vi.fn(async (_data: ShareData) => {});
    const canShare = vi.fn((data: ShareData) => (data.files?.length ?? 0) === 2);
    const save = vi.fn();

    const outcome = await deliverExport(FILES, { nav: { canShare, share }, save, toFile });

    expect(outcome).toBe("shared");
    expect((share.mock.calls[0]?.[0] as ShareData).files?.map((file) => file.name)).toEqual([
      "meals.csv",
      "daily-totals.csv",
    ]);
    expect(save).not.toHaveBeenCalled();
  });

  it("downloads the zip when nothing can be shared", async () => {
    const save = vi.fn();

    const outcome = await deliverExport(FILES, { nav: {}, save, toFile });

    expect(outcome).toBe("downloaded");
    expect(save).toHaveBeenCalledTimes(1);
    expect((save.mock.calls[0]?.[0] as ExportFile).name).toBe("nutritrack.zip");
  });

  it("treats a closed share sheet as a decision, not a failure", async () => {
    const share = vi.fn(async () => {
      throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    });
    const save = vi.fn();

    const outcome = await deliverExport(FILES, {
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

    const outcome = await deliverExport(FILES, {
      nav: { canShare: () => true, share },
      save,
      toFile,
    });

    expect(outcome).toBe("downloaded");
    expect(save).toHaveBeenCalledTimes(1);
  });
});
