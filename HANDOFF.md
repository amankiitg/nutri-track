# Handoff: the /auth states task

Branch `task/auth-states-e2e`. No PR yet: the rule is that a to k pass first.

## Decided and done

**Option A, flag only.** `profiles.has_password` is the only evidence, set by Settings, by the reset
screen, and by any successful password sign-in (the self heal). No backfill. `20261121120000` holds
the column, the recorder, the guard and the flag-only `auth_entry_state`; it is **already applied to
production** (`migration list --remote` shows both sides) and is safe ahead of the Worker because no
profile has the flag yet. **The Worker has not been deployed for this branch.**

**The captcha decision.** `ensure()` in `turnstile-token.ts` waits, re-triggers the widget once, and
then throws `CaptchaUnavailableError` instead of answering null. Every sign-in path in
`auth-sign-in.ts` converts that into an auth-shaped refusal and sends nothing: link, signup, Google,
**password** and **reset** (the last two are new helpers, and the password one is what the local stack
was failing on with "no captcha_token found"). The screens show "Security check is still loading. Tap
again in a second.", the button comes back, and the detail line hides itself because status 0 is not
a fact worth printing. With CAPTCHA off there is no widget and sending without a token is unchanged.

A source scan test now fails if anything outside `auth-sign-in.ts` calls `auth.signInWithPassword` or
`auth.resetPasswordForEmail`, which is what keeps those two paths behind the token in future.

## Verified

- migration suite PASS (hash is not evidence, amr claim is not evidence, clearing the flag returns the
  account to the link)
- frontend **1127 tests in 84 files**, lint **0 errors** (6 pre-existing warnings), `tsc --noEmit` **0**,
  `tsc -p e2e --noEmit` **0**
- e2e, 375 px: **a passes, b passes, c passes** (the password set in Settings, the wrong password with
  its detail line, then the right one landing on Today)

## Where it stopped

**Case d fails on a `page.goto` that never finishes**, after the reset email link. The harness is
settled enough to reach it in 1.5 minutes and time out rather than fail fast, which usually means the
navigation is waiting on a document that never reaches load. First thing to look at: whether the
recovery link lands on `/auth/reset` with a session in the fragment and the page then redirects, and
whether `waitUntil: "domcontentloaded"` on that goto is the honest fix rather than a workaround.

**Case j has a name clash to settle.** It is currently the slow-captcha case (a widget that answers
nothing: the exact sentence, no OTP request, no captcha error). The checklist letter j was CAPTCHA
off, which still needs its own run with the stack restarted with `[auth.captcha] enabled = false` and
no site key. Rename one of them before the report.

Still to do: e (Google, written not yet green), f, g, h, i, the CAPTCHA-off case, the contact sheet,
the CI job, the production smoke, deleting this file, the PR, then the Worker deploy and its check.

## Harness lessons, already in the code

- `psql` does not substitute variables given with `-c`; `sql()` feeds the query on stdin.
- `getByLabel("Password")` matches two elements (the reveal button is "Show password"). Use
  `{ exact: true }`. The reset screen says "New password" and "Set a new password".
- The iPhone preset carries webkit and is pinned to chromium; the install prompt is seeded as
  dismissed, since it is a modal over the buttons a person means to press.
- `e2e/run.sh` resets the local database on every run, so the suite cannot pass against an old
  function body. `E2E_NO_RESET=1` skips it while iterating.
- `askState` presses Continue at most twice and throws if the step never moves; `openAuth` retries a
  goto aborted by a client side redirect, once.
- Signing out from Settings leaves `/auth?redirect=%2Fsettings`, and that redirect is honoured after
  sign-in. Cases that care about the destination start from a plain `openAuth`.

## Not touched

No Worker deployment for this branch, no emails outside the local stack, nothing pushed to `main`.