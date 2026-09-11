import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Loader2, MailCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BrandMark } from "@/components/app/BrandMark";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — NutriTrack" },
      { name: "description", content: "Sign in to NutriTrack with Google or email." },
      { property: "og:title", content: "Sign in — NutriTrack" },
      { property: "og:description", content: "Sign in to NutriTrack with Google or email." },
    ],
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
  const navigate = useNavigate();
  const [busy, setBusy] = useState<"google" | "email" | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [verifySent, setVerifySent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/today", replace: true });
    });
  }, [navigate]);

  const google = async () => {
    setBusy("google");
    setError(null);
    const { data, error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
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
      setError(oauthError.message);
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
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(null);
    if (error) {
      setError(
        error.message.toLowerCase().includes("confirm")
          ? "Please verify your email first — check your inbox for the link."
          : error.message,
      );
      return;
    }
    navigate({ to: "/today", replace: true });
  };

  const signUp = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("email");
    setError(null);
    if (password.length < 8) {
      setError("Use at least 8 characters for your password.");
      setBusy(null);
      return;
    }
    const { data: allowed, error: checkError } = await supabase.rpc("check_email_allowed", {
      _email: email,
    });
    if (checkError) {
      setError(checkError.message);
      setBusy(null);
      return;
    }
    if (!allowed) {
      setError("This email isn't on the invite list yet. Ask the account owner to add you.");
      setBusy(null);
      return;
    }
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setBusy(null);
    if (error) {
      setError(error.message);
      return;
    }
    if (data.session) {
      navigate({ to: "/today", replace: true });
      return;
    }
    setVerifySent(email);
    toast.success("Verification email sent");
  };

  return (
    <main className="paper-grain min-h-dvh">
      <div className="app-shell flex min-h-dvh flex-col py-10">
        <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <BrandMark size={24} /> NutriTrack
        </Link>

        <div className="my-auto animate-rise py-10">
          <h1 className="text-4xl font-semibold">Welcome back.</h1>
          <p className="mt-2 text-muted-foreground">
            Invite-only for now. Sign in with Google or your email.
          </p>

          {verifySent ? (
            <div className="card-soft mt-8 p-5">
              <MailCheck className="size-8 text-primary" />
              <h2 className="mt-3 text-xl font-semibold">Check your inbox</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                We sent a verification link to <strong>{verifySent}</strong>. Open it on this
                device, then come back and sign in.
              </p>
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

              <Tabs defaultValue="signin" onValueChange={() => setError(null)}>
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="signin">Sign in</TabsTrigger>
                  <TabsTrigger value="signup">Create account</TabsTrigger>
                </TabsList>
                <TabsContent value="signin">
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
                </TabsContent>
                <TabsContent value="signup">
                  <form onSubmit={signUp} className="space-y-4 pt-2">
                    <EmailPassword
                      email={email}
                      password={password}
                      setEmail={setEmail}
                      setPassword={setPassword}
                      autoComplete="new-password"
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
                      We'll email you a verification link before you can sign in.
                    </p>
                  </form>
                </TabsContent>
              </Tabs>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function EmailPassword(props: {
  email: string;
  password: string;
  setEmail: (v: string) => void;
  setPassword: (v: string) => void;
  autoComplete: "current-password" | "new-password";
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
