/**
 * The free trial, at /try. Meal first.
 *
 * The visitor starts at the meal step: snap or upload a photo, or type what they ate,
 * exactly like the app. On Analyse with no trial token the page asks for their email
 * ("Enter your email to see your results"), Turnstile runs invisibly in the background,
 * and once the 6-digit code is verified the meal they already entered is analysed for
 * them. No analysis call happens before the code is verified.
 *
 * The pending photo or text lives in sessionStorage while the email and code steps run,
 * so a visitor who leaves the tab on their phone to read the code comes back to the same
 * meal. It is cleared once the meal is handed to the parser.
 *
 * A personal link (/t/<token>) skips the email, code and Turnstile entirely. Invited
 * addresses go through the same code step as everyone else, and are told they can sign
 * in during the trial and at its end, rather than being asked to request an invite.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Camera, Loader2, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BrandMark } from "@/components/app/BrandMark";
import { TrialLinkExpired } from "@/components/trial/LinkStates";
import { NoFoodResult, type NoFoodSource } from "@/components/capture/NoFoodResult";
import { preparePhoto } from "@/lib/capture";
import { isPlausibleEmail, normalizeEmail } from "@/lib/admin";
import { requestInvite, type InviteResult } from "@/lib/invite-request";
import { formatFatAmount } from "@/lib/review";
import { loadTurnstile, turnstileApi, turnstileSiteKey } from "@/lib/turnstile";
import { SnapBox } from "@/components/capture/SnapBox";
import {
  clearPendingTrial,
  clearTrial,
  getPendingTrial,
  getStoredDeviceId,
  getStoredTrial,
  getTrialSettings,
  parseTrialMeal,
  reportPageFunnelEvent,
  savePendingTrial,
  sendTrialCode,
  startAnonymousTrial,
  storeTrial,
  TrialRequestError,
  trialRequireEmailDefault,
  verifyTrialCode,
  type PendingTrialMeal,
  type StoredTrial,
  type TrialParseResult,
  type TrialPhoto,
} from "@/lib/trial";

export const Route = createFileRoute("/try")({
  head: () => ({ meta: [{ title: "Free trial · NutriTrack" }] }),
  component: TrialPage,
});

/** A personal link (/t/<token>) that has already been verified and stored. */
export interface TrialLinkProps {
  firstName: string | null;
}

