/**
 * Setting a new password, reached from the link in the reset email.
 *
 * The link comes back to `/auth/reset` with the recovery tokens in the URL fragment. supabase-js
 * reads them on load and the page therefore has a session by the time this mounts; there is no
 * token handling here, which is the point of `redirectTo` being this route.
 *
 * Two failure states, and they are different things. A link that was never valid (navigating here
 * directly, or an expired fragment) shows the "expired" screen with a way to ask for another. A
 * failure from `updateUser` is reported as itself, because only a dead link deserves the expired
 * sentence.
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandMark } from "@/components/app/BrandMark";
import { authErrorText, friendlyAuthError } from "@/lib/auth-errors";

/** Said for a link that cannot be used, in the one place both paths reach it. */
export const EXPIRED_LINK = "That link has expired. Request a new one.";

/** The same minimum the create-account form uses, so the two cannot disagree. */
const MIN_PASSWORD = 8;

export const Route = createFileRoute("/auth_/reset")({
  head: () => ({
    meta: [
      { title: "Set a new password — NutriTrack" },
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
  const [state, setState] = useState<"checking" | "ready" | "expired">("checking");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (linkFailure() !== null) {
      setState("expired");
      return;
    }
    let cancelled = false;
    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setState(data.session === null ? "expired" : "ready");
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
      if (isDeadLink(updateError)) setState("expired");
      else setError(friendlyAuthError(updateError));
      return;
    }
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

          {state === "expired" && (
            <>
              <p role="alert" className="mt-2 text-muted-foreground">
                {EXPIRED_LINK}
              </p>
              <Button asChild className="mt-6 w-fit rounded-full">
                {/* Straight to the reset step, which is the thing "request a new one" means. */}
                <Link to="/auth" search={{ tab: "signin", forgot: true }}>
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
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={MIN_PASSWORD}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-11"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm-password">Confirm password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={MIN_PASSWORD}
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
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
            <Link to="/auth" search={{ tab: "signin" }} className="underline">
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
