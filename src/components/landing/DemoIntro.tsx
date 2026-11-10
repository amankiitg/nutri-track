import { useCallback, useEffect, useRef, useState } from "react";
import { Wordmark } from "@/components/app/BrandMark";
import { DEMO_GIF_DURATION_MS, DEMO_GIF, demoVideoSources } from "@/lib/intro";

/** How long the intro takes to fade out; the landing page fades in over the same time. */
export const INTRO_FADE_MS = 500;

/**
 * The landing page's opening: the vertical demo, full screen, with a Skip button.
 *
 * It ends on the video's own `ended`, on Skip, on a tap anywhere, or on Escape, and then
 * calls `onDone` once. The videos are tried in order: on data saver or a 3g-or-slower
 * connection the short cut first (when the build found one), then the full MP4. A video that
 * cannot load moves to the next one; when none is left, or the browser refuses to autoplay
 * (iOS Low Power Mode refuses even a muted video), the GIF takes its place, and since a GIF
 * loops and reports no end, a timer of the demo's length ends it instead.
 *
 * The media box is 4:5, the demo's own shape (1080x1350), sized by height: at most 75svh
 * tall, so 60svh wide, and never wider than the screen. object-contain on a cream ground,
 * so nothing is cropped and any letterbox matches the frame.
 */
export function DemoIntro({ onDone }: { onDone: () => void }) {
  // Read once, on mount. The intro is only ever mounted in the browser, after the first paint.
  const [sources] = useState(() => demoVideoSources());
  const [source, setSource] = useState(0);
  const media = source < sources.length ? "mp4" : "gif";
  const videoSrc = sources[source];
  const [leaving, setLeaving] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef(false);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    videoRef.current?.pause();
    setLeaving(true);
    onDone();
  }, [onDone]);

  useEffect(() => {
    skipRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (media !== "mp4") return;
    const video = videoRef.current;
    if (video === null) return;
    // React sets `muted` as a property, which is what autoplay policy reads; set it again
    // before asking, and treat a refusal as "this browser will not play it" -> the GIF.
    video.muted = true;
    const attempt = video.play() as Promise<void> | undefined;
    attempt?.catch((error: unknown) => {
      // Only a refusal to autoplay goes straight to the GIF: the next video would be refused
      // too. A file that cannot load also rejects play(), with another name, and its `error`
      // event moves on to the next source instead.
      const refused = error instanceof DOMException && error.name === "NotAllowedError";
      if (refused && !doneRef.current) setSource(sources.length);
    });
  }, [media, videoSrc, sources.length]);

  useEffect(() => {
    if (media !== "gif") return;
    const timer = window.setTimeout(finish, DEMO_GIF_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [media, finish]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") finish();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finish]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="NutriTrack demo"
      data-testid="demo-intro"
      onClick={finish}
      className={
        "paper-grain fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background px-4 py-6 transition-opacity ease-out " +
        (leaving ? "pointer-events-none opacity-0" : "opacity-100")
      }
      style={{ transitionDuration: `${INTRO_FADE_MS}ms` }}
    >
      <div className="flex w-[min(100%,60svh)] items-center justify-between">
        <Wordmark />
        <button
          ref={skipRef}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            finish();
          }}
          className="rounded-full border border-border bg-card/80 px-4 py-1.5 text-sm font-medium text-foreground shadow-sm backdrop-blur focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Skip
        </button>
      </div>

      {/* The cream is the light theme's --background, fixed so the frame matches the video's
          own ground in dark mode too. */}
      <div className="aspect-[4/5] w-[min(100%,60svh)] overflow-hidden rounded-3xl bg-[oklch(0.975_0.012_85)] shadow-[0_18px_50px_-20px_rgb(0_0_0/0.35)]">
        {media === "mp4" ? (
          <video
            key={videoSrc}
            ref={videoRef}
            src={videoSrc}
            poster="/demo/meal-demo-poster.png"
            autoPlay
            muted
            playsInline
            preload="auto"
            aria-label="A meal photo becoming calories and macros in NutriTrack"
            className="h-full w-full object-contain"
            onEnded={finish}
            onError={() => {
              if (!doneRef.current) setSource((index) => index + 1);
            }}
          />
        ) : (
          <img
            src={DEMO_GIF}
            alt="A meal photo becoming calories and macros in NutriTrack"
            className="h-full w-full object-contain"
            onError={finish}
          />
        )}
      </div>

      <p className="text-xs text-muted-foreground">Tap anywhere to continue</p>
    </div>
  );
}
