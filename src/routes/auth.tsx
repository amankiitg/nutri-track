import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Loader2, MailCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BrandMark } from "@/components/app/BrandMark";
import { isPlausibleEmail, normalizeEmail } from "@/lib/admin";
import { friendlyAuthError, isInvalidCredentials } from "@/lib/auth-errors";
import { safeRedirect } from "@/lib/auth-redirect";
import { inviteRequestMailto } from "@/lib/invite-request";

type AuthTab = "signin" | "signup";

/** How long the Resend control stays disabled after a send. */
const RESEND_COOLDOWN_SECONDS = 60;

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — NutriTrack" },
      { name: "description", content: "Sign in to NutriTrack with Google or email." },
      { property: "og:title", content: "Sign in — NutriTrack" },
      { property: "og:description", content: "Sign in to NutriTrack with Google or email." },
    ],
  }),
  /**
   * `tab` lets the landing page open the create-account form directly. `redirect` is where the
   * guard sends someone back after signing in, and it is checked again by `safeRedirect` before
   * anything navigates to it.
   */
  validateSearch: (search: Record<string, unknown>): { tab?: AuthTab; redirect?: string } => ({
    ...(search["tab"] === "signup" ? { tab: "signup" as const } : {}),
    ...(typeof search["redirect"] === "string" ? { redirect: search["redirect"] } : {}),
  }),
  component: AuthPage,
});

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A11 11 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l2.85-2.22.81-.62Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53Z"
      />
    </svg>
  );
}

