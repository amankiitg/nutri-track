/**
 * Whether sign-ups are open, from the database.
 *
 * `/auth` asks the database twice: `auth_entry_state` for the address in the field, and this for
 * the switch. The switch lives in `app_settings` rather than in the bundle because the answer that
 * matters is the one the sign-in RPC gives, and a build-time flag could disagree with it: flip the
 * row and every client is right, without a deploy.
 *
 * Cached for the life of the page because it changes about once a year, and read through a
 * security definer function so `anon` needs no grant on the table.
 */
import { supabase } from "@/integrations/supabase/client";

let cached: Promise<boolean> | null = null;

/**
 * True when anybody may create an account.
 *
 * A failed read answers false, which is what the app did before this existed: an outage should
 * leave the product invite-only rather than open, and the database refuses a stranger anyway.
 */
export function openSignups(): Promise<boolean> {
  if (cached !== null) return cached;
  cached = (async () => {
    try {
      const { data, error } = await supabase.rpc("open_signups");
      if (error) return false;
      return data === true;
    } catch {
      return false;
    }
  })();
  return cached;
}

/** Forgets the cached answer. Tests only: the real page loads it once. */
export function resetOpenSignups(): void {
  cached = null;
}
