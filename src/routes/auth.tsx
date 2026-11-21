import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Loader2, MailCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandMark } from "@/components/app/BrandMark";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { isPlausibleEmail, normalizeEmail } from "@/lib/admin";
import {
  CREDENTIALS_MISMATCH,
  authErrorDetail,
  authErrorText,
  friendlyAuthError,
  isInvalidCredentials,
} from "@/lib/auth-errors";
import { safeRedirect } from "@/lib/auth-redirect";
import { signedInVisit } from "@/lib/post-signin";
import { authEntryState } from "@/lib/invite-request";
import { openSignups } from "@/lib/open-signups";
import { reportPageFunnelEvent } from "@/lib/trial";
import { loadTurnstile, turnstileApi, turnstileSiteKey } from "@/lib/turnstile";
import { createTurnstileTokenSource, type TurnstileTokenSource } from "@/lib/turnstile-token";
import {
  requestEmailLink,
  requestPasswordReset,
  resendConfirmation,
  signInWithPassword,
  startOAuthSignIn,
} from "@/lib/auth-sign-in";
import { rememberPendingGoogleEmail } from "@/lib/pending-google-email";

/**
 * Signing in, in one email-first flow.
 *
 * "Sign in" and "Create account" were two questions the page could not answer for the person: which
 * of them is right depends on facts only the database has, and asking somebody to choose before it
 * had looked was how a Google-only account got told to create a second one. So the page asks for an
 * address, `auth_entry_state` decides, and the screen that appears is the one that address deserves:
 *
 *   not_invited  this address is not on the list yet: ask for an invite
 *   invited_new  on the list with no account: email a link, which is the only way to prove the inbox
 *   has_password  an account with a password: sign in, or reset it
 *   google_only  on the list with an account that has never had a password: Google, or a link
 *   busy         the throttle refused to answer: try again in a minute
 *
 * **Nothing here asks for a password before the address is verified.** The invited path emails a
 * link and sets the password afterwards, on `/auth/welcome`, because a password chosen before the
 * inbox is proven belongs to whoever typed the address rather than to whoever owns it.
 *
 * The words "create account" are deliberately absent. Somebody whose address is on the list is not
 * creating anything; they are claiming the invite that already names them.
 */

/** How long the Resend control stays disabled after a send. */
const RESEND_COOLDOWN_SECONDS = 60;

/** How long the reset link can be asked for again. The same minute, for the same reason. */
const RESET_COOLDOWN_SECONDS = 60;

/**
 * The screens this page can be on. One at a time, and every one has a way back to the email.
 *
 * `verify` is the panel that replaces the form once a link has been sent, rather than a step: it
 * belongs to whichever step sent it.
 */
/**
 * `open_signup` is the state open sign-ups add: an address with no account, offered one. Every
 * other state means what it did before, so with the switch off this screen is unchanged.
 */
type Step =
  | "email"
  | "not_invited"
  | "invited_new"
  | "open_signup"
  /** An account with a password: the password box applies. */
  | "has_password"
  /** An email account that never set one: the magic link is the door. */
  | "link_only"
  /** The same, plus a Google identity: Google works too. */
  | "link_only_google"
  /**
   * Evidence of a password, plus a Google identity. Both doors, and the password view arrives first
   * because it is the one the evidence is about.
   */
  | "has_password_google"
  | "google_only"
  | "reset";

/**
 * A countdown a button starts, used by the controls that must not be pressed twice in a row.
 *
 * One timeout at a time, cleared when the number changes or the page unmounts: a stale timer is how
 * a label ends up saying something that is no longer true.
 */
function useCooldown(seconds: number): { remaining: number; start: () => void } {
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setTimeout(() => setRemaining((left) => left - 1), 1000);
    return () => clearTimeout(timer);
  }, [remaining]);
  return { remaining, start: () => setRemaining(seconds) };
}

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in · NutriTrack" },
      { name: "description", content: "Sign in to NutriTrack with Google or email." },
      { property: "og:title", content: "Sign in · NutriTrack" },
      { property: "og:description", content: "Sign in to NutriTrack with Google or email." },
    ],
  }),
  /**
   * `email` arrives from two places that both want the page to carry on by itself: the approval
   * email's button, and the invite panel's "request an invite" round trip. `redirect` is where the
   * guard sends someone back after signing in, and it is checked again by `safeRedirect` before
   * anything navigates to it.
   *
   * There is no `tab` any more. Old links that still carry one land on the email step, which is where
   * every visit starts now.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    email?: string;
    redirect?: string;
    forgot?: boolean;
  } => ({
    ...(typeof search["email"] === "string" ? { email: search["email"] } : {}),
    ...(typeof search["redirect"] === "string" ? { redirect: search["redirect"] } : {}),
    ...(search["forgot"] === true ? { forgot: true } : {}),
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

/** Why a link was sent, which decides what the panel above the form promises. */
type LinkKind = "setup" | "verify" | "password" | "signin";

