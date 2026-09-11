/**
 * The capture sheet: photo, voice or typed text in, one parse response out.
 *
 * It stops at the response. Editing and saving belong to the review screen, so this
 * component ends in a debug panel showing exactly what came back — temporary, and
 * marked as such.
 *
 * All three tabs write into the same `text` field, so dictating and then switching to
 * Type edits what you said rather than starting again. `textOrigin` remembers where
 * it came from, because the service wants to know whether the words were spoken.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, ImagePlus, Loader2, Mic, Keyboard, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { guessMealType, MAX_PHOTOS, type MealSource, type MealType } from "@shared/meal-parse";
import {
  buildParseRequest,
  preparePhoto,
  requestParseMeal,
  uploadMealPhoto,
  type ParseResponse,
  type PreparedPhoto,
} from "@/lib/capture";
import {
  dictationErrorMessage,
  isSpeechRecognitionSupported,
  startDictation,
  type Dictation,
} from "@/lib/speech";
import { supabase } from "@/integrations/supabase/client";
import { ParseDebugPanel } from "./ParseDebugPanel";

/** One selected photo, previewed from the original before any work is done on it. */
interface SelectedPhoto {
  id: string;
  file: File;
  previewUrl: string;
}

const MEAL_TYPE_LABELS: Record<MealType, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
};

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in the device's own zone. */
function toLocalInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface CaptureSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  /** The profile's zone, so the meal type agrees with the rest of the app. */
  timeZone: string;
}

