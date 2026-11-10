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
import { preparePhoto } from "@/lib/capture";
import { isPlausibleEmail, normalizeEmail } from "@/lib/admin";
import { requestInvite, type InviteResult } from "@/lib/invite-request";
import { formatFatAmount } from "@/lib/review";
import { loadTurnstile, turnstileApi, turnstileSiteKey } from "@/lib/turnstile";
import {
  clearPendingTrial,
  clearTrial,
  getPendingTrial,
  getStoredTrial,
  getTrialScansLimit,
  parseTrialMeal,
  savePendingTrial,
  sendTrialCode,
  storeTrial,
  TrialRequestError,
  verifyTrialCode,
  type PendingTrialMeal,
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

  const [stored, setStored] = useState<{ token: string; email: string; invited: boolean } | null>(
    null,
  );
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

  const [result, setResult] = useState<TrialParseResult | null>(null);
  const [scansLeft, setScansLeft] = useState<number | null>(null);
  const [scanLimit, setScanLimit] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [pendingMeal, setPendingMeal] = useState<PendingTrialMeal | null>(null);
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null);

  const turnstileRef = useRef<HTMLDivElement>(null);
  const turnstileReady = useRef(false);
  const turnstileWidgetId = useRef<string | null>(null);

  // Restore the returning visitor and any meal left mid-trial, in an effect because
  // neither localStorage nor sessionStorage is readable while server-rendering.
  useEffect(() => {
    const saved = getStoredTrial();
    if (saved !== null) {
      setStored(saved);
      setEmail(saved.email);
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

  // The per-mailbox scan limit, read in the background; only the exhausted wall needs it.
  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    void getTrialScansLimit()
      .then((limit) => {
        if (!cancelled) setScanLimit(limit);
      })
      .catch(() => {
        // The wall falls back to a sentence without the number.
      });
    return () => {
      cancelled = true;
    };
  }, [available]);

  // Render the invisible Turnstile widget once, when the email step is showing.
  useEffect(() => {
    if (siteKey === null || step !== "email" || turnstileReady.current) return;
    if (turnstileRef.current === null) return;

    let cancelled = false;
    void loadTurnstile()
      .then(() => {
        if (cancelled || turnstileRef.current === null) return;
        const api = turnstileApi();
        if (api === undefined) return;
        turnstileWidgetId.current = api.render(turnstileRef.current, {
          sitekey: siteKey,
          size: "invisible",
          callback: (token: string) => setTurnstileToken(token),
          "error-callback": () => setTurnstileToken(""),
          "expired-callback": () => setTurnstileToken(""),
          theme: "light",
        });
        turnstileReady.current = true;
      })
      .catch(() => {
        // The widget is optional to render; the submit still requires a token.
      });

    return () => {
      cancelled = true;
    };
  }, [siteKey, step]);

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
        setError("Complete the check to continue.");
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
        storeTrial({ token: outcome.token, email, invited });
        setStored({ token: outcome.token, email, invited });
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

  /** Analyse when there is a token, or park the meal and ask for the email. */
  function beginScan(input: { text: string | null; photos: TrialPhoto[] }): void {
    if (stored === null) {
      const meal: PendingTrialMeal =
        input.photos.length > 0
          ? { kind: "photo", photos: input.photos }
          : { kind: "text", text: input.text ?? "" };
      setPendingMeal(meal);
      savePendingTrial({ step: "email", email, firstName, invited, meal });
      setStep("email");
      return;
    }
    void scan(input, stored.token);
  }

  async function scan(
    input: { text: string | null; photos: TrialPhoto[] },
    token: string,
  ): Promise<void> {
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
      setResult(outcome);
      setScansLeft(outcome.scans_left);
    } catch (caught) {
      const code = caught instanceof TrialRequestError ? caught.code : null;
      if (code === "trial_exhausted") {
        // Out of scans already (say, a link reopened after the tenth): the wall, not an alert.
        setScansLeft(0);
        return;
      }
      if (code === "trial_link_expired") {
        clearTrial();
        setStored(null);
        if (link !== undefined) {
          setLinkExpired(true);
        } else {
          // The code flow can simply start again: a new code issues a token for the current version.
          setStep("meal");
          setError("Your trial has ended. Enter a meal to start a new one.");
        }
        return;
      }
      setError(caught instanceof Error ? caught.message : "Could not analyse that meal.");
    } finally {
      setBusy(false);
    }
  }

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

  return (
    <main className="paper-grain min-h-dvh">
      <div className="app-shell flex min-h-dvh flex-col py-10">
        <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <BrandMark size={24} /> NutriTrack
        </Link>

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
                    <label className="flex items-center gap-2 rounded-xl border border-dashed border-border p-4 text-sm cursor-pointer">
                      <Camera className="size-5" aria-hidden="true" />
                      Snap or upload a photo
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="sr-only"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file !== undefined) {
                            void fileToTrialPhoto(file).then((photo) =>
                              beginScan({ text: null, photos: [photo] }),
                            );
                          }
                        }}
                      />
                    </label>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (text.trim() !== "") beginScan({ text: text.trim(), photos: [] });
                      }}
                      className="space-y-2"
                    >
                      <Textarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
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

                    {(scansLeft === 3 || scansLeft === 1) && (
                      <p
                        role="status"
                        className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
                      >
                        {scansLeft === 1 ? "1 scan left." : scansLeft + " scans left."} Join to keep
                        tracking.
                      </p>
                    )}

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

                <div ref={turnstileRef} />

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
              {invited ? (
                <>
                  <h2 className="text-xl font-semibold">
                    Your trial is done. Sign in to keep tracking.
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Sign in with {email} to save your meals and see your day.
                  </p>
                  <Button asChild className="w-full rounded-full">
                    <Link to="/auth" search={{ email }}>
                      Sign in
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
