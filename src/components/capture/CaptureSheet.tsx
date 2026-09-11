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
import { useQueryClient } from "@tanstack/react-query";
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
import {
  guessMealType,
  MAX_PHOTOS,
  mealFingerprint,
  type MealSource,
  type MealType,
} from "@shared/meal-parse";
import {
  buildParseRequest,
  deleteMealPhotos,
  describeParseFailure,
  isSupportedPhotoType,
  preparePhoto,
  requestParseMeal,
  toParseFailure,
  undecodablePhotoMessage,
  uploadMealPhoto,
  type PreparedPhoto,
} from "@/lib/capture";
import { findDuplicate, type DuplicateMatch } from "@/lib/duplicates";
import {
  fetchMealItems,
  fetchRecentMeals,
  findMealByPhotoHashes,
  type SavedItem,
} from "@/lib/duplicates-repo";
import {
  reviewItemFromDraft,
  reviewItemFromSaved,
  type ReviewItem,
  type ReviewMeta,
} from "@/lib/review";
import { DuplicateBanner } from "./DuplicateBanner";
import {
  dictationErrorMessage,
  isSpeechRecognitionSupported,
  startDictation,
  type Dictation,
} from "@/lib/speech";
import { supabase } from "@/integrations/supabase/client";
import { ReviewScreen } from "@/components/review/ReviewScreen";

/**
 * How long a parse runs before the sheet admits it is taking a while.
 *
 * The service allows each model call 60 s and retries once, so a slow meal can run
 * for two minutes and still be working. Without this the user sees an unchanging
 * "Analysing…" for that whole time and cannot tell a working parse from a dead one,
 * which is the same problem as a spinner that never stops.
 */
const SLOW_PARSE_MS = 8_000;

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
  /** Today's calorie target, for the review screen's remaining-calories line. */
  targetCalories: number | null;
}