export function AuthPage() {
  const router = useRouter();
  const search = Route.useSearch();
  const destination = safeRedirect(search.redirect);

  const [step, setStep] = useState<Step>(search.forgot === true ? "reset" : "email");
  const [busy, setBusy] = useState<"google" | "email" | "check" | "link" | null>(null);
  const [email, setEmail] = useState(
    search.email !== undefined ? normalizeEmail(search.email) : "",
  );
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  /** The address a link was sent to, and which link it was. Null when no panel is showing. */
  const [linkSent, setLinkSent] = useState<{ email: string; kind: LinkKind } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Where the reset step returns to, since it can be entered from two places. */
  const [resetFrom, setResetFrom] = useState<Step>("email");
  const [resetSent, setResetSent] = useState(false);

  /**
   * The wrong-password sentence, kept apart from `error` because two of its words are buttons: one
   * moves the pointer to the Google button, the other opens the reset step. It is only ever shown on
   * an address the database already said has an account.
   */
  const [mismatch, setMismatch] = useState(false);
  const resendCooldown = useCooldown(RESEND_COOLDOWN_SECONDS);
  const resetCooldown = useCooldown(RESET_COOLDOWN_SECONDS);
  /** Where the word "Continue with Google" sends the pointer. */
  const googleButton = useRef<HTMLButtonElement>(null);
  /** Guards the automatic run, so `?email=` asks the database once rather than on every render. */
  const autoRan = useRef(false);

  /**
   * Whether anybody may create an account. Null while the answer is on its way, and the screen
   * reads that as "not known yet" rather than as either answer.
   */
  const [signupsOpen, setSignupsOpen] = useState<boolean | null>(null);

  /**
   * Where a fresh Turnstile token comes from, one per attempt.
   *
   * A source rather than a state string because the token has to be fetched at the moment of the
   * request and thrown away afterwards: it is single use, it expires in about five minutes, and an
   * `interaction-only` widget may not have produced one before the button is pressed.
   */
  const tokenSource = useRef<TurnstileTokenSource | null>(null);
  const turnstileRef = useRef<HTMLDivElement>(null);

  /** The raw error behind the friendly line, shown small underneath it. */
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  /**
   * Which of the two views an account with a password is looking at.
   *
   * They are alternatives, not layers. "Use an email link instead" swaps this value and the other
   * panel unmounts in the same commit, which is what keeps exactly one view on the screen.
   */
  const [accountView, setAccountView] = useState<"password" | "link">("password");

  useEffect(() => {
    let active = true;
    // Somebody already signed in has no business on this page. Where they go is decided by the same
    // profile check the guard uses: a finished user to Today (or the `?redirect=` they arrived with),
    // a user who has not answered the questions yet to the wizard.
    void signedInVisit(search.redirect).then((visit) => {
      if (!active || visit.kind === "signed_out") return;
      router.history.replace(visit.kind === "ready" ? visit.to : "/onboarding");
    });
    return () => {
      active = false;
    };
  }, [router, search.redirect]);

  // The switch, once, from the database.
  useEffect(() => {
    let active = true;
    void openSignups().then((open) => {
      if (active) setSignupsOpen(open);
    });
    return () => {
      active = false;
    };
  }, []);

  /**
   * The widget, created once but only *rendered* when a request needs a token.
   *
   * Nothing here waits for Cloudflare on page load: `ensure()` runs the widget at submit time and
   * give up after a few seconds, so a slow challenge cannot hold the form hostage.
   */
  useEffect(() => {
    const source = createTurnstileTokenSource({
      siteKey: turnstileSiteKey(),
      container: () => turnstileRef.current,
      load: loadTurnstile,
      api: turnstileApi,
    });
    tokenSource.current = source;
    return () => {
      tokenSource.current = null;
    };
  }, []);

  /**
   * The captcha source, as the sign-in helpers want it.
   *
   * One object rather than a token getter, because the helper owns the whole sequence: ask, send,
   * reset. Handing it a token alone is what let a caller forget the reset.
   */
  function captcha(): TurnstileTokenSource {
    return (
      tokenSource.current ?? {
        ensure: async () => null,
        reset: () => {},
        hasToken: () => false,
      }
    );
  }

  /**
   * Legacy links: `?tab=signup` means the email step, and `?request=1` means the invite request page,
   * which now has an address of its own. Both are taken out of the address bar rather than left there
   * as choices that no longer exist. `replace` rather than a router navigation for the first one:
   * nothing about the page changes, only the URL.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("request")) {
      window.location.replace("/auth/request");
      return;
    }
    if (!params.has("tab")) return;
    params.delete("tab");
    const query = params.toString();
    window.history.replaceState({}, "", `/auth${query === "" ? "" : `?${query}`}`);
  }, []);

  /** The address a verification link or OAuth exchange comes back to, carrying the redirect. */
  function callbackUrl(): string {
    const url = new URL(`${window.location.origin}/auth/callback`);
    if (search.redirect !== undefined) url.searchParams.set("redirect", search.redirect);
    return url.toString();
  }

  /**
   * Starts Google's flow, with the address typed so far as a hint.
   *
   * The hint is what keeps a Google-only account from being asked to pick an account it does not
   * want: Google's chooser opens on the address the person already told us.
   */
  const google = async (hint?: string) => {
    setBusy("google");
    setError(null);
    setErrorDetail(null);
    const address = normalizeEmail(hint ?? email);
    // Remembered only for the return leg: the callback compares it with whoever Google sends back,
    // because choosing a different account in the chooser is easy and silent.
    rememberPendingGoogleEmail(address);
    const { data, error: oauthError } = await startOAuthSignIn(supabase, captcha(), {
      provider: "google",
      options: {
        redirectTo: callbackUrl(),
        // Take the URL back rather than letting supabase-js navigate, so any error it returns lands in
        // the error state below.
        //
        // Caveat: supabase-js builds the `/authorize` URL client-side and reports no error when a
        // provider is not enabled on the project, so a misconfigured provider still shows the auth
        // server's own response. Catching that here would mean calling `/authorize` ourselves, which
        // mints the OAuth flow state we would then have to complete by hand.
        skipBrowserRedirect: true,
        ...(address === "" ? {} : { queryParams: { login_hint: address } }),
      },
    });
    if (oauthError) {
      setError(friendlyAuthError(oauthError));
      setErrorDetail(authErrorDetail(oauthError));
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

  /**
   * Emails a sign-in link, which is the invited path and the fallback for a Google-only account.
   *
   * `shouldCreateUser` is true because the invited path has no account yet: the link is what creates
   * one, after the inbox has been proven. For a Google-only account it changes nothing - the address
   * already has a user, and this adds the link rather than a second row.
   */
  async function emailLink(address: string, kind: LinkKind): Promise<void> {
    setError(null);
    setErrorDetail(null);
    setBusy("link");
    const { error: linkError } = await requestEmailLink(supabase, captcha(), {
      email: address,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: `${window.location.origin}/auth/welcome`,
      },
    });
    setBusy(null);
    if (linkError) {
      setError(friendlyAuthError(linkError));
      setErrorDetail(authErrorDetail(linkError));
      return;
    }
    // A link that creates the account is the sign-up finishing as far as the page can see: the
    // inbox is what makes it real, and by then the browser is gone.
    if (kind === "setup") reportPageFunnelEvent("signup_completed");
    setLinkSent({ email: address, kind });
    resendCooldown.start();
    toast.success("Link sent");
  }

  /**
   * Emails a sign-in link to an existing account, which signs the person in without a password.
   *
   * `shouldCreateUser` is false because the address already has an account: the link signs into the
   * one that exists rather than creating a second row. Supabase reports the same result whether or
   * not the address exists, so nothing here reveals that fact beyond what `auth_entry_state` already
   * showed. The link lands on the origin, where the landing page's session check sends a signed-in
   * person to Today.
   */
  async function emailSignInLink(address: string): Promise<void> {
    setError(null);
    setErrorDetail(null);
    setBusy("link");
    const { error: linkError } = await requestEmailLink(supabase, captcha(), {
      email: address,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: window.location.origin,
      },
    });
    setBusy(null);
    if (linkError) {
      setError(friendlyAuthError(linkError));
      setErrorDetail(authErrorDetail(linkError));
      return;
    }
    setLinkSent({ email: address, kind: "signin" });
    resendCooldown.start();
    toast.success("Link sent");
  }

  /**
   * The one place that decides which screen the address deserves.
   *
   * A failure here is shown as a failure rather than as "not invited": the panel tells somebody to
   * ask for an invite, which is the wrong thing to say to a person whose invite exists and whose
   * connection dropped. `busy` is the same shape of mistake and gets its own sentence, because the
   * fix is to wait a minute rather than to ask for anything.
   */
  async function checkAddress(raw: string): Promise<void> {
    const address = normalizeEmail(raw);
    if (!isPlausibleEmail(address)) {
      setError("Enter an email address first.");
      return;
    }
    setError(null);
    setMismatch(false);
    setLinkSent(null);
    setBusy("check");
    const state = await authEntryState(address);
    setBusy(null);
    setEmail(address);
    if (state === null) {
      setError("Couldn't check that address right now. Try again in a moment.");
      return;
    }
    if (state === "busy") {
      setError("Too many attempts. Try again in a minute.");
      return;
    }
    // The sign-up screen appearing is the funnel step; it is counted here rather than in the render
    // so a re-render cannot count it twice.
    if (state === "open_signup") reportPageFunnelEvent("signup_started");
    // A new address starts on the view its own answer deserves, not on the last address's.
    setAccountView("password");
    // One translation, in one place: a database from before the three-way split says `has_account`,
    // and everything below speaks in `has_password`.
    setStep(state === "has_account" ? "has_password" : state);
  }

  const continueWithEmail = async (e: FormEvent) => {
    e.preventDefault();
    await checkAddress(email);
  };

  /**
   * The automatic run: `/auth?email=someone@example.com` fills the field and asks the database, so the
   * approval email's button lands on the form that address needs rather than on an address to retype.
   *
   * In an effect and not during the first render, for the same reason the onboarding wizard reads its
   * saved answers in one: this page is rendered on the server too, and a screen that appears only on
   * the client before hydration commits is a mismatch.
   */
  useEffect(() => {
    if (autoRan.current) return;
    const address = normalizeEmail(search.email ?? "");
    if (!isPlausibleEmail(address)) return;
    autoRan.current = true;
    void checkAddress(address);
    // Deliberately not in the dependency list: `checkAddress` only reads state setters and the
    // address it is given, and adding it would re-run this on every render that recreates it.
  }, [search.email]);

  const signIn = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("email");
    setError(null);
    setErrorDetail(null);
    setMismatch(false);
    // Through the helper, which carries the captcha token: a password sign-in sent without one is
    // refused by GoTrue for the token rather than for the password, and the person is told the wrong
    // thing about their own fingers.
    const { error: signInError } = await signInWithPassword(supabase, captcha(), {
      email: normalizeEmail(email),
      password,
    });

    if (signInError === null) {
      setBusy(null);
      setShowPassword(false);
      // The password worked, so this account has one: record it, because that is the only evidence
      // the sign-in screen has, and an account from before the flag existed self heals here on its
      // first password sign-in. Fire and forget: a failed note must not stop somebody signing in.
      void supabase.rpc("mark_has_password");
      router.history.replace(destination);
      return;
    }

    setBusy(null);
    // An unconfirmed account looks exactly like a wrong password from the form's side, and the fix is
    // not a password at all: it is the link in the inbox. Same panel as the invited path, so the
    // person recognises it.
    if (authErrorText(signInError).toLowerCase().includes("email not confirmed")) {
      setLinkSent({ email: normalizeEmail(email), kind: "verify" });
      return;
    }
    // The address is on the list and has an account, because the database said so before this form
    // was drawn. So a refusal really is about the password, and the two ways out are Google and a
    // reset, both offered as buttons inside the sentence.
    if (isInvalidCredentials(signInError)) {
      setMismatch(true);
      setErrorDetail(authErrorDetail(signInError));
      return;
    }
    setError(friendlyAuthError(signInError));
    // The receipt under the sentence, as the link flow already shows: code, status and message, so a
    // refusal names its own cause rather than only that something went wrong.
    setErrorDetail(authErrorDetail(signInError));
  };

  async function resend(): Promise<void> {
    if (linkSent === null || resendCooldown.remaining > 0) return;
    setError(null);
    if (linkSent.kind === "verify") {
      const { error: resendError } = await resendConfirmation(supabase, captcha(), {
        type: "signup",
        email: linkSent.email,
      });
      if (resendError) {
        setError(friendlyAuthError(resendError));
        return;
      }
    } else {
      const { error: linkError } = await requestEmailLink(supabase, captcha(), {
        email: linkSent.email,
        options:
          linkSent.kind === "signin"
            ? {
                shouldCreateUser: false,
                emailRedirectTo: window.location.origin,
              }
            : {
                shouldCreateUser: true,
                emailRedirectTo: `${window.location.origin}/auth/welcome`,
              },
      });
      if (linkError) {
        setError(friendlyAuthError(linkError));
        return;
      }
    }
    resendCooldown.start();
    toast.success("Link sent again");
  }

  /** Puts the pointer on the Google button, for the sentence that names it. */
  function focusGoogle(): void {
    const button = googleButton.current;
    if (button === null) return;
    button.scrollIntoView({ block: "center", behavior: "smooth" });
    button.focus();
  }

  /**
   * Asks for a reset link.
   *
   * The answer is the same whether or not the address has a password: a screen that said "no such
   * account" would be a way to ask whether somebody uses this app. Supabase reports no error for an
   * unknown address, so there is nothing to branch on anyway.
   */
  async function sendReset(e: FormEvent): Promise<void> {
    e.preventDefault();
    const address = normalizeEmail(email);
    if (!isPlausibleEmail(address)) {
      setError("Enter an email address first.");
      return;
    }
    setError(null);
    setBusy("email");
    resetCooldown.start();
    const { error: resetError } = await requestPasswordReset(supabase, captcha(), {
      email: address,
      redirectTo: `${window.location.origin}/auth/reset`,
    });
    setBusy(null);
    if (resetError) {
      // No "check your email" sentence for a request that never went: it is the one claim the
      // screen cannot afford to make up.
      setError(friendlyAuthError(resetError));
      return;
    }
    setResetSent(true);
  }

  /** Back to the address field, from any step. Everything typed after it belongs to that step. */
  function useDifferentEmail(): void {
    setStep("email");
    // A different address is a different account, so the password view goes away, and the field is
    // cleared: what is left of the old address is a value nobody typed for this step.
    setAccountView("password");
    setEmail("");
    setPassword("");
    setShowPassword(false);
    setError(null);
    setMismatch(false);
    setLinkSent(null);
    setResetSent(false);
  }

  function openReset(from: Step): void {
    setResetFrom(from);
    setResetSent(false);
    setError(null);
    setMismatch(false);
    setStep("reset");
  }

  /**
   * Swaps between the password view and the link view of an account that has both doors.
   *
   * The other view unmounts in the same commit, so there is never a moment with two panels on the
   * screen, and the password typed into the view being left is dropped rather than carried to a
   * view that does not ask for it.
   */
  function showAccountView(view: "password" | "link"): void {
    setAccountView(view);
    setPassword("");
    setShowPassword(false);
    setError(null);
    setErrorDetail(null);
    setMismatch(false);
  }

  /** An account the database has evidence of a password for: two views, one at a time. */
  const passwordAccount = step === "has_password" || step === "has_password_google";

  const heading =
    step === "email"
      ? "Welcome"
      : step === "not_invited"
        ? "This email isn't invited yet."
        : step === "open_signup"
          ? "Create your account"
          : step === "invited_new"
            ? "You're invited!"
            : step === "has_password" ||
                step === "has_password_google" ||
                step === "link_only" ||
                step === "link_only_google"
              ? "Welcome back"
              : step === "google_only"
                ? "This account signs in with Google."
                : "Reset your password";

  /** The panel that replaces the form once a link has gone out. */
  const linkPanel =
    linkSent === null ? null : (
      <div className="card-soft mt-8 p-5">
        <MailCheck className="size-8 text-primary" />
        <h2 className="mt-3 text-xl font-semibold">Check your inbox</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {linkSent.kind === "verify" ? (
            <>
              Check your inbox to verify <strong>{linkSent.email}</strong>. Open the link on this
              device, then come back and sign in.
            </>
          ) : linkSent.kind === "password" ? (
            <>
              We sent a link to <strong>{linkSent.email}</strong>. Open it on this device to set a
              password.
            </>
          ) : linkSent.kind === "signin" ? (
            <>The link works once and expires in an hour.</>
          ) : (
            <>
              We sent a link to <strong>{linkSent.email}</strong>. Open it on this device to finish
              setting up.
            </>
          )}
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          Didn&apos;t get it? Check spam, or{" "}
          <button
            type="button"
            className="underline disabled:opacity-60 disabled:no-underline"
            onClick={() => void resend()}
            disabled={resendCooldown.remaining > 0}
          >
            {resendCooldown.remaining > 0 ? `resend in ${resendCooldown.remaining}s` : "resend"}
          </button>
          .
        </p>
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={() => setLinkSent(null)}>
            Back
          </Button>
          <button
            type="button"
            className="text-xs text-muted-foreground underline"
            onClick={useDifferentEmail}
          >
            Use a different email
          </button>
        </div>
      </div>
    );

  return (
    <main className="paper-grain min-h-dvh">
      <div className="app-shell flex min-h-dvh flex-col py-10">
        <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <BrandMark size={24} /> NutriTrack
        </Link>

        <div className="my-auto animate-rise py-10">
          <h1 className="text-4xl font-semibold">{heading}</h1>
          {step === "email" && (
            <p className="mt-2 text-muted-foreground">
              {signupsOpen === true
                ? "New here, or coming back? Either way, start with your email."
                : "Invite-only for now. Use the email you were invited with."}
            </p>
          )}

          {/*
            The Turnstile widget mounts here, once, outside every step, so it survives the step
            changes: the create-account, existing-account and Google-only screens all borrow it, and
            a widget that unmounted with the email step was the reason "Email me a link" arrived at
            Supabase without a token.
          */}
          <div ref={turnstileRef} data-turnstile="" />

          {linkPanel ?? (
            <div className="mt-8 space-y-5">
              {step === "email" && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-12 w-full rounded-full text-base"
                    onClick={() => void google()}
                    disabled={busy !== null}
                    ref={googleButton}
                  >
                    {busy === "google" ? <Loader2 className="animate-spin" /> : <GoogleIcon />}
                    Continue with Google
                  </Button>

                  <div className="flex items-center gap-3 text-xs text-muted-foreground uppercase tracking-wider">
                    <span className="h-px flex-1 bg-border" />
                    or with email
                    <span className="h-px flex-1 bg-border" />
                  </div>

                  <form onSubmit={continueWithEmail} className="space-y-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="email">Email</Label>
                      <Input
                        id="email"
                        type="email"
                        inputMode="email"
                        autoComplete="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="h-11"
                      />
                    </div>
                    {error && (
                      <div role="alert">
                        <p className="text-sm text-destructive">{error}</p>
                        {errorDetail !== null && (
                          <p className="mt-1 text-xs text-muted-foreground break-words">
                            {errorDetail}
                          </p>
                        )}
                      </div>
                    )}
                    <Button
                      type="submit"
                      className="h-12 w-full rounded-full text-base"
                      disabled={busy !== null}
                    >
                      {busy === "check" && <Loader2 className="animate-spin" />}
                      Continue
                    </Button>
                  </form>

                  {/*
                    The request page has an address of its own, and the typed address travels with
                    the link so nobody has to type it twice.
                  */}
                  {signupsOpen === false && (
                    <p className="text-base text-muted-foreground">
                      No invite yet?{" "}
                      <Link
                        to="/auth/request"
                        search={email.trim() === "" ? {} : { email: normalizeEmail(email) }}
                        className="underline"
                      >
                        Request one
                      </Link>
                    </p>
                  )}
                </>
              )}

              {step === "not_invited" && (
                <>
                  <p className="text-sm text-muted-foreground">
                    <strong>{email}</strong> isn&apos;t on the list yet. Ask for an invite and
                    you&apos;ll get an email as soon as you&apos;re approved.
                  </p>
                  <Button asChild className="h-12 w-full rounded-full text-base">
                    <Link to="/auth/request" search={{ email }}>
                      Request an invite
                    </Link>
                  </Button>
                  <button
                    type="button"
                    className="block text-base text-muted-foreground underline underline-offset-4"
                    onClick={useDifferentEmail}
                  >
                    Use a different email
                  </button>
                </>
              )}

              {step === "open_signup" && (
                <>
                  <p className="text-sm text-muted-foreground">
                    <strong>{email}</strong> has no account yet, and sign-ups are open. We&apos;ll
                    email you a link to create one.
                  </p>
                  <Button
                    type="button"
                    className="h-12 w-full rounded-full text-base"
                    disabled={busy !== null}
                    onClick={() => void emailLink(email, "setup")}
                  >
                    {busy === "link" ? <Loader2 className="animate-spin" /> : null}
                    Email me a link
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-12 w-full rounded-full text-base"
                    disabled={busy !== null}
                    onClick={() => void google(email)}
                  >
                    {busy === "google" ? <Loader2 className="animate-spin" /> : <GoogleIcon />}
                    Continue with Google
                  </Button>
                  <p className="text-base text-muted-foreground">
                    The link proves the address is yours, which is also what lets your first meal be
                    read.
                  </p>
                  <p className="text-base text-muted-foreground">
                    We send the occasional product update to this address. You can turn that off in
                    Settings.
                  </p>
                  {error && (
                    <div role="alert">
                      <p className="text-sm text-destructive">{error}</p>
                      {errorDetail !== null && (
                        <p className="mt-1 text-xs text-muted-foreground break-words">
                          {errorDetail}
                        </p>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    className="block text-base text-muted-foreground underline underline-offset-4"
                    onClick={useDifferentEmail}
                  >
                    Use a different email
                  </button>
                </>
              )}

              {step === "invited_new" && (
                <>
                  <p className="text-sm text-muted-foreground">
                    <strong>{email}</strong> is on the list. We&apos;ll email you a link to finish
                    setting up.
                  </p>
                  <Button
                    type="button"
                    className="h-12 w-full rounded-full text-base"
                    disabled={busy !== null}
                    onClick={() => void emailLink(email, "setup")}
                  >
                    {busy === "link" && <Loader2 className="animate-spin" />}
                    Email me a link
                  </Button>
                  <p className="text-base text-muted-foreground">
                    You can set a password later in Settings.
                  </p>
                  {error && (
                    <p role="alert" className="text-sm text-destructive">
                      {error}
                    </p>
                  )}
                  <button
                    type="button"
                    className="block text-base text-muted-foreground underline underline-offset-4"
                    onClick={useDifferentEmail}
                  >
                    Use a different email
                  </button>
                </>
              )}

              {/*
                An account with evidence of a password. The password view arrives first, and the link
                is a view of its own reached from the quiet link below, never a panel stacked under
                this one: two panels at once is how this screen grew two "Email me a sign-in link"
                buttons and ran "Forgot password?" into "Use an email link instead".
              */}
              {passwordAccount && accountView === "password" && (
                <>
                  <p className="text-sm text-muted-foreground">
                    Signing in as <strong>{email}</strong>.
                  </p>
                  <form onSubmit={signIn} className="space-y-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="password">Password</Label>
                      <PasswordInput
                        id="password"
                        autoComplete="current-password"
                        required
                        minLength={8}
                        // This view appeared because somebody asked for it, so the field is where
                        // they are going next.
                        autoFocus
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        visible={showPassword}
                        onToggle={() => setShowPassword((shown) => !shown)}
                        className="h-11"
                      />
                    </div>
                    {mismatch ? (
                      <p role="alert" className="text-sm text-destructive">
                        {CREDENTIALS_MISMATCH.before}
                        <button type="button" className="underline" onClick={focusGoogle}>
                          {CREDENTIALS_MISMATCH.google}
                        </button>
                        {CREDENTIALS_MISMATCH.between}
                        <button
                          type="button"
                          className="underline"
                          onClick={() => openReset("has_password")}
                        >
                          {CREDENTIALS_MISMATCH.reset}
                        </button>
                        {CREDENTIALS_MISMATCH.after}
                      </p>
                    ) : (
                      error && (
                        <p role="alert" className="text-sm text-destructive">
                          {error}
                        </p>
                      )
                    )}
                    {errorDetail !== null && (
                      <p className="text-xs text-muted-foreground break-words">{errorDetail}</p>
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
                  {step === "has_password_google" && (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-12 w-full rounded-full text-base"
                      onClick={() => void google(email)}
                      disabled={busy !== null}
                      ref={googleButton}
                    >
                      {busy === "google" ? <Loader2 className="animate-spin" /> : <GoogleIcon />}
                      Continue with Google
                    </Button>
                  )}
                  {/*
                    One row, with room between the two: as separate inline buttons they ran together
                    into "Forgot password?Use an email link instead".
                  */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <button
                      type="button"
                      className="block text-base text-muted-foreground underline underline-offset-4"
                      onClick={() => openReset("has_password")}
                    >
                      Forgot password?
                    </button>
                    <button
                      type="button"
                      className="block text-base text-muted-foreground underline underline-offset-4"
                      onClick={() => showAccountView("link")}
                    >
                      Use an email link instead
                    </button>
                  </div>
                  <button
                    type="button"
                    className="block text-base text-muted-foreground underline underline-offset-4"
                    onClick={useDifferentEmail}
                  >
                    Use a different email
                  </button>
                </>
              )}

              {/* The other view of the same account, and the only thing on the screen when it is. */}
              {passwordAccount && accountView === "link" && (
                <>
                  <p className="text-sm text-muted-foreground">
                    <strong>{email}</strong> signs in with a link, or with the password you set.
                  </p>
                  <Button
                    type="button"
                    className="h-12 w-full rounded-full text-base"
                    onClick={() => void emailSignInLink(email)}
                    disabled={busy !== null}
                    autoFocus
                  >
                    {busy === "link" && <Loader2 className="animate-spin" />}
                    Email me a sign-in link
                  </Button>
                  {step === "has_password_google" && (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-12 w-full rounded-full text-base"
                      onClick={() => void google(email)}
                      disabled={busy !== null}
                      ref={googleButton}
                    >
                      {busy === "google" ? <Loader2 className="animate-spin" /> : <GoogleIcon />}
                      Continue with Google
                    </Button>
                  )}
                  {error && (
                    <div role="alert">
                      <p className="text-sm text-destructive">{error}</p>
                      {errorDetail !== null && (
                        <p className="mt-1 text-xs text-muted-foreground break-words">
                          {errorDetail}
                        </p>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    className="block text-base text-muted-foreground underline underline-offset-4"
                    onClick={() => showAccountView("password")}
                  >
                    Use a password instead
                  </button>
                  <button
                    type="button"
                    className="block text-base text-muted-foreground underline underline-offset-4"
                    onClick={useDifferentEmail}
                  >
                    Use a different email
                  </button>
                </>
              )}

              {/*
                An email account with no evidence of a password, and no Google identity: one door,
                and no password control of any kind. It has none, and a control that cannot work is
                worse than none. This is what a magic-link sign-up leaves behind, and every account
                created by the open sign-up flow starts here.
              */}
              {step === "link_only" && (
                <>
                  <p className="text-sm text-muted-foreground">
                    <strong>{email}</strong> signs in by email link. We&apos;ll send you one to open
                    on this device.
                  </p>
                  <Button
                    type="button"
                    className="h-12 w-full rounded-full text-base"
                    onClick={() => void emailSignInLink(email)}
                    disabled={busy !== null}
                  >
                    {busy === "link" && <Loader2 className="animate-spin" />}
                    Email me a sign-in link
                  </Button>
                  <p className="text-base text-muted-foreground">
                    Set a password in Settings, and this screen will offer it from then on.
                  </p>
                  {/* This panel had no way back: every other state has one, and a person who typed
                      the wrong address here was stuck with it. */}
                  <button
                    type="button"
                    className="block text-base text-muted-foreground underline underline-offset-4"
                    onClick={useDifferentEmail}
                  >
                    Use a different email
                  </button>
                </>
              )}

              {/*
                The same account, with a Google identity attached: the link stays the primary action
                because that is how the account was made, and Google is offered beside it because it
                works and hiding it would be a door with no handle.
              */}
              {step === "link_only_google" && (
                <>
                  <p className="text-sm text-muted-foreground">
                    <strong>{email}</strong> signs in with a link or with Google.
                  </p>
                  <Button
                    type="button"
                    className="h-12 w-full rounded-full text-base"
                    onClick={() => void emailSignInLink(email)}
                    disabled={busy !== null}
                  >
                    {busy === "link" && <Loader2 className="animate-spin" />}
                    Email me a sign-in link
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-12 w-full rounded-full text-base"
                    onClick={() => void google(email)}
                    disabled={busy !== null}
                  >
                    {busy === "google" ? <Loader2 className="animate-spin" /> : <GoogleIcon />}
                    Continue with Google
                  </Button>
                  <p className="text-base text-muted-foreground">
                    Set a password in Settings, and this screen will offer it from then on.
                  </p>
                  {error && (
                    <div role="alert">
                      <p className="text-sm text-destructive">{error}</p>
                      {errorDetail !== null && (
                        <p className="mt-1 text-xs text-muted-foreground break-words">
                          {errorDetail}
                        </p>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    className="block text-base text-muted-foreground underline underline-offset-4"
                    onClick={useDifferentEmail}
                  >
                    Use a different email
                  </button>
                </>
              )}

              {step === "google_only" && (
                <>
                  <p className="text-sm text-muted-foreground">
                    <strong>{email}</strong> has never had a password here. Sign in with Google, or
                    ask for a link if you would rather have one.
                  </p>
                  {/* The one door that works here is the primary action, not the alternative. */}
                  <Button
                    type="button"
                    className="h-12 w-full rounded-full text-base"
                    onClick={() => void google(email)}
                    disabled={busy !== null}
                    ref={googleButton}
                  >
                    {busy === "google" ? <Loader2 className="animate-spin" /> : <GoogleIcon />}
                    Continue with Google
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-12 w-full rounded-full text-base"
                    onClick={() => void emailSignInLink(email)}
                    disabled={busy !== null}
                  >
                    {busy === "link" && <Loader2 className="animate-spin" />}
                    Email me a sign-in link
                  </Button>
                  {error && (
                    <p role="alert" className="text-sm text-destructive">
                      {error}
                    </p>
                  )}
                  <button
                    type="button"
                    className="block text-base text-muted-foreground underline underline-offset-4 disabled:opacity-60"
                    disabled={busy !== null}
                    onClick={() => void emailLink(email, "password")}
                  >
                    Prefer email? Send me a sign-in link
                  </button>
                  <div>
                    <button
                      type="button"
                      className="block text-base text-muted-foreground underline underline-offset-4"
                      onClick={useDifferentEmail}
                    >
                      Use a different email
                    </button>
                  </div>
                </>
              )}

              {step === "reset" && (
                <form onSubmit={sendReset} className="space-y-4">
                  {resetSent ? (
                    <p role="status" className="text-sm text-muted-foreground">
                      If that email has an account, a reset link is on its way. Check spam too.
                    </p>
                  ) : (
                    <>
                      <p className="text-sm text-muted-foreground">
                        We&apos;ll email you a link to set a new one.
                      </p>
                      <div className="space-y-1.5">
                        <Label htmlFor="reset-email">Email</Label>
                        <Input
                          id="reset-email"
                          type="email"
                          inputMode="email"
                          autoComplete="email"
                          required
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          className="h-11"
                        />
                      </div>
                    </>
                  )}
                  {error && (
                    <p role="alert" className="text-sm text-destructive">
                      {error}
                    </p>
                  )}
                  {!resetSent && (
                    <Button
                      type="submit"
                      className="h-12 w-full rounded-full text-base"
                      disabled={busy !== null || resetCooldown.remaining > 0}
                    >
                      {busy === "email" && <Loader2 className="animate-spin" />}
                      {resetCooldown.remaining > 0
                        ? `Send again in ${resetCooldown.remaining}s`
                        : "Send reset link"}
                    </Button>
                  )}
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      className="block text-base text-muted-foreground underline underline-offset-4"
                      onClick={() => {
                        setError(null);
                        setStep(resetFrom);
                      }}
                    >
                      {resetFrom === "has_password" || resetFrom === "has_password_google"
                        ? "Back to sign in"
                        : "Back to the email field"}
                    </button>
                    <button
                      type="button"
                      className="block text-base text-muted-foreground underline underline-offset-4"
                      onClick={useDifferentEmail}
                    >
                      Use a different email
                    </button>
                  </div>
                </form>
              )}
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
