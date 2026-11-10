/**
 * Setting a new password, reached from the link in the reset email.
 *
 * The link comes back to `/auth/reset` with the recovery tokens in the URL fragment. supabase-js
 * reads them on load and the page therefore has a session by the time this mounts; there is no
 * token handling here, which is the point of `redirectTo` being this route.
 *
 * Three states, and keeping the first two apart is the point. Opening this page without following a
 * link says so and offers a way to ask for one. A link that arrived and was rejected — an expired
 * fragment, or a recovery session that died while the form was open — gets the expired sentence,
 * because that is what happened. Everything else is the form.
 *
 * A Google-only account that finishes this gets a password on the same account rather than a
 * second one. That is deliberate: the address is the identity, and somebody who joined with
 * Google and later wants a password should not end up with two rows and two histories.
 */
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { BrandMark } from "@/components/app/BrandMark";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { authErrorText, friendlyAuthError } from "@/lib/auth-errors";

/** Said for a link that was present and is no longer usable. */
export const EXPIRED_LINK = "That link has expired. Request a new one.";

/**
 * Said when there was no link in the first place.
 *
 * Telling somebody their link expired when they simply opened the page is a small lie that sends
 * them looking for an email they never asked for. The two are one state apart and the screen can
 * tell them apart, so it does.
 */
export const NO_LINK = "This page needs a reset link from your email.";

/** The same minimum the create-account form uses, so the two cannot disagree. */
const MIN_PASSWORD = 8;

export const Route = createFileRoute("/auth_/reset")({
  head: () => ({
    meta: [
      { title: "Set a new password · NutriTrack" },
      { name: "description", content: "Choose a new password for your NutriTrack account." },
    ],
  }),
  component: ResetPasswordPage,
});

/**
 * The reason Supabase put in the URL, when the recovery link could not be exchanged.
 *
 * The SDK removes the fragment when it finds a token in it, so whatever is left is a failure
 * rather than a session.
 */
function linkFailure(): string | null {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return hash.get("error_description") ?? hash.get("error");
}

/**
 * Whether a failure means the link is gone rather than the password being wrong.
 *
 * Matched on words because supabase-js reports a missing recovery session as an
 * `AuthSessionMissingError` with the message "Auth session missing!", and an unusable token as an
 * expired or invalid JWT. Both are the same thing to the person holding the link.
 */
function isDeadLink(caught: unknown): boolean {
  const text = authErrorText(caught);
  return /expired|invalid|session missing|jwt/i.test(text);
}

function ResetPasswordPage() {
  const router = useRouter();
  const [state, setState] = useState<"checking" | "ready" | "no-link" | "expired">("checking");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  /**
   * One reveal for both fields.
   *
   * The two are typed a character apart and compared on submit, so revealing one and hiding the
   * other would only make it harder to spot the typo this form exists to catch.
   */
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // A reason in the fragment means a link arrived and was rejected: that is the expired case.
    if (linkFailure() !== null) {
      setState("expired");
      return;
    }
    let cancelled = false;
    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      // No session and no failure means nobody followed a link here at all.
      setState(data.session === null ? "no-link" : "ready");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters for your password.`);
      return;
    }
    if (password !== confirmation) {
      setError("Those two passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (updateError) {
      // A session that has gone while the form was open is a link that was present and died.
      if (isDeadLink(updateError)) setState("expired");
      else setError(friendlyAuthError(updateError));
      return;
    }
    setShowPassword(false);
    router.history.replace("/today");
  }

  return (
    <main className="paper-grain min-h-dvh">
      <div className="app-shell flex min-h-dvh flex-col py-10">
        <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <BrandMark size={24} /> NutriTrack
        </Link>

        <div className="my-auto animate-rise py-10">
          <h1 className="text-4xl font-semibold">Set a new password</h1>

          {state === "checking" && (
            <p role="status" className="mt-2 text-muted-foreground">
              Checking your link…
            </p>
          )}

          {(state === "expired" || state === "no-link") && (
            <>
              <p role="alert" className="mt-2 text-muted-foreground">
                {state === "expired" ? EXPIRED_LINK : NO_LINK}
              </p>
              <Button asChild className="mt-6 w-fit rounded-full">
                {/* Straight to the reset step, which is the thing "request a new one" means. */}
                <Link to="/auth" search={{ forgot: true }}>
                  Request a new link
                </Link>
              </Button>
            </>
          )}

          {state === "ready" && (
            <form onSubmit={submit} className="mt-6 space-y-4">
              <p className="text-sm text-muted-foreground">
                Choose something you have not used here before.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="new-password">New password</Label>
                <PasswordInput
                  id="new-password"
                  autoComplete="new-password"
                  required
                  minLength={MIN_PASSWORD}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  visible={showPassword}
                  onToggle={() => setShowPassword((shown) => !shown)}
                  className="h-11"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm-password">Confirm password</Label>
                <PasswordInput
                  id="confirm-password"
                  autoComplete="new-password"
                  required
                  minLength={MIN_PASSWORD}
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  visible={showPassword}
                  onToggle={() => setShowPassword((shown) => !shown)}
                  className="h-11"
                />
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" className="h-12 w-full rounded-full text-base" disabled={busy}>
                {busy && <Loader2 className="animate-spin" />}
                Set a new password
              </Button>
            </form>
          )}

          <p className="mt-6 text-xs text-muted-foreground">
            <Link to="/auth" search={{}} className="underline">
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
