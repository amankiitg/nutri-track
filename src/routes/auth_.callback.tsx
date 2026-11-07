import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { BrandMark } from "@/components/app/BrandMark";
import { Button } from "@/components/ui/button";
import { friendlyAuthError } from "@/lib/auth-errors";
import { safeRedirect } from "@/lib/auth-redirect";

const SESSION_POLL_ATTEMPTS = 10;
const SESSION_POLL_INTERVAL_MS = 150;

/**
 * Parameters Supabase puts in the fragment for the implicit flow.
 *
 * The router never sees these: `window.location.hash` is the only place they exist, and a failed
 * implicit exchange carries its reason there rather than in the query string.
 */
function hashParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#/, "");
  if (hash === "") return null;
  return new URLSearchParams(hash).get(name);
}

export const Route = createFileRoute("/auth_/callback")({
  ssr: false,
  validateSearch: (
    search: Record<string, unknown>,
  ): { code?: string; redirect?: string; error?: string; errorDescription?: string } => ({
    ...(typeof search["code"] === "string" ? { code: search["code"] } : {}),
    ...(typeof search["redirect"] === "string" ? { redirect: search["redirect"] } : {}),
    ...(typeof search["error"] === "string" ? { error: search["error"] } : {}),
    // Supabase spells it `error_description`; the camelCase form is accepted too so a link that
    // was passed through another tool still arrives with its reason.
    ...(typeof search["error_description"] === "string"
      ? { errorDescription: search["error_description"] }
      : typeof search["errorDescription"] === "string"
        ? { errorDescription: search["errorDescription"] }
        : {}),
  }),
  component: AuthCallbackPage,
});

/**
 * Handles the return leg of an OAuth or email-verification redirect.
 *
 * Supabase can hand the session back two ways: a `code` query parameter (PKCE)
 * or tokens in the URL hash (implicit), which supabase-js consumes itself. This
 * waits for whichever arrives, then lets the `_authenticated` guard decide
 * between `/today` and `/onboarding`.
 */
function AuthCallbackPage() {
  const router = useRouter();
  const { code, redirect, error: urlError, errorDescription } = Route.useSearch();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    // Why the exchange failed, if anywhere says. Checked in the order the most specific source
    // appears: the query string the provider redirected with, then the fragment, then whatever
    // `exchangeCodeForSession` reports below.
    let reason: string | null =
      errorDescription ?? hashParam("error_description") ?? urlError ?? hashParam("error");

    async function finish() {
      if (code) {
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
        if (exchangeError) {
          // Not fatal on its own: supabase-js may have already consumed the code. Remembered so
          // that a session that never appears can say why rather than only that it did not.
          console.warn("[auth] code exchange failed:", exchangeError.message);
          reason ??= exchangeError.message;
        }
      }

      for (let attempt = 0; attempt < SESSION_POLL_ATTEMPTS; attempt += 1) {
        if (!active) return;
        const { data } = await supabase.auth.getSession();
        if (data.session) {
          router.history.replace(safeRedirect(redirect));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, SESSION_POLL_INTERVAL_MS));
      }

      if (!active) return;
      setError(
        reason === null
          ? "We couldn't complete sign-in. Please try again."
          : friendlyAuthError(reason),
      );
    }

    void finish();

    return () => {
      active = false;
    };
  }, [code, redirect, urlError, errorDescription, router]);

  return (
    <main className="paper-grain min-h-dvh">
      <div className="app-shell flex min-h-dvh flex-col items-center justify-center gap-4 py-10 text-center">
        <BrandMark size={48} />
        {error ? (
          <>
            <h1 className="text-2xl font-semibold">Sign-in failed</h1>
            <p className="text-muted-foreground">{error}</p>
            <Button asChild className="mt-2 h-12 rounded-full">
              <Link to="/auth">Back to sign in</Link>
            </Button>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold">Finishing sign-in…</h1>
            <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
          </>
        )}
      </div>
    </main>
  );
}
