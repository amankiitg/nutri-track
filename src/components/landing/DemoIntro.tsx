import { useCallback, useEffect, useRef, useState } from "react";
import { Wordmark } from "@/components/app/BrandMark";
import {
  claimLandingGate,
  DEMO_GIF,
  DEMO_GIF_DURATION_MS,
  demoMedia,
  INTRO_START_DEADLINE_MS,
  pageClock,
} from "@/lib/intro";

/** How long the intro takes to fade out; the landing page fades in over the same time. */
export const INTRO_FADE_MS = 500;

/**
 * The landing page's opening: the vertical demo, full screen, with a Skip button.
 *
 * It ends on the video's own `ended`, on Skip, on a tap anywhere, or on Escape, and then
 * calls `onDone` once. What it plays comes from `demoMedia`: on data saver or a 3g-or-slower
 * connection the short cut alone, with no GIF; otherwise the full MP4, then the GIF. A video
 * that cannot load moves to the next; when none is left, or the browser refuses to autoplay
 * (iOS Low Power Mode refuses even a muted video), the GIF takes over where it is allowed and
 * the intro ends where it is not. A GIF loops and reports no end, so one loop's timer ends it.
 *
 * `deadline` is the page-load intro's bound: if nothing is playing 3 s after page load, the
 * intro ends and the landing page shows. Playing means the video's `playing` event, or the GIF
 * having loaded; a poster is not playing. The replay from "Watch the demo" has no deadline,
 * since the visitor asked for it and Skip is right there.
 *
 * The media box is 4:5, the demo's own shape (1080x1350), sized by height: at most 75svh
 * tall, so 60svh wide, and never wider than the screen. object-contain on a cream ground,
 * so nothing is cropped and any letterbox matches the frame.
 */
export function DemoIntro({ onDone, deadline }: { onDone: () => void; deadline: boolean }) {
  // Read once, on mount. The intro is only ever mounted in the browser, after the first paint.
  const [{ videos: sources, allowGif }] = useState(() => demoMedia());
  const [source, setSource] = useState(0);
  const [started, setStarted] = useState(false);
  // The GIF's clock starts when it has arrived, not when it was asked for: on a slow connection
  // the file takes longer to download than to play, and a timer started at the request ended
  // the intro on an empty frame.
  const [gifLoaded, setGifLoaded] = useState(false);
  const media = source < sources.length ? "mp4" : allowGif ? "gif" : "none";
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

  // Nothing left to play: every video failed and the GIF is not allowed here.
  useEffect(() => {
    if (media === "none") finish();
  }, [media, finish]);

  /**
   * The media is moving. On the page-load intro that is the moment it claims the screen; if the
   * gate already opened (the deadline passed first), the page is showing and the intro must not
   * cover it, so it ends instead.
   */
  const onStarted = useCallback(() => {
    if (doneRef.current) return;
    setStarted(true);
    if (deadline && !claimLandingGate()) finish();
  }, [deadline, finish]);

  useEffect(() => {
    if (!deadline || started) return;
    const left = Math.max(0, INTRO_START_DEADLINE_MS - pageClock.now());
    const timer = window.setTimeout(finish, left);
    return () => window.clearTimeout(timer);
  }, [deadline, started, finish]);

  useEffect(() => {
    if (media !== "mp4") return;
    const video = videoRef.current;
    if (video === null) return;
    // React sets `muted` as a property, which is what autoplay policy reads; set it again
    // before asking, and treat a refusal as "this browser will not play it".
    video.muted = true;
    const attempt = video.play() as Promise<void> | undefined;
    attempt?.catch((error: unknown) => {
      // Only a refusal to autoplay goes straight to the GIF: the next video would be refused
      // too. A file that cannot load also rejects play(), with another name, and its `error`
      // event moves on to the next source instead.
      const refused = error instanceof DOMException && error.name === "NotAllowedError";
      // Past the last video: the GIF where it is allowed, otherwise nothing, which ends it.
      if (refused && !doneRef.current) setSource(sources.length);
    });
  }, [media, videoSrc, sources.length]);

  useEffect(() => {
    if (media !== "gif" || !gifLoaded) return;
    const timer = window.setTimeout(finish, DEMO_GIF_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [media, gifLoaded, finish]);

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
            onPlaying={onStarted}
            onEnded={finish}
            onError={() => {
              if (!doneRef.current) setSource((index) => index + 1);
            }}
          />
        ) : media === "gif" ? (
          <img
            src={DEMO_GIF}
            alt="A meal photo becoming calories and macros in NutriTrack"
            className="h-full w-full object-contain"
            onLoad={() => {
              setGifLoaded(true);
              onStarted();
            }}
            onError={finish}
          />
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">Tap anywhere to continue</p>
    </div>
  );
}
