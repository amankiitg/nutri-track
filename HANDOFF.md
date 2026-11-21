# Handoff: the /auth states task

Branch `task/auth-states-e2e`. No PR yet: the rule for this task is that the matrix passes first.

## Decided, and done

**Option A.** The amr claim is gone. `profiles.has_password` is the only evidence, and three moments
set it: Settings after `updateUser({ password })`, the reset screen after the same call, and any
successful password sign-in (the self heal). Nothing is backfilled. `20261121120000_has_password_evidence.sql`
holds the column, the recorder, the guard and the flag-only `auth_entry_state`; its rollback restores
the previous function.

**That migration is already applied to production**, confirmed by `supabase migration list --remote`
(`20261121120000 | 20261121120000`). It is additive and safe before the Worker ships: no profile has
the flag set, and nothing could set it until the new client is live, so the answer for every account
is the one it already had. **The Worker has not been deployed.**

The screen: one view at a time (`accountView: password | link`, the other panel unmounts in the same
commit), `link_only` has no password control at all, gained the "Use a different email" way back it
was missing, and the two quiet links sit in one row so they no longer run together.

## Verified

- migration suite PASS, including the new evidence test (a hash is not evidence, an amr claim is not,
  and clearing the flag puts the account back on the link) and the round trip
- frontend 1121 tests in 84 files, lint 0 errors (6 pre-existing warnings), `tsc --noEmit` 0,
  `tsc -p e2e --noEmit` 0
- e2e case **a passes** (new address, sign-up screen, link out of the local inbox, six wizard steps,
  Today) and case **b passes** (the same account sees only the link, and the link signs it in), both
  at 375 px

## Where it stopped: case (c), and a real finding

Case (c) fails on a defect the matrix was written to catch, not on the harness:

```
console: [auth] captcha protection: request disallowed (no captcha_token found)
```

The wrong-password attempt went out with no Turnstile token, GoTrue refused it for that reason, and
the screen therefore showed a captcha failure where the test expected the invalid-credentials
sentence and its detail line. In production the same thing would say "something went wrong" instead
of "wrong password", and the person would never learn that the password was the problem.

`turnstile-token.ts` already documents the shape of this: `ensure()` waits a bounded time and then
sends without a token, deliberately, because a missing token must not block a sign-in the server
might accept. That trade is wrong when CAPTCHA is on and the server will refuse: the honest options
are to wait longer, to press the widget again, or to say "one more second" rather than sending a
request that cannot succeed. That decision needs a person, so it is not taken here.

## Next steps

1. Decide what `ensure()` should do when CAPTCHA is on and no token arrives (block with a message, or
   retry the widget once), then finish case (c), (d), (f), (g), (h), (i) and add (j) CAPTCHA off,
   which needs the stack restarted with `[auth.captcha] enabled = false` and no site key.
2. Contact sheet: every state at 375 px, labelled, one image in
   `~/.openclaw/workspace/outbox/`. A small Playwright page that lays the PNGs out with captions and
   screenshots itself is the cheapest way and needs no new dependency.
3. CI job: `npm run test:e2e` needs a stack in the runner. `PW_CHANNEL` must be unset there so the
   bundled chromium is used, and `npx playwright install --with-deps chromium` runs first.
4. Then the Worker deploy (`npm run deploy`, after the merge), then the production smoke for
   `aman_kesarwani@mfe.berkeley.edu` and `amank.iitg@gmail.com` at 375 px: screenshots only, no
   emails, no sign-ins.
5. Delete this file when the task is done.

## Harness lessons, already in the code

- `psql` does not substitute variables given with `-c`; `sql()` feeds the query on stdin.
- `getByLabel("Password")` matches two elements, because the reveal button is labelled "Show
  password". Use `{ exact: true }`.
- The iPhone preset carries webkit and is pinned to chromium; the install prompt is seeded as
  dismissed, since it is a modal over the buttons a person means to press.
- `e2e/run.sh` resets the local database on every run. Without it the suite passes against a function
  body that has since been edited, which is exactly what happened once.
- `askState` presses Continue twice at most: a client side navigation can still be settling when the
  address is typed, and the first press is lost without an error. Two failed presses throw.

## Not touched

No Worker deployment, no emails from anything but the local stack, and nothing pushed to `main`.