export function TrialPage({ link }: { link?: TrialLinkProps } = {}) {
  const siteKey = turnstileSiteKey();
  // A personal link has no email, code or Turnstile step, so it does not need the site key.
  const available = link !== undefined || siteKey !== null;

  // The server's /trial/settings is the truth once it answers; the build-time flag is
  // only the default before then, so a server with the email step off never flashes it.
  const [requireEmail, setRequireEmail] = useState<boolean>(trialRequireEmailDefault());
  const [stored, setStored] = useState<StoredTrial | null>(null);
  const [step, setStep] = useState<"meal" | "email" | "code">("meal");
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [invited, setInvited] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [pendingSubmit, setPendingSubmit] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkExpired, setLinkExpired] = useState(false);
  /** True when the Turnstile widget could not be created, which no tap can recover from. */
  const [turnstileFailed, setTurnstileFailed] = useState(false);

  const [result, setResult] = useState<TrialParseResult | null>(null);
  /**
   * The empty answer: the model looked and found no food. It is not an error (the request
   * succeeded) and not a result (there is nothing to review), so it is its own state — and the
   * photo it answered about stays on screen above it.
   */
  const [noFood, setNoFood] = useState<NoFoodSource | null>(null);
  /** The photo the last scan sent, so a no-food answer can show what was looked at. */
  const [scannedPhoto, setScannedPhoto] = useState<TrialPhoto | null>(null);
  /** Where "Type it instead" puts the caret, since the form is already on this screen. */
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [scansLeft, setScansLeft] = useState<number | null>(null);
  const [scanLimit, setScanLimit] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [pendingMeal, setPendingMeal] = useState<PendingTrialMeal | null>(null);
  // The meal waiting on an invisible Turnstile challenge, for the anonymous flow.
  const [pendingScan, setPendingScan] = useState<{
    text: string | null;
    photos: TrialPhoto[];
  } | null>(null);
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null);
  // The address the anonymous end screen asks for. It is the only place this flow asks.
  const [inviteEmail, setInviteEmail] = useState("");

  const turnstileRef = useRef<HTMLDivElement>(null);
  const turnstileReady = useRef(false);
  const turnstileWidgetId = useRef<string | null>(null);

  // One count per visit, and in an effect rather than during the first render: a render
  // can happen more than once (StrictMode, a re-render before paint), and the visit is one.
  const viewCounted = useRef(false);
  useEffect(() => {
    if (viewCounted.current) return;
    viewCounted.current = true;
    reportPageFunnelEvent("try_page_view");
  }, []);

  // Restore the returning visitor and any meal left mid-trial, in an effect because
  // neither localStorage nor sessionStorage is readable while server-rendering.
  useEffect(() => {
    const saved = getStoredTrial();
    if (saved !== null) {
      setStored(saved);
      setEmail(saved.email ?? "");
      setInvited(saved.invited);
      setStep("meal");
      return;
    }
    const pending = getPendingTrial();
    if (pending !== null) {
      setStep(pending.step);
      setEmail(pending.email);
      setFirstName(pending.firstName);
      setInvited(pending.invited);
      setPendingMeal(pending.meal);
    }
  }, []);

  // The scan limit and the flow flag, read in the background. The server's answer wins:
  // it is the same process that enforces the limits and the /trial/start switch.
  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    void getTrialSettings()
      .then((settings) => {
        if (cancelled) return;
        setScanLimit(settings.scansLimit);
        setRequireEmail(settings.requireEmail);
      })
      .catch(() => {
        // The wall falls back to a sentence without the number, and the build-time flag
        // keeps the page on the flow it was compiled for.
      });
    return () => {
      cancelled = true;
    };
  }, [available]);

  // Render the invisible Turnstile widget once. The email flow needs it on the email
  // step; the anonymous flow needs it on the meal step, because that is where the token
  // is issued. A personal link and a returning visitor need it not at all.
  useEffect(() => {
    if (siteKey === null || turnstileReady.current) return;
    if (link !== undefined || stored !== null) return;
    const wanted = requireEmail ? step === "email" : step === "meal";
    if (!wanted || turnstileRef.current === null) return;

    let cancelled = false;
    void loadTurnstile()
      .then(() => {
        if (cancelled || turnstileRef.current === null) return;
        const api = turnstileApi();
        if (api === undefined) return;
        try {
          turnstileWidgetId.current = api.render(turnstileRef.current, {
            sitekey: siteKey,
            // Invisible is the sitekey's mode now, not a size. Passing size: "invisible" made
            // Cloudflare's client throw a TurnstileError, so no widget was created, the id stayed
            // null and every Analyse tap stopped at "Complete the check to continue." — a dead
            // button with nothing on screen to explain it.
            //
            // appearance keeps the widget out of sight unless a challenge is actually needed;
            // execution puts the challenge on turnstile.execute(), which is what a tap does.
            appearance: "interaction-only",
            execution: "execute",
            callback: (token: string) => setTurnstileToken(token),
            "error-callback": () => setTurnstileToken(""),
            "expired-callback": () => setTurnstileToken(""),
            theme: "light",
          });
          turnstileReady.current = true;
        } catch {
          // A refused render is a page that cannot verify anybody. Remember it, so the next
          // Analyse answers with a sentence instead of pretending a check exists.
          setTurnstileFailed(true);
        }
      })
      .catch(() => {
        setTurnstileFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [siteKey, step, requireEmail, stored, link]);

  /** Step 1: ask for a code. The Turnstile token is checked server-side first. */
  const sendCode = useCallback(async () => {
    const address = normalizeEmail(email);
    setError(null);
    if (!isPlausibleEmail(address)) {
      setError("Enter an email address, like name@example.com.");
      return;
    }
    setBusy(true);
    try {
      const outcome = await sendTrialCode(address, firstName, turnstileToken);
      setEmail(outcome.email);
      setInvited(outcome.invited);
      setStep("code");
      if (pendingMeal !== null) {
        savePendingTrial({
          step: "code",
          email: outcome.email,
          firstName,
          invited: outcome.invited,
          meal: pendingMeal,
        });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send the code.");
    } finally {
      setBusy(false);
    }
  }, [email, firstName, pendingMeal, turnstileToken]);

  // When the invisible Turnstile challenge returns a token for a pending submit, proceed.
  useEffect(() => {
    if (pendingSubmit && turnstileToken !== "") {
      setPendingSubmit(false);
      void sendCode();
    }
  }, [pendingSubmit, turnstileToken, sendCode]);

  function submitEmail(e: FormEvent): void {
    e.preventDefault();
    const address = normalizeEmail(email);
    setError(null);
    if (!isPlausibleEmail(address)) {
      setError("Enter an email address, like name@example.com.");
      return;
    }
    if (turnstileToken === "") {
      const api = turnstileApi();
      const widgetId = turnstileWidgetId.current;
      if (api === undefined || widgetId === null) {
        setError(
          turnstileFailed ? TURNSTILE_UNAVAILABLE_MESSAGE : "Complete the check to continue.",
        );
        return;
      }
      setPendingSubmit(true);
      api.execute(widgetId);
      return;
    }
    void sendCode();
  }

  async function submitCode(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (code.trim() === "") {
      setError("Enter the 6-digit code.");
      return;
    }
    setBusy(true);
    try {
      const outcome = await verifyTrialCode(email, code.trim());
      if (outcome.status === "ok" && outcome.token !== undefined) {
        const ticket: StoredTrial = {
          token: outcome.token,
          email,
          invited,
          anonymous: false,
          deviceId: null,
        };
        storeTrial(ticket);
        setStored(ticket);
        const meal = pendingMeal;
        clearPendingTrial();
        setPendingMeal(null);
        setStep("meal");
        // Analyse the meal they already entered. No re-picking or retyping.
        if (meal !== null) {
          await scan(mealToInput(meal), outcome.token);
        }
        return;
      }
      if (outcome.status === "expired") {
        setError("That code has expired. Send a new one.");
        setStep("email");
        return;
      }
      if (outcome.status === "attempts_exceeded") {
        setError("Too many wrong codes. Send a new one.");
        setStep("email");
        return;
      }
      setError("That code is not right. Try again.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not check the code.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Analyse when there is a token. With none, either park the meal for the email step
   * (the flag is on) or take the anonymous path: Turnstile, then a device token, then
   * the same scan. Nothing is sent to the model until the token exists.
   */
  function beginScan(input: { text: string | null; photos: TrialPhoto[] }): void {
    // A double tap while the invisible challenge is running would start two token
    // exchanges. Neither has spent a scan yet, but the second is never wanted.
    if (busy || pendingScan !== null) return;

    // Counted here rather than in the button's handler, and after the guard above: the
    // step this measures is "asked for an analysis", so a double tap is one step, and an
    // attempt refused for being already busy was not a visit of its own.
    reportPageFunnelEvent("analyse_tapped");

    if (stored !== null) {
      void scan(input, stored.token);
      return;
    }

    if (requireEmail) {
      const meal: PendingTrialMeal =
        input.photos.length > 0
          ? { kind: "photo", photos: input.photos }
          : { kind: "text", text: input.text ?? "" };
      setPendingMeal(meal);
      savePendingTrial({ step: "email", email, firstName, invited, meal });
      setStep("email");
      return;
    }

    if (turnstileToken === "") {
      const api = turnstileApi();
      const widgetId = turnstileWidgetId.current;
      if (api === undefined || widgetId === null) {
        // "Complete the check" is only true when there is a check to complete.
        setError(
          turnstileFailed ? TURNSTILE_UNAVAILABLE_MESSAGE : "Complete the check to continue.",
        );
        return;
      }
      setError(null);
      setPendingScan(input);
      api.execute(widgetId);
      return;
    }

    setPendingScan(input);
  }

  const scan = useCallback(
    async (input: { text: string | null; photos: TrialPhoto[] }, token: string): Promise<void> => {
      setError(null);
      setBusy(true);
      try {
        const outcome = await parseTrialMeal({
          token,
          text: input.text,
          photos: input.photos,
          eatenAt: new Date(),
          mealType: null,
        });
        setScansLeft(outcome.scans_left);
        if (outcome.items.length === 0) {
          // The scan is refunded server-side, which is why scans_left above is the number
          // before this attempt. Nothing is reviewed because there is nothing to review.
          setNoFood(input.photos.length > 0 ? "photo" : "text");
          setScannedPhoto(input.photos[0] ?? null);
          setResult(null);
          return;
        }
        setNoFood(null);
        setResult(outcome);
      } catch (caught) {
        const code = caught instanceof TrialRequestError ? caught.code : null;
        if (code === "trial_exhausted") {
          // Out of scans already (say, a link reopened after the tenth): the wall, not an alert.
          setScansLeft(0);
          return;
        }
        if (code === "trial_link_expired") {
          // The device id stays in localStorage, so the anonymous flow renews the token
          // against the same scan counter rather than starting over.
          clearTrial();
          setStored(null);
          if (link !== undefined) {
            setLinkExpired(true);
          } else {
            setStep("meal");
            setError("Your trial has ended. Enter a meal to start a new one.");
          }
          return;
        }
        setError(caught instanceof Error ? caught.message : "Could not analyse that meal.");
      } finally {
        setBusy(false);
      }
    },
    [link],
  );

  /**
   * Turnstile's token, exchanged for a device token, then the meal the visitor entered.
   *
   * One turn of this issues one token and spends one scan. The Turnstile token is cleared
   * afterwards because it is single-use; a failure needs a fresh challenge, which is what
   * the next Analyse does.
   */
  const beginAnonymousScan = useCallback(
    async (
      input: { text: string | null; photos: TrialPhoto[] },
      turnstileProof: string,
    ): Promise<void> => {
      setError(null);
      setBusy(true);
      try {
        const issued = await startAnonymousTrial(turnstileProof, getStoredDeviceId());
        const ticket: StoredTrial = {
          token: issued.token,
          email: null,
          invited: false,
          anonymous: true,
          deviceId: issued.deviceId,
        };
        storeTrial(ticket);
        setStored(ticket);
        setScansLeft(issued.scansLeft);
        setTurnstileToken("");
        await scan(input, issued.token);
      } catch (caught) {
        setTurnstileToken("");
        if (caught instanceof TrialRequestError && caught.code === "email_required") {
          // The build and the server disagreed about the flag. Follow the server, and keep
          // the meal the visitor already entered.
          setRequireEmail(true);
          const meal: PendingTrialMeal =
            input.photos.length > 0
              ? { kind: "photo", photos: input.photos }
              : { kind: "text", text: input.text ?? "" };
          setPendingMeal(meal);
          savePendingTrial({ step: "email", email, firstName, invited, meal });
          setStep("email");
          return;
        }
        setError(caught instanceof Error ? caught.message : "Could not start the trial.");
      } finally {
        setBusy(false);
      }
    },
    [scan, email, firstName, invited],
  );

  // The invisible challenge answers asynchronously. The meal waits here, never at the
  // model, until the token has been exchanged for a device token.
  useEffect(() => {
    if (pendingScan === null || turnstileToken === "") return;
    const input = pendingScan;
    setPendingScan(null);
    void beginAnonymousScan(input, turnstileToken);
  }, [pendingScan, turnstileToken, beginAnonymousScan]);

  const requestInviteNow = useCallback(async () => {
    setError(null);
    setInviteResult(null);
    setBusy(true);
    try {
      const outcome = await requestInvite(email, { firstName, fromTrial: true });
      setInviteResult(outcome ?? "rate_limited");
    } finally {
      setBusy(false);
    }
  }, [email, firstName]);

  /** The anonymous end screen's form: the only place this flow asks for an address. */
  async function submitAnonymousInvite(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setInviteResult(null);
    const address = normalizeEmail(inviteEmail);
    if (!isPlausibleEmail(address)) {
      setError("Enter an email address, like name@example.com.");
      return;
    }
    setBusy(true);
    try {
      const outcome = await requestInvite(address, { fromTrial: true });
      setInviteResult(outcome ?? "rate_limited");
    } finally {
      setBusy(false);
    }
  }

  if (linkExpired) return <TrialLinkExpired />;

  if (!available) {
    return (
      <main className="paper-grain flex min-h-dvh flex-col">
        <div className="app-shell my-auto py-10">
          <BrandMark size={40} />
          <h1 className="mt-6 text-3xl font-semibold">Free trial</h1>
          <p className="mt-3 max-w-sm text-muted-foreground">Trial unavailable right now</p>
        </div>
      </main>
    );
  }

  const exhausted = scansLeft !== null && scansLeft <= 0;
  // A personal link and an email trial keep their old end screens; the anonymous one
  // asks for an address there and nowhere else.
  const anonymousTrial = stored?.anonymous === true;

  return (
    <main className="paper-grain min-h-dvh">
      <div className="app-shell flex min-h-dvh flex-col py-10">
        <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <BrandMark size={24} /> NutriTrack
        </Link>

        {/* One invisible widget for both flows. An invisible render has no size. */}
        <div ref={turnstileRef} />

        <div className="my-auto animate-rise py-10">
          {step === "meal" && !exhausted && (
            <>
              {link === undefined ? (
                <>
                  <h1 className="text-3xl font-semibold">Try a meal</h1>
                  <p className="mt-2 text-muted-foreground">
                    Snap your plate or type what you ate. Trial results aren&apos;t saved.
                  </p>
                </>
              ) : (
                <>
                  <h1 className="text-3xl font-semibold">
                    Hi {link.firstName ?? "there"}, try a meal
                  </h1>
                  <p className="mt-2 text-muted-foreground">
                    Snap your plate or type what you ate. Trial results aren&apos;t saved.
                  </p>
                </>
              )}

              <div className="mt-8 space-y-4">
                {result === null && (
                  <>
                    <SnapBox
                      onPhoto={(file) => {
                        // A new photo is a new question: the previous empty answer goes.
                        setNoFood(null);
                        setScannedPhoto(null);
                        void fileToTrialPhoto(file).then((photo) =>
                          beginScan({ text: null, photos: [photo] }),
                        );
                      }}
                    />
                    <p className="text-center text-sm text-muted-foreground">
                      Or type what you ate
                    </p>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (text.trim() !== "") beginScan({ text: text.trim(), photos: [] });
                      }}
                      className="space-y-2"
                    >
                      <Textarea
                        ref={textRef}
                        value={text}
                        onChange={(e) => {
                          setText(e.target.value);
                          setNoFood(null);
                        }}
                        rows={3}
                        placeholder="Or type what you ate, e.g. dal and two rotis"
                      />
                      <Button
                        type="submit"
                        className="w-full rounded-full"
                        disabled={busy || text.trim() === ""}
                      >
                        <Type className="mr-1.5 size-4" aria-hidden="true" />
                        Analyse
                      </Button>
                    </form>
                  </>
                )}

                {busy && (
                  <p className="text-sm text-muted-foreground">
                    <Loader2 className="mr-1.5 inline size-4 animate-spin" aria-hidden="true" />
                    Reading your meal…
                  </p>
                )}

                {error !== null && (
                  <p
                    role="alert"
                    className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm"
                  >
                    {error}
                  </p>
                )}

                {noFood !== null && (
                  <div className="space-y-3">
                    {/* Said here too, because this is the state where it matters most: the
                        number did not move, and the visitor should be able to see that. */}
                    <ScansLeftNotice scansLeft={scansLeft} />
                    {scannedPhoto !== null && (
                      <img
                        src={"data:" + scannedPhoto.mimeType + ";base64," + scannedPhoto.base64}
                        alt="The photo that was analysed"
                        className="max-h-56 w-full rounded-2xl object-cover"
                      />
                    )}
                    <NoFoodResult
                      source={noFood}
                      onRetake={() => {
                        setNoFood(null);
                        setScannedPhoto(null);
                      }}
                      onTypeInstead={() => {
                        setNoFood(null);
                        setScannedPhoto(null);
                        // The fields are on this screen anyway, so the useful half of "type it
                        // instead" is putting the caret where the typing goes.
                        textRef.current?.focus();
                      }}
                    />
                  </div>
                )}

                {result !== null && (
                  <div className="space-y-3">
                    <ul className="space-y-2">
                      {result.items.map((item, index) => (
                        <li key={index} className="rounded-2xl border border-border bg-card p-3">
                          <p className="text-sm font-medium">{item.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {Math.round(item.calories)} kcal · {Math.round(item.protein_g)}g protein
                            · {Math.round(item.carbs_g)}g carbs · {Math.round(item.fat_g)}g fat
                          </p>
                          {item.cooking_fat !== null && item.cooking_fat.type !== "none" && (
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              Assumes {formatFatAmount(item.cooking_fat.amount_tsp)}{" "}
                              {item.cooking_fat.type}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>

                    <ScansLeftNotice scansLeft={scansLeft} />

                    {invited && (
                      <p className="text-sm text-muted-foreground">
                        You&apos;re invited.{" "}
                        <Link to="/auth" search={{ email }} className="underline">
                          Sign in
                        </Link>{" "}
                        to save your meals.
                      </p>
                    )}

                    <Button
                      type="button"
                      variant="outline"
                      className="w-full rounded-full"
                      onClick={() => {
                        setResult(null);
                        setText("");
                      }}
                    >
                      Scan another meal
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}

          {step === "email" && !exhausted && (
            <>
              <h1 className="text-3xl font-semibold">Enter your email to see your results</h1>
              <p className="mt-2 text-muted-foreground">We&apos;ll email you a 6-digit code.</p>

              <form onSubmit={submitEmail} noValidate className="mt-8 space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="trial-email">Email</Label>
                  <Input
                    id="trial-email"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="h-11"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="trial-first-name">First name (optional)</Label>
                  <Input
                    id="trial-first-name"
                    type="text"
                    autoComplete="given-name"
                    maxLength={50}
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className="h-11"
                  />
                </div>

                {error !== null && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}

                <Button
                  type="submit"
                  className="h-12 w-full rounded-full text-base"
                  disabled={busy}
                >
                  {busy && <Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden="true" />}
                  Email me a code
                </Button>
              </form>
            </>
          )}

          {step === "code" && !exhausted && (
            <>
              <h1 className="text-3xl font-semibold">Enter the code</h1>
              <p className="mt-2 text-muted-foreground">
                We emailed a 6-digit code to <strong>{email}</strong>.
              </p>

              <form onSubmit={(e) => void submitCode(e)} noValidate className="mt-8 space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="trial-code">Code</Label>
                  <Input
                    id="trial-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/D/g, ""))}
                    className="h-11 text-center text-xl tracking-[0.3em]"
                    placeholder="------"
                  />
                </div>
                {error !== null && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
                <Button
                  type="submit"
                  className="h-12 w-full rounded-full text-base"
                  disabled={busy}
                >
                  {busy && <Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden="true" />}
                  Continue
                </Button>
              </form>
            </>
          )}

          {exhausted && (
            <div className="mt-8 space-y-4 rounded-2xl border border-border bg-muted/30 p-5">
              {anonymousTrial ? (
                <>
                  <h2 className="text-xl font-semibold">
                    Your trial is done. Create a free account to keep tracking.
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    An account keeps your meals and shows your day. Sign in with your email and a
                    link comes to your inbox.
                  </p>

                  {inviteResult === null && (
                    <form
                      onSubmit={(e) => void submitAnonymousInvite(e)}
                      noValidate
                      className="space-y-2"
                    >
                      <Label htmlFor="trial-invite-email">Email</Label>
                      <Input
                        id="trial-invite-email"
                        type="email"
                        inputMode="email"
                        autoComplete="email"
                        required
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                        className="h-11"
                      />
                      <Button type="submit" className="w-full rounded-full" disabled={busy}>
                        {busy && (
                          <Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden="true" />
                        )}
                        Request an invite
                      </Button>
                    </form>
                  )}

                  {inviteResult === "already_invited" && (
                    <p
                      role="status"
                      className="rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
                    >
                      That address is already invited. Sign in below to keep tracking.
                    </p>
                  )}

                  {inviteResult !== null &&
                    inviteResult !== "rate_limited" &&
                    inviteResult !== "already_invited" && (
                      <p
                        role="status"
                        className="rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
                      >
                        Request sent. We&apos;ll email you at <strong>{inviteEmail}</strong> when
                        you&apos;re approved.
                      </p>
                    )}

                  {inviteResult === "rate_limited" && (
                    <p role="alert" className="text-sm text-destructive">
                      Couldn&apos;t send the request right now. Email invites@tracknutri.app
                      instead.
                    </p>
                  )}

                  <p className="text-sm text-muted-foreground">
                    Or skip the request and{" "}
                    <Link to="/auth" className="underline">
                      create a free account
                    </Link>{" "}
                    now.
                  </p>
                </>
              ) : invited ? (
                <>
                  <h2 className="text-xl font-semibold">
                    Your trial is done. Create a free account to keep tracking.
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Continue with {email} to save your meals and see your day.
                  </p>
                  <Button asChild className="w-full rounded-full">
                    <Link to="/auth" search={{ email }}>
                      Create an account
                    </Link>
                  </Button>
                </>
              ) : (
                <>
                  <h2 className="text-xl font-semibold">
                    {scanLimit !== null
                      ? "You've used your " + scanLimit + " free scans. Join to keep tracking."
                      : "Your free scans are used up. Join to keep tracking."}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Ask for an invite and you&apos;ll be able to save your meals and see your day.
                  </p>

                  {inviteResult === null && (
                    <Button
                      type="button"
                      className="w-full rounded-full"
                      disabled={busy}
                      onClick={() => void requestInviteNow()}
                    >
                      {busy && (
                        <Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden="true" />
                      )}
                      Request an invite
                    </Button>
                  )}

                  {inviteResult === "already_invited" && (
                    <p
                      role="status"
                      className="rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
                    >
                      You&apos;re already invited.{" "}
                      <Link to="/auth" search={{ email }} className="underline">
                        Sign up with {email}
                      </Link>{" "}
                      to keep tracking.
                    </p>
                  )}

                  {inviteResult !== null &&
                    inviteResult !== "rate_limited" &&
                    inviteResult !== "already_invited" && (
                      <p
                        role="status"
                        className="rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
                      >
                        Request sent. We&apos;ll email you at <strong>{email}</strong> when
                        you&apos;re approved.
                      </p>
                    )}

                  {inviteResult === "rate_limited" && (
                    <p role="alert" className="text-sm text-destructive">
                      Couldn&apos;t send the request right now. Email invites@tracknutri.app
                      instead.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

/**
 * The near-the-end warning, in one place.
 *
 * It shows at three scans and at one, which are the two points where a number is worth an
 * interruption. Both the results screen and the no-food screen use it: the refund means a no-food
 * answer leaves this number where it was, and that is the visible half of "it did not cost you".
 */
function ScansLeftNotice({ scansLeft }: { scansLeft: number | null }) {
  if (scansLeft !== 3 && scansLeft !== 1) return null;
  return (
    <p role="status" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      {scansLeft === 1 ? "1 scan left." : scansLeft + " scans left."} Join to keep tracking.
    </p>
  );
}

/**
 * What the page says when Cloudflare's widget will not render at all.
 *
 * This is the sentence the outage needed: the tap did nothing, and "Complete the check to
 * continue" pointed at a check that was never created.
 */
export const TURNSTILE_UNAVAILABLE_MESSAGE =
  "The security check could not load. Reload the page and try again.";

function mealToInput(meal: PendingTrialMeal): { text: string | null; photos: TrialPhoto[] } {
  if (meal.kind === "photo") return { text: null, photos: meal.photos };
  return { text: meal.text, photos: [] };
}

/** Resizes a photo and returns its base64, so the bytes are small and in-memory only. */
async function fileToTrialPhoto(file: File): Promise<TrialPhoto> {
  const prepared = await preparePhoto(file);
  const bytes = new Uint8Array(await prepared.blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return { base64: btoa(binary), mimeType: "image/jpeg" };
}
