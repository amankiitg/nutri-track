/**
 * The free trial, at /try.
 *
 * Three steps and no account: email (with Turnstile), a 6-digit code, then a scan. The
 * photo is analysed in memory and the result is shown read-only, with the scans left.
 * At zero scans the visitor hits a wall that asks for an invite.
 *
 * If the Turnstile site key is missing from the build, the page says the trial is
 * unavailable rather than running a funnel whose only proof of humanity is absent.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Camera, Loader2, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BrandMark } from "@/components/app/BrandMark";
import { preparePhoto } from "@/lib/capture";
import { isPlausibleEmail, normalizeEmail } from "@/lib/admin";
import { requestInvite, type InviteResult } from "@/lib/invite-request";
import { formatFatAmount } from "@/lib/review";
import { loadTurnstile, turnstileApi, turnstileSiteKey } from "@/lib/turnstile";
import {
  clearTrial,
  getStoredTrial,
  getTrialScansLimit,
  parseTrialMeal,
  sendTrialCode,
  storeTrial,
  verifyTrialCode,
  type TrialParseResult,
  type TrialPhoto,
} from "@/lib/trial";

export const Route = createFileRoute("/try")({
  head: () => ({ meta: [{ title: "Free trial — NutriTrack" }] }),
  component: TrialPage,
});

export function TrialPage() {
  const siteKey = turnstileSiteKey();

  // The returning-visitor fast path, resolved in an effect because localStorage is not
  // readable while server-rendering.
  const [stored, setStored] = useState<{ token: string; email: string } | null>(null);
  const [step, setStep] = useState<"email" | "code" | "scan">("email");
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadyAccess, setAlreadyAccess] = useState(false);

  const [result, setResult] = useState<TrialParseResult | null>(null);
  const [scansLeft, setScansLeft] = useState<number | null>(null);
  const [scanLimit, setScanLimit] = useState<number | null>(null);
  const [limitFailed, setLimitFailed] = useState(false);
  const [text, setText] = useState("");
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null);

  const turnstileRef = useRef<HTMLDivElement>(null);
  const turnstileReady = useRef(false);

  useEffect(() => {
    const saved = getStoredTrial();
    if (saved !== null) {
      setStored(saved);
      setEmail(saved.email);
      setStep("scan");
    }
  }, []);

  // The per-mailbox scan limit, read from the server so the page never hardcodes a
  // number. Without it the funnel cannot be shown, so a failed read means unavailable.
  useEffect(() => {
    if (siteKey === null) return;
    let cancelled = false;
    void getTrialScansLimit()
      .then((limit) => {
        if (!cancelled) setScanLimit(limit);
      })
      .catch(() => {
        if (!cancelled) setLimitFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [siteKey]);

  // Render the Turnstile widget once, when the email step is showing and there is a key.
  useEffect(() => {
    if (siteKey === null || step !== "email" || turnstileReady.current) return;
    if (turnstileRef.current === null) return;

    let cancelled = false;
    void loadTurnstile()
      .then(() => {
        if (cancelled || turnstileRef.current === null) return;
        const api = turnstileApi();
        if (api === undefined) return;
        api.render(turnstileRef.current, {
          sitekey: siteKey,
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
  }, [siteKey, step, scanLimit]);

  async function submitEmail(e: FormEvent): Promise<void> {
    e.preventDefault();
    const address = normalizeEmail(email);
    setError(null);
    if (!isPlausibleEmail(address)) {
      setError("Enter an email address, like name@example.com.");
      return;
    }
    if (turnstileToken === "") {
      setError("Complete the check to continue.");
      return;
    }

    setBusy(true);
    try {
      const outcome = await sendTrialCode(address, firstName, turnstileToken);
      if (outcome.status === "already_access") {
        setEmail(outcome.email);
        setAlreadyAccess(true);
        return;
      }
      setEmail(outcome.email);
      setStep("code");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send the code.");
    } finally {
      setBusy(false);
    }
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
        storeTrial({ token: outcome.token, email });
        setStored({ token: outcome.token, email });
        setStep("scan");
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

  async function scan(input: { text: string | null; photos: TrialPhoto[] }): Promise<void> {
    if (stored === null) return;
    setError(null);
    setBusy(true);
    try {
      const outcome = await parseTrialMeal({
        token: stored.token,
        text: input.text,
        photos: input.photos,
        eatenAt: new Date(),
        mealType: null,
      });
      setResult(outcome);
      setScansLeft(outcome.scans_left);
    } catch (caught) {
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

  if (siteKey === null || limitFailed) {
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

  if (scanLimit === null) {
    return (
      <main className="paper-grain flex min-h-dvh flex-col">
        <div className="app-shell my-auto flex flex-col items-center py-10">
          <BrandMark size={40} />
          <Loader2 className="mt-8 size-6 animate-spin text-muted-foreground" aria-hidden="true" />
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
          <h1 className="text-3xl font-semibold">Free trial</h1>
          <p className="mt-2 text-muted-foreground">
            Free trial: {scanLimit} meal scans. We&apos;ll email you a 6-digit code first. Trial
            results aren&apos;t saved.
          </p>

          {alreadyAccess && (
            <div className="mt-6 rounded-xl border border-border bg-muted/40 p-4 text-sm">
              You already have access.{" "}
              <Link to="/auth" search={{ email }} className="underline">
                Sign in
              </Link>
            </div>
          )}

          {!alreadyAccess && step === "email" && (
            <form onSubmit={(e) => void submitEmail(e)} noValidate className="mt-8 space-y-4">
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

              <Button type="submit" className="h-12 w-full rounded-full text-base" disabled={busy}>
                {busy && <Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden="true" />}
                Email me a code
              </Button>
            </form>
          )}

          {!alreadyAccess && step === "code" && (
            <form onSubmit={(e) => void submitCode(e)} noValidate className="mt-8 space-y-4">
              <p className="text-sm text-muted-foreground">
                Enter the 6-digit code we emailed to <strong>{email}</strong>.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="trial-code">Code</Label>
                <Input
                  id="trial-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  className="h-11 text-center text-xl tracking-[0.3em]"
                  placeholder="123456"
                />
              </div>
              {error !== null && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" className="h-12 w-full rounded-full text-base" disabled={busy}>
                {busy && <Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden="true" />}
                Continue
              </Button>
            </form>
          )}

          {!alreadyAccess && step === "scan" && !exhausted && (
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
                            scan({ text: null, photos: [photo] }),
                          );
                        }
                      }}
                    />
                  </label>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (text.trim() !== "") void scan({ text: text.trim(), photos: [] });
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
                          {Math.round(item.calories)} kcal · {Math.round(item.protein_g)}g protein ·{" "}
                          {Math.round(item.carbs_g)}g carbs · {Math.round(item.fat_g)}g fat
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

                  <p className="text-sm font-medium">
                    Scans left: {scansLeft ?? scanLimit} of {scanLimit}
                  </p>

                  {scansLeft !== null && scansLeft <= 3 && scansLeft > 0 && (
                    <p
                      role="status"
                      className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
                    >
                      {scansLeft === 1 ? "1 scan left." : scansLeft + " scans left."} Join to keep
                      tracking.
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
          )}

          {!alreadyAccess && step === "scan" && exhausted && (
            <div className="mt-8 space-y-4 rounded-2xl border border-border bg-muted/30 p-5">
              <h2 className="text-xl font-semibold">
                You&apos;ve used your {scanLimit} free scans. Join to keep tracking.
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
                  {busy && <Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden="true" />}
                  Request an invite
                </Button>
              )}

              {inviteResult !== null && inviteResult !== "rate_limited" && (
                <p
                  role="status"
                  className="rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
                >
                  Request sent. We&apos;ll email you at <strong>{email}</strong> when you&apos;re
                  approved.
                </p>
              )}

              {inviteResult === "rate_limited" && (
                <p role="alert" className="text-sm text-destructive">
                  Couldn&apos;t send the request right now. Email invites@tracknutri.app instead.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
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
