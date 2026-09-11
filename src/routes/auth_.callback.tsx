import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { BrandMark } from "@/components/app/BrandMark";
import { Button } from "@/components/ui/button";

const SESSION_POLL_ATTEMPTS = 10;
const SESSION_POLL_INTERVAL_MS = 150;

export const Route = createFileRoute("/auth_/callback")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): { code: string | undefined } => ({
    code: typeof search["code"] === "string" ? search["code"] : undefined,
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
  const navigate = useNavigate();
  const { code } = Route.useSearch();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function finish() {
      if (code) {
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
        if (exchangeError) {
          // Not fatal on its own: supabase-js may have already consumed the code.
          console.warn("[auth] code exchange failed:", exchangeError.message);
        }
      }

      for (let attempt = 0; attempt < SESSION_POLL_ATTEMPTS; attempt += 1) {
        if (!active) return;
        const { data } = await supabase.auth.getSession();
        if (data.session) {
          await navigate({ to: "/today", replace: true });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, SESSION_POLL_INTERVAL_MS));
      }

      if (!active) return;
      setError("We couldn't complete sign-in. Please try again.");
    }

    void finish();

    return () => {
      active = false;
    };
  }, [code, navigate]);

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
