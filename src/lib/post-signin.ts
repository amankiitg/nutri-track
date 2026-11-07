/**
 * What a signed-in visitor's relationship to the app is, and where that puts them.
 *
 * Three pages are reachable while signed in - `/auth`, `/auth/request` and `/auth/welcome` - and each
 * used to decide for itself. Two sent everybody to `/today` and let the guard sort it out, which is a
 * hop through a client-only route with its own async checks; the third sent everybody to
 * `/onboarding`. Both were guesses about a fact the page can simply look up.
 *
 * **The profile row is the test**, and it is the same one `_authenticated/route.tsx` uses: a user with
 * a profile has finished onboarding and belongs on Today, and a user without one has not answered the
 * questions yet. Asking it here means a page never has to guess, and no finished user can be handed
 * the wizard by a redirect that was really only about "is there a session".
 *
 * The three answers are kept distinct on purpose. `/auth/welcome` is the link a brand-new invitee
 * opens, so "signed in, no profile" is its **normal** state: that page must stay put and let them set
 * a password. Collapsing it into "go to onboarding" would skip the step they came for.
 *
 * `getUser()` rather than `getSession()` for the same reason the guard uses it: the session in
 * localStorage can be expired, and treating an expired session as signed in makes these pages bounce
 * against the guard forever.
 */
import { supabase } from "@/integrations/supabase/client";
import { fetchProfile } from "@/lib/profile";
import { safeRedirect } from "@/lib/auth-redirect";

export type SignedInVisit =
  /** Nobody is signed in: the page should just render its form. */
  | { kind: "signed_out" }
  /** Signed in, but the questions have not been answered yet. */
  | { kind: "not_set_up" }
  /** Signed in with a profile: this is where to send them. */
  | { kind: "ready"; to: string };

/**
 * Which of the three this visitor is.
 *
 * `redirect` is the `?redirect=` the guard put in the URL after sending them here, so a link to
 * `/settings` still lands on `/settings` once they are in. It goes through `safeRedirect`, because it
 * is attacker-controlled and ends up in a navigation.
 */
export async function signedInVisit(redirect?: unknown): Promise<SignedInVisit> {
  // A client that cannot answer - no network, no session store, a project mid-deploy - is treated as
  // "nobody is signed in", which renders the page's own form. The alternative is a sign-in page that
  // throws because the session check failed, and the person sees nothing they can act on.
  let user: { id: string } | null = null;
  try {
    const { data, error } = await supabase.auth.getUser();
    user = error ? null : data.user;
  } catch {
    return { kind: "signed_out" };
  }
  if (user === null) return { kind: "signed_out" };

  const profile = await fetchProfile(user.id).catch(() => null);
  if (!profile) return { kind: "not_set_up" };

  return { kind: "ready", to: safeRedirect(redirect) };
}
