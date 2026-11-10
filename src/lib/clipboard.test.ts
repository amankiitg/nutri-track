/**
 * Copying a link that is still on its way: the write must start inside the click (Safari), and the
 * two failures, the server's and the browser's, must come back as different errors.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyRefused, copyWhenReady } from "./clipboard";

class FakeClipboardItem {
  readonly items: Record<string, Promise<Blob>>;
  constructor(items: Record<string, Promise<Blob>>) {
    this.items = items;
  }
}

function withClipboard(clipboard: Partial<Clipboard>, item = true) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  if (item) vi.stubGlobal("ClipboardItem", FakeClipboardItem);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyWhenReady", () => {
  it("hands the clipboard a promise before the text has arrived", async () => {
    let resolveText: (value: string) => void = () => undefined;
    const text = new Promise<string>((resolve) => (resolveText = resolve));
    const write = vi.fn(async (items: FakeClipboardItem[]) => {
      await items[0]?.items["text/plain"];
    });
    withClipboard({ write } as unknown as Clipboard);

    const copied = copyWhenReady(text);
    // Called synchronously, before the server answered: this is what Safari requires.
    expect(write).toHaveBeenCalledTimes(1);

    resolveText("https://tracknutri.app/t/abc.def");
    await expect(copied).resolves.toBe("https://tracknutri.app/t/abc.def");
  });

  it("rejects with the server's error when the text never arrives", async () => {
    const write = vi.fn(async (items: FakeClipboardItem[]) => {
      await items[0]?.items["text/plain"];
    });
    withClipboard({ write } as unknown as Clipboard);

    await expect(copyWhenReady(Promise.reject(new Error("Only an admin can.")))).rejects.toThrow(
      "Only an admin can.",
    );
  });

  it("rejects with CopyRefused, carrying the text, when only the copy fails", async () => {
    withClipboard({ writeText: vi.fn(async () => Promise.reject(new Error("denied"))) }, false);

    const error = await copyWhenReady(Promise.resolve("https://tracknutri.app/t/x.y")).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CopyRefused);
    expect((error as CopyRefused).text).toBe("https://tracknutri.app/t/x.y");
  });
});
