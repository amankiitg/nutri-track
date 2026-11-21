/**
 * The one box that starts a meal: tap it, the camera opens.
 *
 * It exists because the control it replaces was a 48px dashed pill reading "Snap or upload a photo",
 * which on a phone looked like a line of text with an icon and not like something to press. The
 * first action in the app is taking a photo, so it is drawn as the biggest thing on the screen: full
 * width, a dashed border in the brand green, a large camera, and words that say what happens.
 *
 * Two inputs, not one. The box carries `capture="environment"`, which on a phone opens the camera
 * directly and on a desktop is ignored (the file picker opens instead). The link underneath has no
 * capture attribute, so it opens the library on a phone, which is the only way to pick a photo that
 * was taken earlier.
 */
import { useId, useRef } from "react";
import { Camera, ImagePlus } from "lucide-react";

export function SnapBox({
  onPhoto,
  disabled = false,
}: {
  onPhoto: (file: File) => void;
  disabled?: boolean;
}) {
  const cameraInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const id = useId();

  function handle(input: HTMLInputElement): void {
    const file = input.files?.[0];
    // Cleared so choosing the same photo twice still fires a change.
    input.value = "";
    if (file !== undefined) onPhoto(file);
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="flex min-h-[240px] w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-primary/60 bg-primary/5 px-6 py-8 text-center transition-colors hover:border-primary hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-[220px]"
        onClick={() => cameraInput.current?.click()}
        disabled={disabled}
        aria-describedby={id + "-hint"}
      >
        <Camera className="size-12 text-primary" aria-hidden="true" />
        <span className="text-base font-semibold text-foreground">Tap to snap your meal</span>
        <span id={id + "-hint"} className="text-sm text-muted-foreground">
          or choose a photo from your library
        </span>
      </button>

      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        data-snap-input="camera"
        onChange={(event) => handle(event.currentTarget)}
        aria-label="Take a photo with the camera"
      />

      <label className="flex cursor-pointer items-center justify-center gap-1.5 text-sm text-muted-foreground underline">
        <ImagePlus className="size-4" aria-hidden="true" />
        Choose from photos
        <input
          ref={galleryInput}
          type="file"
          accept="image/*"
          className="sr-only"
          data-snap-input="library"
          onChange={(event) => handle(event.currentTarget)}
        />
      </label>
    </div>
  );
}