export function CaptureSheet({
  open,
  onOpenChange,
  userId,
  timeZone,
  targetCalories,
}: CaptureSheetProps) {
  const [tab, setTab] = useState("photo");
  const [photos, setPhotos] = useState<SelectedPhoto[]>([]);
  const [text, setText] = useState("");
  const queryClient = useQueryClient();
  // "text" is the service's name for typed input; "type" is only this tab's id.
  const [textOrigin, setTextOrigin] = useState<"voice" | "text">("text");
  const [notes, setNotes] = useState("");
  const [eatenAt, setEatenAt] = useState(() => toLocalInputValue(new Date()));
  const [mealType, setMealType] = useState<MealType | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [isSlow, setIsSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Aborts the parse in flight, so Cancel can get the sheet back.
   *
   * Without it the only way out of a request that never answers was to close the
   * sheet, which throws away the photos the user just took.
   */
  const inFlight = useRef<AbortController | null>(null);
  /**
   * The items being reviewed, and the id of that review session.
   *
   * The id doubles as the idempotency key and as the marker that lets an explicitly
   * new meal coexist with one already logged from the same photos. Bumping it remounts
   * the review screen, which is how a re-parse or a copy replaces the items.
   */
  const [review, setReview] = useState<{
    id: string;
    meta: ReviewMeta;
    items: ReviewItem[];
  } | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateMatch | null>(null);
  const [existingItems, setExistingItems] = useState<SavedItem[] | null>(null);
  const [isReanalyzing, setIsReanalyzing] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [dictation, setDictation] = useState<Dictation | null>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);

  /**
   * Photos this capture has uploaded and not yet saved. Held in a ref as well as in
   * state because the cleanup runs from an unmount, where state would be stale.
   */
  const unsavedUploads = useRef<{ paths: string[]; hashes: string[]; fingerprint: string | null }>({
    paths: [],
    hashes: [],
    fingerprint: null,
  });

  /**
   * Deletes the photos a capture uploaded but never saved. Called by Discard, and by
   * closing the sheet: without it, every abandoned capture leaves files in the bucket
   * that nothing else will ever remove.
   */
  const discardUploads = useCallback(async () => {
    // `splice` rather than a reassignment: the upload loop pushes into this same array
    // as each photo lands, so replacing it would strand whatever arrives next in an
    // array nothing will ever clean up.
    const going = unsavedUploads.current.paths.splice(0);
    if (going.length === 0) return;
    await deleteMealPhotos(going);
  }, []);

  // A parse that is taking its time says so, rather than leaving the button unchanged
  // for two minutes. Cleared by the promise that owns the request, so it cannot outlive
  // one parse and describe the next.
  useEffect(() => {
    if (!isWorking) return;
    const timer = setTimeout(() => setIsSlow(true), SLOW_PARSE_MS);
    return () => clearTimeout(timer);
  }, [isWorking]);

  /** Reports a failure in the words the person holding the phone needs. */
  function reportFailure(caught: unknown): void {
    setError(describeParseFailure(toParseFailure(caught)));
  }

  // Navigation away from the shell unmounts this component with no chance to ask, so
  // the same cleanup runs here.
  useEffect(() => {
    return () => {
      void discardUploads();
    };
  }, [discardUploads]);

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
    setIsSlow(false);
    setReview(null);
    setDuplicate(null);
    setExistingItems(null);
    setIsReanalyzing(false);
    setTab("photo");
  }

  /** Discard, and closing the sheet with an unsaved capture: drop the photos too. */
  function abandonCapture(): void {
    void discardUploads();
    reset();
  }

  /** Abandons whatever is running. Not a failure: the user asked for it to stop. */
  function cancelInFlight(): void {
    inFlight.current?.abort();
  }

  /** The review screen's Discard: the photos go, and the sheet closes. */
  function handleDiscard(): void {
    abandonCapture();
    onOpenChange(false);
  }

  function handleOpenChange(next: boolean): void {
    // Closing on the way to a saved meal must not delete the meal's own photos, which
    // is why the paths are cleared the moment a save succeeds.
    if (!next) {
      // A parse left running behind a closed sheet would resolve into a component the
      // user is no longer looking at, and would still spend one of their sixty calls.
      cancelInFlight();
      abandonCapture();
    }
    onOpenChange(next);
  }

  function addPhotos(files: FileList | null): void {
    if (!files) return;
    const incoming = [...files];

    // Rejected when chosen rather than when submitted. A HEIC that got into the
    // selection would fail every attempt to analyse the meal, and the user would have
    // to work out that the fix is to remove one particular thumbnail. `file.type` is
    // empty on some platforms for a file the browser can still decode, so those are
    // kept and left to the decoder to refuse with the same message.
    const unreadable = incoming.find(
      (file) => file.type !== "" && !isSupportedPhotoType(file.type),
    );
    const usable = incoming.filter((file) => file.type === "" || isSupportedPhotoType(file.type));

    const room = MAX_PHOTOS - photos.length;
    const accepted = usable.slice(0, Math.max(0, room));

    if (unreadable) {
      setError(undecodablePhotoMessage(unreadable.name));
    } else if (accepted.length < usable.length) {
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

  /** Runs one parse and records the uploads it is now holding, unsaved. */
  async function parseInto(
    accessToken: string,
    uploaded: { paths: string[]; hashes: string[] },
    hint: string | null,
    reviewId: string,
    distinct: string | null = null,
    signal?: AbortSignal,
  ): Promise<void> {
    const source: MealSource = photos.length > 0 ? "photo" : textOrigin;
    const spokenOrTyped = text.trim() === "" ? null : text.trim();
    const when = new Date(eatenAt);

    const fingerprint = await computeFingerprint(uploaded.hashes, spokenOrTyped, when, distinct);

    const body = buildParseRequest({
      source,
      text: spokenOrTyped,
      photoPaths: uploaded.paths,
      eatenAt: when,
      mealType: effectiveMealType,
      hint,
    });

    const parsed = await requestParseMeal(accessToken, body, {
      ...(signal === undefined ? {} : { signal }),
    });
    unsavedUploads.current = { ...uploaded, fingerprint };
    setReview({
      id: reviewId,
      meta: { source: parsed.source, model: parsed.model, attempts: parsed.attempts },
      items: parsed.items.map((draft) => reviewItemFromDraft(draft)),
    });

    // The names are only known now, so this is the first point at which a meal can be
    // recognised by what was in it rather than by which photo was taken.
    await checkForSimilarMeal(
      parsed.items.map((item) => item.name),
      when,
    );
  }

  /**
   * The fingerprint covers the photos, the words and a ten-minute window, so the same
   * meal captured twice is recognisably the same meal and `save_meal` can answer "you
   * already logged this".
   *
   * `distinct` breaks that on purpose. It is set only where a person has been asked
   * whether this is a new meal and said yes — which is what logging a second helping
   * looks like — and it is the review session's id, so retries within one screen still
   * share a fingerprint and the idempotency key still blocks a double submit.
   */
  async function computeFingerprint(
    hashes: readonly string[],
    spokenOrTyped: string | null,
    when: Date,
    distinct: string | null,
  ): Promise<string> {
    return mealFingerprint({
      userId,
      photoHashes: hashes,
      text: spokenOrTyped,
      eatenAt: when,
      distinct,
    });
  }

  /** Loads the meal an earlier capture already logged, without calling the model. */
  async function copyExistingMeal(match: DuplicateMatch, reviewId: string): Promise<void> {
    const items = await fetchMealItems(match.meal.id);
    unsavedUploads.current = {
      paths: [...unsavedUploads.current.paths],
      hashes: [...unsavedUploads.current.hashes],
      fingerprint: await computeFingerprint(
        unsavedUploads.current.hashes,
        text.trim() === "" ? null : text.trim(),
        new Date(eatenAt),
        reviewId,
      ),
    };
    setReview({
      id: reviewId,
      meta: { source: "photo", model: null, attempts: 0 },
      items: items.map((item) => reviewItemFromSaved(item)),
    });
    setDuplicate(null);
  }

  /** The name-based check, run once the items are known. */
  async function checkForSimilarMeal(itemNames: readonly string[], when: Date): Promise<void> {
    try {
      const recent = await fetchRecentMeals(when);
      setDuplicate(findDuplicate({ itemNames, photoHashes: [] }, recent));
    } catch {
      // A failed duplicate check must never block logging a meal.
      setDuplicate(null);
    }
  }

  async function submit(options: { distinct?: string | null } = {}): Promise<void> {
    setIsWorking(true);
    setIsSlow(false);
    setError(null);
    setDuplicate(null);

    const controller = new AbortController();
    inFlight.current = controller;

    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Your session has expired. Sign in again.");

      // Resize and hash first, then upload: the hash is taken over the resized bytes
      // because those are the bytes that get sent.
      //
      // The uploads are recorded in the ref as each one lands rather than after the
      // loop. A photo that uploaded and then had a later one fail used to be invisible
      // to `discardUploads`, so it stayed in the bucket until the sweeper noticed it a
      // day later.
      unsavedUploads.current = { paths: [], hashes: [], fingerprint: null };
      for (const photo of photos) {
        const prepared: PreparedPhoto = await preparePhoto(photo.file);
        const uploaded = await uploadMealPhoto(userId, prepared);
        unsavedUploads.current.paths.push(uploaded.path);
        unsavedUploads.current.hashes.push(uploaded.sha256);
      }
      const paths = unsavedUploads.current.paths;
      const hashes = unsavedUploads.current.hashes;

      // Checked before the model is called: a matching hash means the items are
      // already on record, so the whole round trip can be skipped.
      const known = await findMealByPhotoHashes(hashes, new Date(eatenAt)).catch(() => null);
      if (known) {
        const items = await fetchMealItems(known.id).catch(() => []);
        setExistingItems(items);
        setDuplicate({ meal: known, matchedItems: 0, reason: "photo" });
        return;
      }

      await parseInto(
        token,
        { paths: [...paths], hashes: [...hashes] },
        notes.trim() === "" ? null : notes.trim(),
        crypto.randomUUID(),
        options.distinct ?? null,
        controller.signal,
      );
    } catch (caught) {
      reportFailure(caught);
    } finally {
      inFlight.current = null;
      setIsSlow(false);
      setIsWorking(false);
    }
  }

  /** Re-runs the parse on the same photos with the user's hint, replacing the items. */
  async function reanalyze(hint: string): Promise<void> {
    setIsReanalyzing(true);
    setIsSlow(false);
    setError(null);
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Your session has expired. Sign in again.");
      const { paths, hashes } = unsavedUploads.current;
      await parseInto(
        token,
        { paths: [...paths], hashes: [...hashes] },
        hint,
        crypto.randomUUID(),
        null,
        controller.signal,
      );
    } catch (caught) {
      // The hint was worth trying and it did not work; say why rather than reverting
      // to a generic line, because the reason is what decides whether a second hint is
      // worth the call.
      reportFailure(caught);
    } finally {
      inFlight.current = null;
      setIsSlow(false);
      setIsReanalyzing(false);
    }
  }

  /** The meal is stored, so its photos are the meal's now and must not be deleted. */
  function handleSaved(): void {
    unsavedUploads.current = { paths: [], hashes: [], fingerprint: null };
    reset();
    onOpenChange(false);
    // The sheet is on every authenticated screen, so the data it just changed could be
    // on screen behind it: today's totals, the timeline, the week's verdict. Everything
    // is invalidated rather than naming keys, because the sheet does not know which
    // screen it was opened from and a stale ring is worse than one extra request.
    void queryClient.invalidateQueries();
  }

  const canSubmit = photos.length > 0 || text.trim() !== "";

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
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

        {duplicate !== null && review === null && (
          <DuplicateBanner
            match={duplicate}
            existingItems={existingItems}
            busy={isWorking}
            onKeepAsNew={() => {
              // The user has been asked, so their answer has to be able to win: without
              // this marker the fingerprint would quietly refuse the second helping.
              setDuplicate(null);
              void submit({ distinct: crypto.randomUUID() });
            }}
            onCopyExisting={() => void copyExistingMeal(duplicate, crypto.randomUUID())}
          />
        )}

        {review !== null ? (
          <ReviewScreen
            key={review.id}
            meta={review.meta}
            initialItems={review.items}
            photoPaths={unsavedUploads.current.paths}
            photoHashes={unsavedUploads.current.hashes}
            photoPreviews={photos.map((photo) => photo.previewUrl)}
            transcript={text.trim() === "" ? null : text.trim()}
            inputFingerprint={unsavedUploads.current.fingerprint ?? ""}
            idempotencyKey={review.id}
            targetCalories={targetCalories}
            eatenAt={new Date(eatenAt)}
            mealType={effectiveMealType}
            notes={notes.trim() === "" ? null : notes.trim()}
            onSaved={handleSaved}
            onDiscard={handleDiscard}
            onReanalyze={reanalyze}
            isReanalyzing={isReanalyzing}
          />
        ) : (
          <>
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
                    {isSlow ? "Still analysing…" : "Analysing…"}
                  </>
                ) : (
                  "Analyse meal"
                )}
              </Button>
              {isWorking ? (
                // The way out of a request that never answers. Previously the only exit
                // was closing the sheet, which threw away the photo just taken.
                <Button
                  type="button"
                  variant="ghost"
                  className="rounded-full"
                  onClick={cancelInFlight}
                >
                  Cancel
                </Button>
              ) : (
                (photos.length > 0 || text !== "") && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="rounded-full"
                    onClick={() => abandonCapture()}
                  >
                    <RotateCcw className="mr-1.5 size-4" aria-hidden="true" />
                    Start over
                  </Button>
                )
              )}
            </div>

            {isWorking && isSlow && (
              // Said only once it is actually slow, so it is information rather than
              // reassurance: a photo usually comes back in a few seconds, and a meal
              // that needs the retry can take up to two minutes.
              <p className="mt-2 text-center text-xs text-muted-foreground">
                Taking longer than usual. A photo can take up to two minutes — keep this open, or
                tap Cancel and type what you ate instead.
              </p>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
