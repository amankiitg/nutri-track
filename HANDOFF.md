# Handoff: the /auth states task

Branch `task/auth-states-e2e`. Nothing is merged, and no PR is open yet: the rule for this task is
that the matrix passes first.

## Done, on the branch

1. **`docs/auth-states.md`** is the contract: every state by `open_signups`, every button, every
   link, and what each button calls. It is the file to read before touching `auth.tsx`.
2. **One view at a time.** `passwordInstead` (a boolean that stacked the password form under the
   link panel) is gone. An account with a password has `accountView: "password" | "link"`, and the
   other panel unmounts in the same commit. The two quiet links are in one row with a gap, so
   "Forgot password?" and "Use an email link instead" no longer run together. `link_only` has no
   password control at all, and gained the "Use a different email" way back it never had.
3. **Password evidence, without the hash.** `20261121120000_has_password_evidence.sql` plus its
   rollback: `profiles.has_password`, backfilled from `auth.mfa_amr_claims` where
   `authentication_method = 'password'`, written only by the security definer `mark_has_password()`
   (a trigger refuses a direct client write), and a new `has_password_google` answer. Settings calls
   the function after a password is saved.
4. **Tests.** The migration suite passes, including the new evidence test and the round trip.
   Frontend: 84 files, 1120 tests, lint 0 errors, tsc 0. The unit tests encode the one-view
   invariant, the toggle, the focus moves, the detail line and the field being cleared.
5. **A local stack** (`.e2e/supabase/config.toml`, gitignored): its own project id, its own ports,
   Turnstile with the documented test pair, mail to local Mailpit, no Resend, 200 emails an hour.
   `e2e/run.sh` starts the app against it and runs the suite.
6. **The e2e suite** (`e2e/`, `playwright.config.ts`): nine cases (a, b, c, d, e, f, g, h, i), each
   at 375 px and 1280 px. It refuses any host that is not this machine, so the app cannot quietly
   talk to production, and the mailbox is read with real links opened for real.

## The finding that has to be settled before this merges

The evidence rule does not work as written. Measured on two synthetic accounts in the local stack:

```
email                          | profiles.has_password | amr claims     | auth_entry_state
new.suite.mwqkst39@example.com | false                 | password,otp   | has_password
```

GoTrue (v2.198 locally) writes `authentication_method = 'password'` into `auth.mfa_amr_claims` for a
session established by an emailed link, so "has an amr claim of password" is true for exactly the
accounts it was supposed to exclude. The accounts above never had a password set: the flag is false
and the only thing that ever signed them in is the link.

So either the amr rule is dropped and `profiles.has_password` is the only evidence (accurate from now
on, and it makes the backfill useless, which is honest: the backfill reads a record that says nothing),
or the real production GoTrue is checked on a single account we own, with the app, before trusting the
amr claim. That check is one row for one of Aman's own addresses, and it is the first thing to do.

Until it is settled, the branch is not mergeable: case (b) of the suite fails for this exact reason,
because the account from (a) answers `has_password` and is therefore shown the password view.

## Where it stands

Case (a) passes: a brand-new address, the sign-up screen, the emailed link, "Skip, take me in", the
six wizard steps, Today. The rest were being debugged when the window ran out; the current failures
are about the test harness, not about the screen:

- Each Playwright test gets a fresh context, so a session cannot carry over. The suite now re-enters
  through the link or the password at the start of each case instead of assuming the last one left
  somebody signed in. That change is in the working tree and unproven.
- `psql` does not substitute variables given with `-c`; `sql()` feeds the query on stdin.
- The iPhone preset is pinned to chromium, and the install prompt is seeded as dismissed because it
  is a modal over the buttons a person means to press.

## Next steps

1. Run `bash e2e/run.sh --project=iphone` with the stack up (`npx supabase start --workdir .e2e` with
   `DOCKER_HOST`/`DOCKER_CONFIG` set as in `e2e/run.sh`), and fix what the remaining cases report.
2. Run `bash e2e/run.sh` for both widths. Nothing merges until all of a to i pass at both.
3. Case (j), CAPTCHA off, is not written yet: it needs the stack restarted with
   `[auth.captcha] enabled = false` and `VITE_TURNSTILE_SITE_KEY` empty, so it belongs in its own run
   and its own spec file.
4. The contact sheet: screenshots of every state at 375 px, labelled, in one image under
   `~/.openclaw/workspace/outbox/`. A small Playwright page that lays the PNGs out with captions and
   screenshots itself is the cheapest way, and needs no new dependency.
5. The production smoke needs Aman to confirm which address is his main account; the repo does not
   name it. `aman_kesarwani@mfe.berkeley.edu` is the other one, and it was `link_only` before this
   branch changed the answer for every account.
6. `docs/auth-states.md` needs two corrections found while wiring the suite: `signInWithOAuth` in
   auth-js drops `captchaToken` (it is not in the query it builds), and the local stack writes the
   `magiclink` template even for a new address because confirmations are off locally.

## One operational detail about the local stack

The CLI reaches the containers through an ssh tunnel and binds the forwarded ports to every
interface, not to loopback: measured with `lsof -nP -iTCP -sTCP:LISTEN`, ports 54321, 54322 and 54324
are held by `ssh` on `*`. The stack therefore answers on the local network while it runs, and its
keys are the well-known defaults that ship with the CLI. Everything in there is synthetic, and no
production key or session was ever loaded into it, but the honest habit is to stop it when the suite
is not being run: `npx supabase stop --workdir .e2e --no-backup`.

## Not touched

Production. No migration has been pushed to the remote project, no Worker has been deployed, and no
email has been sent from anything but the local stack.