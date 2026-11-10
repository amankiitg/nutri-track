/**
 * The trial links already sent to the addresses on an admin panel, keyed by the address as
 * passed. Its own module so the component file exports only components (fast refresh).
 */
import { useQuery } from "@tanstack/react-query";
import { fetchTrialLinks, type TrialLinkSent } from "@/lib/admin";

export const TRIAL_LINKS_KEY = "admin-trial-links";

/** The links sent to these addresses, keyed by the address as passed. */
export function useTrialLinks(emails: string[]): Map<string, TrialLinkSent> {
  const sorted = [...emails].sort();
  const links = useQuery({
    queryKey: [TRIAL_LINKS_KEY, sorted],
    queryFn: () => fetchTrialLinks(sorted),
    enabled: sorted.length > 0,
  });
  return links.data ?? new Map();
}
