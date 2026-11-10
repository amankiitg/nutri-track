import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandMark } from "@/components/app/BrandMark";
import { InviteAddress } from "@/components/invite/InviteAddress";
import { isPlausibleEmail, normalizeEmail } from "@/lib/admin";
import { signedInVisit } from "@/lib/post-signin";
import { requestInvite, type InviteResult } from "@/lib/invite-request";

/**
 * Asking for an invite, as its own page.
 *
 * It used to be a step inside the sign-in flow, which made it reachable only by first typing an
 * address and being refused. It is a different intention: somebody who has no account and no invite
 * wants one thing, and a page that asked them to prove it first was a page that wasted their time.
 *
 * The screen's whole job is to say which of five things happened, because "thanks" is the wrong
 * answer to four of them:
 *
 *   requested        it is recorded, and here is what happens next
 *   already_pending  somebody already asked with this address
 *   already_invited  there is nothing to ask for, so here is the sign-in link
 *   invalid          that is not an address, said under the field rather than above the button
 *   rate_limited     nothing was recorded, and the mailbox is the way through
 *
 * A failed call is shown as `rate_limited`'s sentence on purpose: from where the person is standing,
 * "the server did not take it" and "the server is refusing" are the same problem with the same fix.
 */
export const Route = createFileRoute("/auth_/request")({
  head: () => ({
    meta: [
      { title: "Request an invite · NutriTrack" },
      {
        name: "description",
        content:
          "NutriTrack is invite-only. Ask for an invite and you'll get an email when you're in.",
      },
      { property: "og:title", content: "Request an invite · NutriTrack" },
      {
        property: "og:description",
        content:
          "NutriTrack is invite-only. Ask for an invite and you'll get an email when you're in.",
      },
    ],
  }),
  /**
   * `email` prefills the field, which is how the sign-in page hands over an address the person
   * already typed, and how the approval email's link can land on a form that is nearly filled in.
   * `redirect` is carried so a signed-in visitor still ends up where they were going.
   */
  validateSearch: (search: Record<string, unknown>): { email?: string; redirect?: string } => ({
    ...(typeof search["email"] === "string" ? { email: search["email"] } : {}),
    ...(typeof search["redirect"] === "string" ? { redirect: search["redirect"] } : {}),
  }),
  component: RequestInvitePage,
});

function RequestInvitePage() {
  const router = useRouter();
  const search = Route.useSearch();

  const [email, setEmail] = useState(
    search.email !== undefined ? normalizeEmail(search.email) : "",
  );
  const [firstName, setFirstName] = useState("");
  /**
   * The hidden field.
   *
   * A person never sees it: it is off the tab order, hidden from assistive technology and out of
   * autocomplete. A form filled in by a script usually fills every input it finds, and a value here
   * means the request is not from a person. The page then says what it would have said anyway and
   * sends nothing, which is the one answer that tells the script nothing.
   */
  const [honeypot, setHoneypot] = useState("");

  const [result, setResult] = useState<InviteResult | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let active = true;
    // Already signed in: there is nothing to request. The profile decides where - Today for somebody
    // who has finished, the wizard for somebody who has not - rather than assuming this page's
    // visitor is always midway through signing up.
    void signedInVisit(search.redirect).then((visit) => {
      if (!active || visit.kind === "signed_out") return;
      router.history.replace(visit.kind === "ready" ? visit.to : "/onboarding");
    });
    return () => {
      active = false;
    };
  }, [router, search.redirect]);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const address = normalizeEmail(email);
    setFieldError(null);

    if (!isPlausibleEmail(address)) {
      setFieldError("Enter an email address, like name@example.com.");
      setResult(null);
      return;
    }

    // The honeypot short-circuit. The database has the same rule, so a script that went straight to
    // the API gets the same answer; this one just saves the round trip.
    if (honeypot.trim() !== "") {
      setResult("requested");
      return;
    }

    setSending(true);
    const outcome = await requestInvite(address, { firstName });
    setSending(false);
    setEmail(address);
    setResult(outcome ?? "rate_limited");
  }

  const requested = result === "requested" || result === "already_pending";
  const failed = result === "rate_limited";

  return (
    <main className="paper-grain min-h-dvh">
      <div className="app-shell flex min-h-dvh flex-col py-10">
        <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <BrandMark size={24} /> NutriTrack
        </Link>

        <div className="my-auto animate-rise py-10">
          <h1 className="text-4xl font-semibold">Request an invite</h1>
          <p className="mt-2 text-muted-foreground">
            NutriTrack is invite-only. Ask for an invite and you&apos;ll get an email when
            you&apos;re approved.
          </p>

          {/*
            `noValidate` because the checks below are the ones that own this form. The browser's own
            bubble for a malformed address is a different sentence in a different place, and it
            fires only in the cases it happens to know about.
          */}
          <form onSubmit={(e) => void submit(e)} noValidate className="mt-8 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="request-email">Email</Label>
              <Input
                id="request-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setFieldError(null);
                }}
                aria-invalid={fieldError !== null}
                aria-describedby={fieldError === null ? undefined : "request-email-error"}
                className="h-11"
              />
              {fieldError !== null && (
                <p id="request-email-error" role="alert" className="text-sm text-destructive">
                  {fieldError}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="request-first-name">First name (optional)</Label>
              <Input
                id="request-first-name"
                type="text"
                autoComplete="given-name"
                maxLength={50}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="h-11"
              />
            </div>

            {/*
              The honeypot. `sr-only` rather than `hidden`: a script that skips `display: none`
              fields still fills this one, and nothing visual changes.
            */}
            <div className="sr-only" aria-hidden="true">
              <label htmlFor="request-website">Your website</label>
              <input
                id="request-website"
                name="request-website"
                type="text"
                tabIndex={-1}
                autoComplete="off"
                value={honeypot}
                onChange={(e) => setHoneypot(e.target.value)}
              />
            </div>

            <Button type="submit" className="h-12 w-full rounded-full text-base" disabled={sending}>
              {sending && <Loader2 className="animate-spin" />}
              Request invite
            </Button>
          </form>

          {requested && (
            <p
              role="status"
              className="mt-5 rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
            >
              {result === "already_pending" ? (
                <>
                  You&apos;ve already requested an invite. We&apos;ll email you at{" "}
                  <strong>{email}</strong> as soon as you&apos;re approved.
                </>
              ) : (
                <>
                  Request sent. We&apos;ll email you at <strong>{email}</strong> when you&apos;re
                  approved. Then come back and sign in.
                </>
              )}
            </p>
          )}

          {result === "already_invited" && (
            <p
              role="status"
              className="mt-5 rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
            >
              You&apos;re already invited.{" "}
              <Link to="/auth" search={{ email }} className="underline">
                Sign in
              </Link>
            </p>
          )}

          {failed && (
            <p role="alert" className="mt-5 text-sm text-destructive">
              Couldn&apos;t send the request right now. Email invites@tracknutri.app instead.
            </p>
          )}

          <div className="mt-6">
            <InviteAddress />
          </div>

          <p className="mt-6 text-xs text-muted-foreground">
            Already invited?{" "}
            <Link
              to="/auth"
              search={email.trim() === "" ? {} : { email: normalizeEmail(email) }}
              className="underline"
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
