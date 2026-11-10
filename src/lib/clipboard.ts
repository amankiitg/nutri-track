/**
 * Copies text that is still on its way from the server.
 *
 * Safari only lets a page write to the clipboard during the click that asked for it, and a link
 * that needs a server round trip arrives after that moment has passed: awaiting it and then
 * calling writeText is refused. A ClipboardItem can be handed a promise instead, inside the click,
 * and the browser fills it when the promise settles. Where ClipboardItem is missing, the text is
 * awaited and written the plain way, which Chromium and Firefox allow.
 *
 * Resolves with the text once it is on the clipboard. Rejects with the server's own error when
 * the text never arrived, and with a CopyRefused (carrying the text) when only the copy failed,
 * so the caller can still show the link.
 */
export class CopyRefused extends Error {
  readonly text: string;
  constructor(text: string) {
    super("The browser did not allow copying.");
    this.name = "CopyRefused";
    this.text = text;
  }
}

export async function copyWhenReady(text: Promise<string>): Promise<string> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  const canWriteItem =
    clipboard !== undefined &&
    typeof clipboard.write === "function" &&
    typeof ClipboardItem !== "undefined";

  // Started synchronously, still inside the click.
  const written = canWriteItem
    ? clipboard.write([
        new ClipboardItem({
          "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })),
        }),
      ])
    : null;
  // When the server fails, the write fails with it; that rejection is reported through `text`
  // below, so this one must not surface as unhandled.
  written?.catch(() => undefined);

  // The server's failure comes first: it is the one worth reading.
  const value = await text;

  try {
    if (written !== null) await written;
    else if (clipboard !== undefined) await clipboard.writeText(value);
    else throw new Error("no clipboard");
  } catch {
    throw new CopyRefused(value);
  }
  return value;
}
