/**
 * The two screens a personal trial link can end on besides the trial itself. Shared by /t and
 * by the trial page, which reaches them when a scan is refused after the link was opened.
 */
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/app/BrandMark";

export const LINK_EXPIRED_MESSAGE = "This trial link has expired. Ask Aman for a new one.";

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="paper-grain flex min-h-dvh flex-col">
      <div className="app-shell my-auto animate-rise py-10">
        <BrandMark size={40} />
        {children}
      </div>
    </main>
  );
}

/** Expired, revoked or not a link this service signed: the next step is the same for all three. */
export function TrialLinkExpired() {
  return (
    <Frame>
      <h1 className="mt-6 text-3xl font-semibold">Trial link expired</h1>
      <p className="mt-3 max-w-sm text-muted-foreground">{LINK_EXPIRED_MESSAGE}</p>
      <Button asChild size="lg" className="mt-8 h-12 w-full rounded-full text-base">
        <Link to="/auth/request">Request an invite</Link>
      </Button>
    </Frame>
  );
}

/** The address already has an account, so the trial has nothing to offer it. */
export function TrialAlreadyAccess({ email }: { email: string }) {
  return (
    <Frame>
      <h1 className="mt-6 text-3xl font-semibold">You already have access</h1>
      <p className="mt-3 max-w-sm text-muted-foreground">
        Sign in with {email} to log your meals and see your day.
      </p>
      <Button asChild size="lg" className="mt-8 h-12 w-full rounded-full text-base">
        <Link to="/auth" search={{ email }}>
          Sign in
        </Link>
      </Button>
    </Frame>
  );
}
