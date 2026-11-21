# The states of /auth

One table, and it is the whole contract: `auth_entry_state` answers with one of the words in the
first column, and that answer decides every word and every button on the screen. Anything not in
this table is a bug in one of the two, not a third case.

Two rules run through all of it.

1. **Exactly one view.** The page draws one panel at a time: the email field, a link panel, or a
   password panel. There is no state in which two panels are mounted, so there is never a duplicate
   "Email me a sign-in link" and never a stray password box.
2. **A password door exists only where a password is known to exist.** "Known to exist" means one
   thing: `profiles.has_password` is true. Three places set it, and each is a moment the app itself
   saw a password work or be set:
   - Settings, after `updateUser({ password })` succeeds;
   - the reset screen, after the same call succeeds with a new password;
   - any successful password sign-in, so an account that already had a password before the flag
     existed heals itself the first time it uses one.

   Nothing is backfilled. The two other candidates were measured and rejected:
   - **the stored hash is not evidence.** GoTrue writes a random 60 character bcrypt hash for an
     account created by a magic link, so presence there claimed a password that did not exist.
   - **the amr claims are not evidence either.** `auth.mfa_amr_claims` looked right, because a row
     with `authentication_method = 'password'` ought to mean a password was used. Measured on a
     local stack (GoTrue v2.198), a session established by an emailed link writes both claims:

     ```
     email                          | profiles.has_password | amr claims   | auth_entry_state
     new.suite.mwqkst39@example.com | false                 | password,otp | has_password
     ```

     That account never had a password. The claims describe how the session was proved, not what the
     account holds, so a rule reading them handed the password box to exactly the accounts it was
     written to exclude.

## The table

`open_signups` is the database switch. It changes exactly two rows of this table (the two with no
account and no invitation) and the subtitle under the email field. Every row marked "same" behaves
identically whether the switch is on or off.

| State | open_signups | Buttons, in order | Copy | Links |
| --- | --- | --- | --- | --- |
| `email` (first step, before any answer) | on | Continue with Google (outline); Continue (primary) | "New here, or coming back? Either way, start with your email." | none (Request one is hidden while sign ups are open) |
| `email` (first step, before any answer) | off | Continue with Google (outline); Continue (primary) | "Invite-only for now. Use the email you were invited with." | "No invite yet? Request one" goes to /auth/request with the typed address |
| `not_invited` (no account, not on the list) | off | Request an invite (primary, link) | "**address** isn't on the list yet. Ask for an invite and you'll get an email as soon as you're approved." | Use a different email |
| `open_signup` (no account, sign ups open) | on | Email me a link (primary); Continue with Google (outline) | "**address** has no account yet, and sign-ups are open. We'll email you a link to create one." plus "The link proves the address is yours, which is also what lets your first meal be read." | Use a different email |
| `invited_new` (on the list, no account yet) | same | Email me a link (primary) | "**address** is on the list. We'll email you a link to finish setting up." plus "You can set a password later in Settings." | Use a different email |
| `link_only` (account, no password evidence, email identity only) | same | Email me a sign-in link (primary) | "**address** signs in by email link. We'll send you one to open on this device." plus "Set a password in Settings later, and this screen will offer it instead." | Use a different email |
| `link_only_google` (the same, with Google attached) | same | Email me a sign-in link (primary); Continue with Google (outline) | "**address** signs in with a link or with Google." plus the same Settings note | Use a different email |
| `has_password` (password evidence, email identity only) | same | Sign in (primary, submits the password); Email me a sign-in link instead (secondary, swaps to the link view) | "Signing in as **address**." | Forgot password? (opens the reset step); Use an email link instead (swaps back to the link view) while in the password view; Use a different email |
| `has_password_google` (password evidence plus Google) | same | Sign in (primary); Continue with Google (outline); Email me a sign-in link instead (secondary) | "Signing in as **address**." | Forgot password?; Use an email link instead; Use a different email |
| `google_only` (Google identity, no email identity) | same | Continue with Google (primary); Email me a sign-in link (outline) | "**address** has never had a password here. Sign in with Google, or ask for a link if you would rather have one." | Prefer email? Send me a sign-in link (sends a link that lets them set one); Use a different email |
| `busy` (the throttle refused) | same | Continue (primary), on the email step it never left | the email step stays, with "Too many attempts. Try again in a minute." under the field | the same Request one link the email step has when sign ups are closed |

