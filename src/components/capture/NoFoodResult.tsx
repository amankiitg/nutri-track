/**
 * What the screen says when the model looked and found no food.
 *
 * The empty answer used to fall through to the review screen with nothing on it, which read as
 * the app having forgotten the photo. The photo is still there, so this sits under it and names
 * the two things worth doing next — and neither of them re-sends the same photo.
 */
import { Camera, Type } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The sentence, which differs by what was sent.
 *
 * "in this photo" is only true when there was a photo; somebody who typed "a bowl of something"
 * needs the other half of the advice.
 */
export const NO_FOOD_MESSAGES = {
  photo:
    "We couldn't find any food in this photo. Try a closer shot of your plate, or type what you ate.",
  text: "We couldn't find any food in that. Try naming the dish and roughly how much, or take a photo of your plate.",
} as const;

export type NoFoodSource = keyof typeof NO_FOOD_MESSAGES;

export function NoFoodResult({
  source,
  onRetake,
  onTypeInstead,
}: {
  /** Whether the attempt carried a photo, which decides the sentence. */
  source: NoFoodSource;
  onRetake: () => void;
  onTypeInstead: () => void;
}) {
  return (
    <div
      role="status"
      className="space-y-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3"
    >
      <p className="text-sm">{NO_FOOD_MESSAGES[source]}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" className="flex-1 rounded-full" onClick={onRetake}>
          <Camera className="mr-1.5 size-4" aria-hidden="true" />
          Retake photo
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="flex-1 rounded-full"
          onClick={onTypeInstead}
        >
          <Type className="mr-1.5 size-4" aria-hidden="true" />
          Type it instead
        </Button>
      </div>
    </div>
  );
}
