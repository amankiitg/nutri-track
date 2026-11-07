import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { BrandMark } from "@/components/app/BrandMark";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { signedInVisit } from "@/lib/post-signin";
import { friendlyAuthError } from "@/lib/auth-errors";

/**
 * Where the emailed link lands, and the only place a password is ever set for the first time.
 *
 * The order is deliberate. The invite proves nothing about who is reading it, so the first thing the
 * flow asks for is proof of the inbox: the link. Only after that can a password be attached, and only
 * the person holding the link can attach one. That is why nothing before this screen asks for a
 * password - a form that collects one from an unverified address is collecting a password for
 * somebody else's account.
 *
 * A password is still optional. Somebody who signed in with Google does not need one, and somebody
 * who wants one can add it later from Settings. The screen says so rather than pretending the choice
 * does not exist.
 */

/** How long to wait for supabase-js to turn the link into a session before calling it expired. */
const SESSION_POLL_ATTEMPTS = 20;
const SESSION_POLL_INTERVAL_MS = 150;

export const Route = createFileRoute("/auth_/welcome")({
  ssr: false,
  /**
   * `redirect` is carried through from a link minted for a particular destination, so it is honoured
   * once the person is through here rather than being dropped.
   */
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    ...(typeof search["redirect"] === "string" ? { redirect: search["redirect"] } : {}),
  }),
  head: () => ({
    meta: [{ title: "Finish setting up — NutriTrack" }, { name: "robots", content: "noindex" }],
  }),
  component: WelcomePage,
});

function WelcomePage() {
  const router = useRouter();
  const search = Route.useSearch();
  const [status, setStatus] = useState<"checking" | "ready" | "expired">("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    void (async () => {
      // supabase-js consumes the `?code=` in the link by itself (`detectSessionInUrl`), which happens
      // after this renders. Polling rather than reading once is what keeps a fast link from being
      // reported as an expired one.
      for (let attempt = 0; attempt < SESSION_POLL_ATTEMPTS; attempt += 1) {
        const { data } = await supabase.auth.getSession();
        if (!active) return;
        if (data.session) {
          // Signed in. A user who has already answered the questions has nothing to do here - Today
          // is where they belong, and the profile is what says so. Everybody else is the person this
          // page exists for: a new invitee with no profile, who sets a password and then answers the
          // questions.
          const visit = await signedInVisit(search.redirect);
          if (!active) return;
          if (visit.kind === "ready") {
            router.history.replace(visit.to);
            return;
          }
          setStatus("ready");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, SESSION_POLL_INTERVAL_MS));
      }
      if (!active) return;
      setStatus("expired");
    })();

    return () => {
      active = false;
    };
  }, [router, search.redirect]);

  async function savePassword(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Use at least 8 characters for your password.");
      return;
    }
    if (password !== confirm) {
      setError("Those two passwords don't match.");
      return;
    }
    setBusy(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (updateError) {
      setError(friendlyAuthError(updateError));
      return;
    }
    toast.success("Password set");
    setVisible(false);
    // The same question as on arrival, asked again because the answer can have changed: a user who
    // now has a profile belongs on Today, and one who does not belongs in the wizard.
    const visit = await signedInVisit(search.redirect);
    router.history.replace(visit.kind === "ready" ? visit.to : "/onboarding");
  }

  /**
   * "Skip, take me in": no password this time. Same destination question, so a user who somehow
   * arrives here finished is still sent to Today rather than to the wizard.
   */
  async function skip(): Promise<void> {
    const visit = await signedInVisit(search.redirect);
    router.history.replace(visit.kind === "ready" ? visit.to : "/onboarding");
  }

  return (
    <main className="paper-grain min-h-dvh">
      <div className="app-shell flex min-h-dvh flex-col py-10">
        <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <BrandMark size={24} /> NutriTrack
        </Link>

        <div className="my-auto animate-rise py-10">
          {status === "checking" && (
            <div className="flex items-center gap-3 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" aria-hidden="true" />
              <p>Finishing sign-in…</p>
            </div>
          )}

          {status === "expired" && (
            <>
              <h1 className="text-4xl font-semibold">That link has expired</h1>
              <p className="mt-2 text-muted-foreground">
                Links are single use and short lived. Ask for a new one and it will work the same
                way.
              </p>
              <Button asChild className="mt-6 h-12 rounded-full">
                <Link to="/auth">Back to sign in</Link>
              </Button>
            </>
          )}

          {status === "ready" && (
            <>
              <h1 className="text-4xl font-semibold">You&apos;re in</h1>
              <p className="mt-2 text-muted-foreground">
                Set a password (optional). It lets you sign in without waiting for an email, and you
                can add or change it later in Settings.
              </p>

              <form onSubmit={(e) => void savePassword(e)} className="mt-8 space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="password">Password</Label>
                  <PasswordInput
                    id="password"
                    autoComplete="new-password"
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    visible={visible}
                    onToggle={() => setVisible((shown) => !shown)}
                    className="h-11"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="confirm-password">Confirm password</Label>
                  <PasswordInput
                    id="confirm-password"
                    autoComplete="new-password"
                    minLength={8}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    visible={visible}
                    onToggle={() => setVisible((shown) => !shown)}
                    className="h-11"
                  />
                </div>
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
                <Button
                  type="submit"
                  className="h-12 w-full rounded-full text-base"
                  disabled={busy}
                >
                  {busy && <Loader2 className="animate-spin" />}
                  Set password
                </Button>
              </form>

              <Button
                type="button"
                variant="outline"
                className="mt-3 h-12 w-full rounded-full text-base"
                onClick={() => void skip()}
              >
                Skip, take me in
              </Button>

              <p className="mt-6 text-xs text-muted-foreground">
                By continuing you agree to how your data is handled (
                <Link to="/privacy" className="underline">
                  Privacy
                </Link>
                ).
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