Every panel above that can send something also shows the "Check your inbox" panel in place of the
buttons once the send succeeds. That panel is a replacement, not a stacking: it has "Didn't get it?
Check spam, or Resend in 0:59", and the resend control is disabled for 60 seconds.

### The two views of an account that has a password

`has_password` and `has_password_google` can show either the password view or the link view, and
they are alternatives, not layers:

| View | Shown when | Primary action | Way to the other view |
| --- | --- | --- | --- |
| password | the answer arrived, and nobody has asked for the link yet | Sign in with the typed password | "Use an email link instead" |
| link | "Use an email link instead" was pressed | Email me a sign-in link | "Use a password instead" |

Moving between them focuses what the person is expected to use next (the password field, then the
link button), and "Use a different email" appears in both and returns to the email step with the
field cleared.

### What each button does

| Button | Call | On success |
| --- | --- | --- |
| Continue | `auth_entry_state(email)` | the state below it replaces the email field |
| Continue with Google | `signInWithOAuth` with the Turnstile token, redirecting to /auth/callback | the browser leaves for Google |
| Email me a link (setup or sign up) | `requestEmailLink(email, kind)` with the Turnstile token | the Check your inbox panel, with a 60 second resend |
| Email me a sign-in link | `signInWithOtp` via `requestEmailLink`, same token | the Check your inbox panel |
| Sign in | `signInWithPassword` with the Turnstile token | Today, or onboarding if the profile is not finished |
| Forgot password? | `resetPasswordForEmail` | "If that email has an account, a reset link is on its way." |
| Request an invite | a route change to /auth/request, no call | the request page, with the address filled in |
| Use a different email | local state only, no call | the email step, field cleared, Turnstile widget kept mounted |
| Resend | the same send, after 60 seconds | the same panel, countdown restarted |

Every quiet link under a panel is its own block on its own line, 16px, with a gap above it. Two of
them used to be inline buttons with margins but no line break, so at 375 px they rendered side by
side as "Use a password insteadUse a different email".

### How an account reaches `has_password`

1. It sets or changes a password in Settings, and the app calls `mark_has_password()`, a security
   definer function that flips the flag on the caller's own row and nothing else. The column is
   guarded by a trigger that refuses a direct write from the client, so the flag says "the app
   recorded a password" rather than "the client claims one".
2. It finishes a password reset, and the same function is called from the reset screen.
3. It signs in with a password, and the sign-in screen calls the same function. This is the self
   heal: an account that had a password before the flag existed becomes `has_password` on its next
   password sign-in, with no backfill and no guessing.

A failed call never blocks the password that was just set or used; the flag is bookkeeping, and the
next attempt writes it again.

One consequence, deliberately accepted: an account that has a password, has never used it since this
deploy, and has not touched Settings is shown the link only until one of those three moments happens.
The link always works, so nobody is locked out, which is the property that made this the acceptable
side of the trade.

### What the OAuth button actually sends

One correction worth recording, because it is invisible in the code: `signInWithOAuth` in
`@supabase/auth-js` forwards `redirectTo`, `scopes` and `queryParams`, and drops `captchaToken`
entirely. The app passes a token and the URL that leaves the browser does not carry it. Harmless in
practice, because GoTrue's CAPTCHA gate covers the password, OTP, signup and recovery endpoints rather
than `/authorize`, but it means "Google sign-in is CAPTCHA protected" is not a claim to make.

### With the CAPTCHA off

Nothing in the table changes. When `VITE_TURNSTILE_SITE_KEY` is empty the widget does not mount and
the calls go out with no token, which is the fallback the local suite covers with the site key
removed.
