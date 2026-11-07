/**
 * How an account signs in, in words the Settings screen can show.
 *
 * Read from `identities` rather than from `app_metadata.providers`: the identities list is what
 * the auth server will actually accept for this user, and it is the one the app can describe
 * without explaining anything. Kept out of the component so it is a pure function with one job,
 * and so the component file exports only a component, which is what fast refresh needs.
 */
export function providerSummary(providers: readonly string[]): string {
  const google = providers.includes("google");
  const email = providers.includes("email");

  if (google && email) return "Google and email";
  if (google) return "Google";
  if (email) return "Email";
  if (providers.length === 0) return "no provider yet";

  // Anything else is named rather than guessed at.
  return providers.join(" and ");
}