export function CaptureSheet({ open, onOpenChange, userId, timeZone }: CaptureSheetProps) {
  const [tab, setTab] = useState("photo");
  const [photos, setPhotos] = useState<SelectedPhoto[]>([]);
  const [text, setText] = useState("");
  // "text" is the service's name for typed input; "type" is only this tab's id.
  const [textOrigin, setTextOrigin] = useState<"voice" | "text">("text");
  const [notes, setNotes] = useState("");
  const [eatenAt, setEatenAt] = useState(() => toLocalInputValue(new Date()));
  const [mealType, setMealType] = useState<MealType | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ParseResponse | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [dictation, setDictation] = useState<Dictation | null>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);

  const speechSupported = useMemo(() => isSpeechRecognitionSupported(), []);

  /** The meal type the client would guess, which the user may override. */
  const guessedMealType = useMemo(
    () => guessMealType(new Date(eatenAt), timeZone),
    [eatenAt, timeZone],
  );
  const effectiveMealType = mealType ?? guessedMealType;

  const releasePhotos = useCallback((items: SelectedPhoto[]) => {
    for (const photo of items) URL.revokeObjectURL(photo.previewUrl);
  }, []);

  // Previews are object URLs, so they have to be released or the tab leaks memory.
  useEffect(() => {
    return () => {
      setPhotos((current) => {
        releasePhotos(current);
        return current;
      });
    };
  }, [releasePhotos]);

  useEffect(() => {
    if (!open && dictation) {
      dictation.stop();
      setDictation(null);
      setIsListening(false);
    }
  }, [open, dictation]);

  function reset(): void {
    releasePhotos(photos);
    setPhotos([]);
    setText("");
    setTextOrigin("text");
    setNotes("");
    setEatenAt(toLocalInputValue(new Date()));
    setMealType(null);
    setError(null);
    setResult(null);
    setTab("photo");
  }

  function addPhotos(files: FileList | null): void {
    if (!files) return;
    const room = MAX_PHOTOS - photos.length;
    const accepted = [...files].slice(0, Math.max(0, room));
    if (accepted.length < files.length) {
      setError(`Up to ${MAX_PHOTOS} photos per meal. Extra ones were ignored.`);
    } else {
      setError(null);
    }
    setPhotos((current) => [
      ...current,
      ...accepted.map((file) => ({
        id: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
      })),
    ]);
  }

  function removePhoto(id: string): void {
    setPhotos((current) => {
      const going = current.find((photo) => photo.id === id);
      if (going) URL.revokeObjectURL(going.previewUrl);
      return current.filter((photo) => photo.id !== id);
    });
  }

  function toggleDictation(): void {
    if (dictation) {
      dictation.stop();
      return;
    }
    const handle = startDictation({
      onTranscript: (transcript) => {
        setText(transcript);
        setTextOrigin("voice");
      },
      onError: (message) => {
        setError(message);
        setIsListening(false);
        setDictation(null);
      },
      onEnd: () => {
        setIsListening(false);
        setDictation(null);
      },
    });
    if (!handle) {
      setError(dictationErrorMessage("audio-capture"));
      return;
    }
    setError(null);
    setIsListening(true);
    setDictation(handle);
  }

  async function submit(): Promise<void> {
    setIsWorking(true);
    setError(null);
    setResult(null);

    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Your session has expired. Sign in again.");

      // Resize and hash first, then upload: the hash is taken over the resized bytes
      // because those are the bytes that get sent.
      const uploaded: string[] = [];
      for (const photo of photos) {
        const prepared: PreparedPhoto = await preparePhoto(photo.file);
        const { path } = await uploadMealPhoto(userId, prepared);
        uploaded.push(path);
      }

      const source: MealSource = photos.length > 0 ? "photo" : textOrigin;
      const body = buildParseRequest({
        source,
        text: text.trim() === "" ? null : text.trim(),
        photoPaths: uploaded,
        eatenAt: new Date(eatenAt),
        mealType: effectiveMealType,
        hint: notes.trim() === "" ? null : notes.trim(),
      });

      setResult(await requestParseMeal(token, body));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    } finally {
      setIsWorking(false);
    }
  }

  const canSubmit = photos.length > 0 || text.trim() !== "";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[92dvh] overflow-y-auto pb-8">
        <SheetHeader className="text-left">
          <SheetTitle>Add a meal</SheetTitle>
          <SheetDescription>
            Snap it, say it, or type it. You will get a chance to check the numbers before anything
            is saved.
          </SheetDescription>
        </SheetHeader>

        <Tabs value={tab} onValueChange={setTab} className="mt-4">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="photo">
              <Camera className="mr-1.5 size-4" aria-hidden="true" />
              Photo
            </TabsTrigger>
            <TabsTrigger value="voice">
              <Mic className="mr-1.5 size-4" aria-hidden="true" />
              Voice
            </TabsTrigger>
            <TabsTrigger value="type">
              <Keyboard className="mr-1.5 size-4" aria-hidden="true" />
              Type
            </TabsTrigger>
          </TabsList>

          <TabsContent value="photo" className="mt-4 space-y-3">
            {photos.length > 0 && (
              <ul className="grid grid-cols-3 gap-2">
                {photos.map((photo) => (
                  <li key={photo.id} className="relative">
                    <img
                      src={photo.previewUrl}
                      alt="Selected meal"
                      className="aspect-square w-full rounded-xl object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removePhoto(photo.id)}
                      aria-label="Remove this photo"
                      className="absolute -top-1.5 -right-1.5 grid size-6 place-items-center rounded-full bg-foreground text-background"
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <input
              ref={cameraInput}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(event) => addPhotos(event.target.files)}
            />
            <input
              ref={galleryInput}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => addPhotos(event.target.files)}
            />

            <div className="flex gap-2">
              <Button
                type="button"
                className="flex-1 rounded-full"
                disabled={photos.length >= MAX_PHOTOS}
                onClick={() => cameraInput.current?.click()}
              >
                <Camera className="mr-1.5 size-4" aria-hidden="true" />
                Take a photo
              </Button>
              <Button
                type="button"
                variant="outline"
                className="flex-1 rounded-full"
                disabled={photos.length >= MAX_PHOTOS}
                onClick={() => galleryInput.current?.click()}
              >
                <ImagePlus className="mr-1.5 size-4" aria-hidden="true" />
                Choose
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              Up to {MAX_PHOTOS} photos. Each one is resized to 1024 px before it is sent, which
              keeps the request small without hiding the food.
            </p>
          </TabsContent>

          <TabsContent value="voice" className="mt-4 space-y-3">
            {speechSupported ? (
              <Button
                type="button"
                variant={isListening ? "destructive" : "outline"}
                className="w-full rounded-full"
                onClick={toggleDictation}
              >
                <Mic className="mr-1.5 size-4" aria-hidden="true" />
                {isListening ? "Stop listening" : "Start dictating"}
              </Button>
            ) : (
              <p className="rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                This browser cannot listen. Type the meal in the Type tab instead — it works
                everywhere.
              </p>
            )}
            <Textarea
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setTextOrigin("voice");
              }}
              placeholder="What did you eat?"
              rows={4}
            />
            <p className="text-xs text-muted-foreground">
              {isListening ? "Listening…" : "Edit the transcript before sending it if it misheard."}
            </p>
          </TabsContent>

          <TabsContent value="type" className="mt-4 space-y-3">
            <Textarea
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setTextOrigin("text");
              }}
              placeholder="e.g. two slices of sourdough toast with butter and a flat white"
              rows={5}
            />
          </TabsContent>
        </Tabs>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <label className="space-y-1.5 text-sm">
            <span className="text-muted-foreground">Meal</span>
            <select
              value={effectiveMealType}
              onChange={(event) => setMealType(event.target.value as MealType)}
              className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"
            >
              {(Object.keys(MEAL_TYPE_LABELS) as MealType[]).map((value) => (
                <option key={value} value={value}>
                  {MEAL_TYPE_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="text-muted-foreground">Eaten at</span>
            <input
              type="datetime-local"
              value={eatenAt}
              onChange={(event) => setEatenAt(event.target.value)}
              className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"
            />
          </label>
        </div>

        <label className="mt-3 block space-y-1.5 text-sm">
          <span className="text-muted-foreground">Anything the model should know? (optional)</span>
          <input
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="e.g. the rice was a small portion"
            className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"
          />
        </label>

        {error !== null && (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm"
          >
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center gap-2">
          <Button
            type="button"
            className="flex-1 rounded-full"
            disabled={!canSubmit || isWorking}
            onClick={() => void submit()}
          >
            {isWorking ? (
              <>
                <Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden="true" />
                Analysing…
              </>
            ) : (
              "Analyse meal"
            )}
          </Button>
          {(photos.length > 0 || text !== "" || result) && (
            <Button type="button" variant="ghost" className="rounded-full" onClick={reset}>
              <RotateCcw className="mr-1.5 size-4" aria-hidden="true" />
              Start over
            </Button>
          )}
        </div>

        {result && (
          <div className="mt-5 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{MEAL_TYPE_LABELS[result.meal_type]}</Badge>
              <Badge variant="outline">{result.source}</Badge>
              <Badge variant="outline">{result.items.length} items</Badge>
              {result.attempts > 1 && <Badge variant="outline">retried once</Badge>}
            </div>
            <ParseDebugPanel result={result} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