function AuthPage() {
  const router = useRouter();
  const search = Route.useSearch();
  const destination = safeRedirect(search.redirect);

  const [tab, setTab] = useState<AuthTab>(search.tab ?? "signin");
  const [busy, setBusy] = useState<"google" | "email" | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [verifySent, setVerifySent] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [error, setError] = useState<string | null>(null);

  /**
   * The invite gate, answered on blur rather than at the end of the form.
   *
   * The old flow let someone choose a password and submit, and only then told them they were
   * never going to get an account. `checking` is a state of its own because the check is a round
   * trip, and the panel must not flash "invite-only" while the question is still in the air.
   */
  const [invite, setInvite] = useState<"unknown" | "checking" | "allowed" | "denied" | "error">(
    "unknown",
  );
  /** The address the current `invite` answer belongs to, so a re-blur does not re-ask. */
  const checkedEmail = useRef("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) router.history.replace(destination);
    });
  }, [router, destination]);

  // A countdown rather than a timer per send: one timeout at a time, cleared when this unmounts
  // or the number changes, so a double press cannot start two clocks.
  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  /** The address a verification link or OAuth exchange comes back to, carrying the redirect. */
  function callbackUrl(): string {
    const url = new URL(`${window.location.origin}/auth/callback`);
    if (search.redirect !== undefined) url.searchParams.set("redirect", search.redirect);
    return url.toString();
  }

  /** Asks the database whether an address may create an account. */
  async function checkInvite(address: string): Promise<"allowed" | "denied" | "error"> {
    const { data, error: checkError } = await supabase.rpc("check_email_allowed", {
      _email: address,
    });
    if (checkError) return "error";
    return data === true ? "allowed" : "denied";
  }

  /** The answer that decides whether the create-account form is even shown. */
  async function handleEmailBlur(): Promise<void> {
    if (tab !== "signup" || !isPlausibleEmail(email)) return;
    const address = normalizeEmail(email);
    if (checkedEmail.current === address) return;
    checkedEmail.current = address;
    setInvite("checking");
    setError(null);
    setInvite(await checkInvite(address));
  }

  const google = async () => {
    setBusy("google");
    setError(null);
    const { data, error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: callbackUrl(),
        // Take the URL back rather than letting supabase-js navigate, so any error it
        // returns lands in the error state below.
        //
        // Caveat: supabase-js builds the `/authorize` URL client-side and reports no
        // error when a provider is not enabled on the project, so a misconfigured
        // provider still shows the auth server's own response. Catching that here
        // would mean calling `/authorize` ourselves, which mints the OAuth flow state
        // we would then have to complete by hand.
        skipBrowserRedirect: true,
      },
    });
    if (oauthError) {
      setError(friendlyAuthError(oauthError));
      setBusy(null);
      return;
    }
    if (data.url) {
      window.location.assign(data.url);
      return;
    }
    setError("Could not start Google sign-in. Please try again.");
    setBusy(null);
  };

  const signIn = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("email");
    setError(null);
    const address = normalizeEmail(email);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: address,
      password,
    });

    if (signInError === null) {
      setBusy(null);
      router.history.replace(destination);
      return;
    }

    // "Invalid login credentials" is what the provider says both for a wrong password and for
    // an address that was never invited, and the two need different screens: one is worth
    // retyping, the other never will be. Ask the invite list before blaming the password. It
    // costs one round trip, only on a failure, and it turns a dead end into the panel that
    // explains the actual situation.
    if (isInvalidCredentials(signInError) && isPlausibleEmail(address)) {
      const verdict = await checkInvite(address);
      if (verdict === "denied") {
        checkedEmail.current = address;
        setInvite("denied");
        setBusy(null);
        return;
      }
      // Anything else — allowed, or a check that could not be completed — leaves the
      // provider's own answer standing: it did say the credentials do not match.
    }

    setBusy(null);
    setError(friendlyAuthError(signInError));
  };

  const signUp = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("email");
    setError(null);

    const address = normalizeEmail(email);
    if (!isPlausibleEmail(address)) {
      setError("Enter an email address first.");
      setBusy(null);
      return;
    }
    if (password.length < 8) {
      setError("Use at least 8 characters for your password.");
      setBusy(null);
      return;
    }

    // Asked again on submit, not only on blur: a blur can be skipped, and the answer can have
    // changed since. A refusal replaces the form, because there is nothing to type into it.
    const allowed = await checkInvite(address);
    checkedEmail.current = address;
    if (allowed === "error") {
      setInvite("error");
      setError("We couldn't check the invite list just now. Check your connection and try again.");
      setBusy(null);
      return;
    }
    if (allowed === "denied") {
      setInvite("denied");
      setBusy(null);
      return;
    }

    const { data, error: signUpError } = await supabase.auth.signUp({
      email: address,
      password,
      options: { emailRedirectTo: callbackUrl() },
    });
    setBusy(null);
    if (signUpError) {
      setError(friendlyAuthError(signUpError));
      return;
    }

    // Supabase reports success when the address already has an account, and sends nothing. The
    // tell is a user with no identities: no error, no email, and a person waiting for one.
    if (data.user?.identities?.length === 0) {
      setTab("signin");
      setError(
        "You already have an account with this email. Sign in instead, or use Continue with Google if that's how you joined.",
      );
      return;
    }

    if (data.session) {
      router.history.replace(destination);
      return;
    }

    setVerifySent(address);
    setResendIn(RESEND_COOLDOWN_SECONDS);
    toast.success("Verification email sent");
  };

  async function resend(): Promise<void> {
    if (verifySent === null || resendIn > 0) return;
    setError(null);
    const { error: resendError } = await supabase.auth.resend({
      type: "signup",
      email: verifySent,
    });
    if (resendError) {
      setError(friendlyAuthError(resendError));
      return;
    }
    setResendIn(RESEND_COOLDOWN_SECONDS);
    toast.success("Verification email sent again");
  }

  /** Back to the form, for someone who wants to try another address. */
  function resetInvite(): void {
    checkedEmail.current = "";
    setInvite("unknown");
    setError(null);
  }

  return (
    <main className="paper-grain min-h-dvh">
      <div className="app-shell flex min-h-dvh flex-col py-10">
        <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <BrandMark size={24} /> NutriTrack
        </Link>

        <div className="my-auto animate-rise py-10">
          <h1 className="text-4xl font-semibold">
            {tab === "signup" ? "Create your account" : "Welcome"}
          </h1>
          <p className="mt-2 text-muted-foreground">
            Invite-only for now. Use the email you were invited with.
          </p>

          {verifySent ? (
            <div className="card-soft mt-8 p-5">
              <MailCheck className="size-8 text-primary" />
              <h2 className="mt-3 text-xl font-semibold">Check your inbox</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                We sent a verification link to <strong>{verifySent}</strong>. Open it on this
                device, then come back and sign in.
              </p>
              <p className="mt-3 text-sm text-muted-foreground">
                Didn&apos;t get it? Check spam, or{" "}
                <button
                  type="button"
                  className="underline disabled:opacity-60 disabled:no-underline"
                  onClick={() => void resend()}
                  disabled={resendIn > 0}
                >
                  {resendIn > 0 ? `resend in ${resendIn}s` : "resend"}
                </button>
                .
              </p>
              {error && (
                <p role="alert" className="mt-3 text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button variant="outline" className="mt-4" onClick={() => setVerifySent(null)}>
                Back to sign in
              </Button>
            </div>
          ) : (
            <div className="mt-8 space-y-5">
              <Button
                type="button"
                variant="outline"
                className="h-12 w-full rounded-full text-base"
                onClick={google}
                disabled={busy !== null}
              >
                {busy === "google" ? <Loader2 className="animate-spin" /> : <GoogleIcon />}
                Continue with Google
              </Button>

              <div className="flex items-center gap-3 text-xs text-muted-foreground uppercase tracking-wider">
                <span className="h-px flex-1 bg-border" />
                or with email
                <span className="h-px flex-1 bg-border" />
              </div>

              <Tabs
                value={tab}
                onValueChange={(value) => {
                  setTab(value === "signup" ? "signup" : "signin");
                  setError(null);
                }}
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="signin">Sign in</TabsTrigger>
                  <TabsTrigger value="signup">Create account</TabsTrigger>
                </TabsList>

                <TabsContent value="signin">
                  {invite === "denied" ? (
                    <InviteOnlyPanel email={normalizeEmail(email)} onReset={resetInvite} />
                  ) : (
                    <form onSubmit={signIn} className="space-y-4 pt-2">
                      <EmailPassword
                        email={email}
                        password={password}
                        setEmail={setEmail}
                        setPassword={setPassword}
                        autoComplete="current-password"
                      />
                      {error && (
                        <p role="alert" className="text-sm text-destructive">
                          {error}
                        </p>
                      )}
                      <Button
                        type="submit"
                        className="h-12 w-full rounded-full text-base"
                        disabled={busy !== null}
                      >
                        {busy === "email" && <Loader2 className="animate-spin" />}
                        Sign in
                      </Button>
                    </form>
                  )}
                </TabsContent>

                <TabsContent value="signup">
                  {invite === "denied" ? (
                    <InviteOnlyPanel email={normalizeEmail(email)} onReset={resetInvite} />
                  ) : (
                    <form onSubmit={signUp} className="space-y-4 pt-2">
                      <EmailPassword
                        email={email}
                        password={password}
                        setEmail={setEmail}
                        setPassword={setPassword}
                        autoComplete="new-password"
                        onEmailBlur={() => void handleEmailBlur()}
                      />
                      {error && (
                        <p role="alert" className="text-sm text-destructive">
                          {error}
                        </p>
                      )}
                      <Button
                        type="submit"
                        className="h-12 w-full rounded-full text-base"
                        disabled={busy !== null}
                      >
                        {busy === "email" && <Loader2 className="animate-spin" />}
                        Create account
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        By creating an account you agree to how your data is handled (
                        <Link to="/privacy" className="underline">
                          Privacy
                        </Link>
                        ).
                      </p>
                      <p className="text-xs text-muted-foreground">
                        We&apos;ll email you a verification link before you can sign in.
                      </p>
                    </form>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          )}
        </div>

        <p className="text-center text-xs text-muted-foreground">
          <Link to="/privacy" className="underline">
            Privacy
          </Link>
        </p>
      </div>
    </main>
  );
}

/**
 * What both forms show once the invite list has said no.
 *
 * One component for the two tabs, because it is one refusal. Arriving from "Create account", or
 * from a sign-in that could not have worked whatever the password, the person needs the same three
 * things: what the situation is, a way to ask, and a way out of the address they typed.
 *
 * Asking is a mailto and not a button that writes. By this point nobody is signed in, so there is
 * no token for `recordInviteRequest` to take an address from; the request leaves from the person's
 * own mailbox instead, and the app records nothing until they are let in.
 */
function InviteOnlyPanel({ email, onReset }: { email: string; onReset: () => void }) {
  return (
    <div className="space-y-4 pt-2">
      <h2 className="text-xl font-semibold">NutriTrack is invite-only right now</h2>
      <p className="text-sm text-muted-foreground">
        <strong>{email}</strong> isn&apos;t on the list yet. Request access and you&apos;ll get an
        email as soon as you&apos;re in.
      </p>

      <Button asChild className="h-11 w-full rounded-full">
        <a href={inviteRequestMailto(email)}>Request access</a>
      </Button>
      <p className="text-xs text-muted-foreground">
        Your email app will open with the request ready to send.
      </p>

      <button type="button" className="text-xs underline" onClick={onReset}>
        Use a different email
      </button>
    </div>
  );
}

function EmailPassword(props: {
  email: string;
  password: string;
  setEmail: (v: string) => void;
  setPassword: (v: string) => void;
  autoComplete: "current-password" | "new-password";
  /** Only the create-account form asks the invite list, on the way out of the field. */
  onEmailBlur?: (() => void) | undefined;
}) {
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          value={props.email}
          onChange={(e) => props.setEmail(e.target.value)}
          onBlur={props.onEmailBlur}
          className="h-11"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete={props.autoComplete}
          required
          minLength={8}
          value={props.password}
          onChange={(e) => props.setPassword(e.target.value)}
          className="h-11"
        />
      </div>
    </>
  );
}
