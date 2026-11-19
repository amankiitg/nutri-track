/**
 * Handing the export to the person.
 *
 * On a phone the right destination is the share sheet: it puts the file in Mail, Messages, Drive or
 * Files without this app needing any of them. Desktop browsers mostly cannot share files at all,
 * so the same call falls back to an ordinary download.
 *
 * The zip is preferred because it is one tap rather than two, but a browser that refuses to share
 * a zip (Safari on iOS historically had an allow-list of types) is offered the two CSVs instead.
 * Whatever is offered, the fallback is always a download rather than an error.
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
  files: readonly ExportFile[],
  deps: DeliveryDeps = {},
): Promise<DeliveryOutcome> {
  if (files.length === 0) return "cancelled";
  const nav = deps.nav ?? (typeof navigator === "undefined" ? undefined : navigator);
  const save = deps.save ?? download;
  const toFile = deps.toFile ?? fileFrom;

  const canShare = (candidate: readonly ExportFile[]): boolean => {
    if (nav?.canShare === undefined || nav.share === undefined || candidate.length === 0)
      return false;
    try {
      return nav.canShare({ files: candidate.map(toFile) });
    } catch {
      // canShare throws on a malformed File in some browsers instead of answering false.
      return false;
    }
  };

  const [zip, ...separate] = files;
  for (const candidate of [zip === undefined ? [] : [zip], separate]) {
    if (!canShare(candidate) || nav?.share === undefined) continue;
    try {
      await nav.share({ files: candidate.map(toFile), title: "NutriTrack export" });
      return "shared";
    } catch (error) {
      // The person closed the sheet: that is a decision, not a failure to recover from.
      if ((error as { name?: string } | null)?.name === "AbortError") return "cancelled";
      // Anything else: try the next option, and download if none is left.
    }
  }

  save(files[0]!);
  return "downloaded";
}
