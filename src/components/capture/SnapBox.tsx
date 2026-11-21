/**
 * The one box that starts a meal: tap it, pick a photo.
 *
 * It replaces a 48px dashed pill reading "Snap or upload a photo", which on a phone read as text
 * rather than as something to press. The first action in the app is a photo of the plate, so it is
 * drawn as the biggest thing on the screen: full width, a dashed border in the brand green, a large
 * camera, and words that say what happens.
 *
 * **No `capture` attribute, deliberately.** With `capture="environment"` a phone goes straight to the
 * camera, which is one tap faster and leaves no way to pick a photo already in the library. Without
 * it, iOS and Android both show their own sheet with Take Photo and Photo Library on it, and a
 * desktop shows the file picker. One control, one input, and the choice stays with the person.
 */
import { useId, useRef } from "react";
import { Camera } from "lucide-react";

export function SnapBox({
  onPhoto,
  disabled = false,
}: {
  onPhoto: (file: File) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  function handle(element: HTMLInputElement): void {
    const file = element.files?.[0];
    // Cleared so choosing the same photo twice still fires a change.
    element.value = "";
    if (file !== undefined) onPhoto(file);
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="flex min-h-[240px] w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-primary/60 bg-primary/5 px-6 py-8 text-center transition-colors hover:border-primary hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-[220px]"
        onClick={() => input.current?.click()}
        disabled={disabled}
        aria-describedby={id + "-hint"}
      >
        <Camera className="size-12 text-primary" aria-hidden="true" />
        <span className="text-base font-semibold text-foreground">
          Tap to add a photo of your meal
        </span>
        <span id={id + "-hint"} className="text-sm text-muted-foreground">
          Take one now or pick from your photos
        </span>
      </button>

      <input
        ref={input}
        type="file"
        accept="image/*"
        className="sr-only"
        data-snap-input="photo"
        onChange={(event) => handle(event.currentTarget)}
        aria-label="Add a photo of your meal"
      />
    </div>
  );
}
