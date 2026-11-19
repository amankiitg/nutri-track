/**
 * Handing one exported file to the person.
 *
 * On a phone the right destination is the share sheet: it puts the file in Mail, Messages, Drive or
 * Files without this app needing any of them. Desktop browsers mostly cannot share files at all,
 * so the same call falls back to an ordinary download.
 */
export interface ExportFile {
  name: string;
  mimeType: string;
  /** The generic is explicit: a Blob will not take a Uint8Array over a SharedArrayBuffer. */
  bytes: Uint8Array<ArrayBuffer>;
}

export type DeliveryOutcome = "shared" | "downloaded" | "cancelled";

/** The parts of the platform this needs, so a test can stand in for both. */
export interface DeliveryDeps {
  nav?:
    | {
        canShare?: ((data: ShareData) => boolean) | undefined;
        share?: ((data: ShareData) => Promise<void>) | undefined;
      }
    | undefined;
  save?: ((file: ExportFile) => void) | undefined;
  toFile?: ((file: ExportFile) => File) | undefined;
}

function fileFrom(file: ExportFile): File {
  return new File([file.bytes], file.name, { type: file.mimeType });
}

function download(file: ExportFile): void {
  const url = URL.createObjectURL(new Blob([file.bytes], { type: file.mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next turn of the loop rather than immediately: Safari cancels a download whose
  // object URL is released while it is still reading it.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function deliverExport(
  file: ExportFile,
  deps: DeliveryDeps = {},
): Promise<DeliveryOutcome> {
  const nav = deps.nav ?? (typeof navigator === "undefined" ? undefined : navigator);
  const save = deps.save ?? download;
  const toFile = deps.toFile ?? fileFrom;

  const canShare = ((): boolean => {
    if (nav?.canShare === undefined || nav.share === undefined) return false;
    try {
      return nav.canShare({ files: [toFile(file)] });
    } catch {
      // canShare throws on a malformed File in some browsers instead of answering false.
      return false;
    }
  })();

  if (canShare && nav?.share !== undefined) {
    try {
      await nav.share({ files: [toFile(file)], title: "NutriTrack export" });
      return "shared";
    } catch (error) {
      // The person closed the sheet: that is a decision, not a failure to recover from.
      if ((error as { name?: string } | null)?.name === "AbortError") return "cancelled";
      // Anything else: fall through to the download rather than leaving them with nothing.
    }
  }

  save(file);
  return "downloaded";
}
