# Agent notes for NutriTrack

Mobile-first PWA for tracking calories and nutrients for two users, extending to friends
later. React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui, TanStack Start/Router,
Supabase, Recharts.

## How to work here

1. **Read before you write.** Never rewrite a file that already works; make the smallest
   change that satisfies the requirement.
2. **One logical change per commit**, message in the form `feat(parse-meal): ...` or
   `fix(dedupe): ...`. Keep the branch in a working state: build, typecheck and tests green.
3. **Schema changes are always a new timestamped migration** under `supabase/migrations/`.
   Never edit an application migration.
4. **Secrets stay server-side.** The Gemini key must never appear in any file under
   `src/` or `shared/`. If you find it there, that is a P0 bug — flag it and fix it first.
   Nothing secret may carry a `VITE_` prefix; Vite inlines those into the browser bundle.
   Server-only names live in `.env` locally and in Render's environment panel in
   production — one file, one place to look. `SUPABASE_SERVICE_ROLE_KEY` is not read by the
   parse-meal service at all; it forwards the caller's JWT instead. Exactly one thing reads
   it: the orphan-photo sweeper (`server/src/sweep.ts`, scheduled by the `type: cron`
   service in `render.yaml`), which needs it because it must see every user's meals to know
   which photos are still referenced. It reads it from `server/src/sweep-config.ts`, which
   the web service never loads. Never add that key to `server/src/config.ts`.

   `.env` has a **third** reader: the local invite tool in `tools/invite/`, which is the only
   thing that reads `GMAIL_ADDRESS` and `GMAIL_APP_PASSWORD`. It runs on a laptop, is part of no
   deployed service, and creates a Gmail _draft_ rather than sending. It is a small page on
   <http://127.0.0.1:8788> — two boxes and a button — because the credential is a password to a
   mailbox and never leaves the machine: `src/server.ts` binds to `127.0.0.1` and not `0.0.0.0`
   for the same reason. Its credential must never be printed, logged, or put in an error message
   — `tools/invite/src/redact.ts` exists for that and has the tests to match — which includes
   `imapflow`'s unhandled `error` event, an uncaught exception that prints a stack.

   The **deployed service** holds a separate Gmail credential, so an admin can invite someone from
   the admin page on a phone: `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`,
   `GMAIL_OAUTH_REFRESH_TOKEN` and `INVITE_SENDER_ADDRESS`, declared in `server/src/config.ts` and
   read only by `server/src/gmail.ts`. An OAuth refresh token rather than an app password, because
   this one lives on Render: revocable on its own, scoped, and attributed to a named app in the
   account's third-party access list. `GMAIL_COMPOSE_SCOPE` is a **restricted** scope, which for a
   public app would mean Google's verification plus an annual security assessment; this app is
   personal use under Google's under-100-users exemption, so it needs neither and the reader
   clicks through one unverified-app screen. Passing 100 users would change that. `POST /invite`
   **creates a draft and can never send**: the only Gmail endpoint in that file is `drafts.create`,
   and `server/test/gmail.test.ts` reads the source and fails if a send path is ever named in it,
   including in a comment. The invite body itself is `shared/invite-email.ts`, which `tools/invite`
   imports too, so there is one copy of what an invite says. Adding the address and drafting the
   email are one request, drafted first, so a failure grants nobody access.

5. **Row Level Security on every table**, policy `user_id = auth.uid()`. A new table without
   RLS is a bug.
6. **TypeScript strict mode.** No `any` in new code. Validate every external payload with
   Zod — including anything a model returns.
7. **If a requirement conflicts with existing code, stop and ask** rather than guessing.

## Commands

```sh
npm run dev          # frontend on http://localhost:8080
npm run build        # client + SSR bundle
npm run typecheck    # tsc --noEmit
npm test             # vitest (jsdom) — frontend and the shared module
npm run test:server  # vitest (node) — the parse-meal service
npm run smoke        # one real Gemini call on a real image; spends tokens, run by hand
npm run sweep        # orphan-photo sweeper, dry run — deletes nothing
npm run sweep:live   # the same, actually deleting
npm run invite       # local only: creates a Gmail draft of the invite; never sends
npm run test:invite  # the invite tool's own tests (node:test)
npm run lint
npm run format
```

`server/scripts/smoke-gemini.ts` spends real tokens and `server/src/sweep.ts` deletes real
photos. Neither is ever collected by a test suite. Keep it that way: the model in the suite is
a fake, and the sweeper's tests run against a fake store.

`tools/invite/` is in the same category for the same reason: it talks to a real mailbox, so its
tests build a message and stop — nothing in the suite opens a connection, and nothing reads a
credential. The invite itself lives in `tools/invite/src/invite.ts` and nowhere else;
`docs/invite-email.html` is generated from it by `npm run invite:preview` and is not edited by
hand, because two copies of an email drift and the copy that drifts is the one you send.

The service in `server/` is its own package, so run its scripts from there:

```sh
cd server
npm run dev    # service on http://localhost:8787
npm run build  # bundle to dist/index.js
npm start      # run the built bundle
npm test
```

## Known issues

- **`/auth` hydration mismatch (dev only).** Arriving at `/auth` via the redirect from a
  guarded route (`/onboarding`, `/today`, `/settings`, `/trends` while signed out) logs
  `Hydration failed because the server rendered HTML didn't match the client` — the server
  emitted the Suspense fallback where the client emitted the page. React recovers, the page
  renders correctly, and a direct load of `/auth` is clean. Revisit when the Wrangler
  preview is set up, to confirm whether it also occurs in a production build.
- **A height box that would not accept typing on a metric profile (unexplained).**
  Reported once: a metric height showing `160` where typing produced nothing usable, and
  what was typed cleared itself. Not reproducible on the metric path in any sequence tried
  — per-keypress, blur, and a change batched with a blur — and the reporter later said they
  could not reproduce it either and may have misremembered which unit they were on. A real
  and severe bug **was** found and fixed in the imperial pair around the same time: each
  box refused to commit unless its sibling was already committed, so an emptied box could
  never be written again. That is the likely cause, and it was never confirmed against the
  original report. **If this reappears on a metric profile, it is new.** Start in
  `src/components/onboarding/fields.tsx`; the imperial tests in `fields.test.tsx` show the
  shape of the coverage that did not catch it.

## Known characteristics (not bugs, do not "fix" without evidence)

- **Item granularity varies between runs on identical input.** The model runs at
  temperature 0.2, not 0, so the same photo can come back as five items one time and six the
  next — a salad split into "cucumber and tomato salad" plus "fresh arugula", say. Totals stay
  sane; the item _boundaries_ move. This is why day-over-day comparisons can look noisier than
  the underlying numbers. Left as is deliberately: it is a consequence of wanting a model that
  reads a plate rather than a lookup table. Do not chase it with prompt changes.
- **Portion estimates for calorie-dense components are the weakest part of a parse.**
  Identification is consistently good; grams are guesses from a photo. Hummus is the worst
  case found so far — a dip-sized ~50 g estimate on a bowl that plausibly holds 2–3× that,
  which moves a meal total by 150+ kcal. The same relative error on a salad moves it by ~35.
  The review screen is the mitigation: that is what it is for. Do not tune the prompt to a
  single photo.
- **A deleted meal keeps its photos, indefinitely.** The timeline's delete is a soft delete
  (`meals.deleted_at`), because the undo has to be able to put the meal back, so the row
  keeps naming its photos and the sweeper therefore never touches them. Delete then delete
  again is the only way to lose them. Accepted knowingly: the alternative is an undo that
  cannot work, or a retention rule that hard-deletes soft-deleted meals after N days. If
  photo storage ever becomes a problem, that retention rule is the fix, not a change to
  what the sweeper protects.

## Layout and conventions

- `src/routes/` — TanStack Router file-based routes. `_authenticated/` is the session-gated
  shell; `auth_.callback.tsx` is the OAuth return handler (the trailing `_` keeps it from
  nesting under `auth.tsx`, which would otherwise need to render an `<Outlet />`).
- `src/lib/targets.ts` — all BMR/TDEE/macro maths. Pure functions, unit-tested against a
  worked example. Do not reimplement this maths anywhere else.
- `src/lib/dashboard.ts` — the Today dashboard's RPC calls and the pure presentation logic
  behind the ring, the macro bars and the verdict sentence. It sums nothing: every total,
  average and count comes from a Postgres function over `daily_summaries`, because a day is
  a day in the profile's timezone and a trailing window has to include the days with no
  meals. Those functions are in `20260911160000_today_dashboard_functions.sql` and
  `20260911161000_dashboard_verdict_and_empty_days.sql`. `daily_totals` and `trailing_days`
  return a null `status` for a day with nothing logged: an unlogged day is unknown, not
  "under".
- `src/lib/trends.ts` — the Trends screen: which dates to ask about, and how to say them.
  `get_period_summary` and `get_weight_series` (`20260911180000`, `20260911181000`) do all
  the aggregation, over the same `trailing_days` day spine the dashboard uses. Dates cross
  this boundary as `YYYY-MM-DD` strings and never as `Date` objects — an instant formatted
  in one zone and parsed in another is a different day. Labels are rendered with `Intl`
  en-GB, not date-fns, because date-fns gives "Sep" where the rest of the app shows "Sept".
- Charts use Recharts directly. **A `Line` inside a `BarChart` typechecks and is silently
  not drawn**; mixing bars with a line needs `ComposedChart`. This shipped broken for one
  round of review because the target line simply did not appear.
- `src/components/onboarding/steps.tsx` — the question groups, shared by the onboarding
  wizard and the settings form. Change them in one place.
- `shared/meal-parse.ts` — the parse-meal contract: the prompt, the Zod schemas the model's
  reply is validated against, the sanity checks and the meal fingerprint. Imported by the
  browser as `@shared/*` and by the service as `../../shared/meal-parse`. It must stay free
  of browser and Node-only APIs, because both runtimes execute it.
- `server/` — the `parse-meal` Node service (Express 5) deployed to Render. A separate npm
  package with its own lockfile, because Render builds it alone with `rootDir: server`.
  It owns no data of its own: it verifies the caller's Supabase JWT and then talks to
  Supabase and Gemini with that same token, so RLS does the authorising.
- `server/src/sweep.ts` — the orphan-photo sweeper, and the only reader of
  `SUPABASE_SERVICE_ROLE_KEY`. Two rules, both in the pure `planSweep`: a referenced photo is
  never deleted, and an unreferenced one is deleted only when it is provably older than the
  24-hour grace period. An unknown age counts as unknown, never as old. It deletes through the
  Storage API because `protect_delete` blocks direct SQL deletes. It ships in dry-run mode;
  `SWEEP_DRY_RUN=false` is the single switch, and a typo in that value stops the job rather
  than guessing.
- The model call sits behind `server/src/llm.ts`, with Gemini as the only implementation.
  The image travels as raw bytes, not as a data URL, so the provider — not the caller —
  decides the wire encoding. Gemini's response schema is derived from the Zod contract by
  `server/src/response-schema.ts`; never hand-write a second copy of the field list, in the
  prompt or anywhere else.
- Everything the service says to the user is read on a phone, so
  `ApiError.message` is written for that reader: no provider names, no status codes, no
  Supabase internals. The technical detail belongs in `details` and in the logs, which is
  what `UPSTREAM_MESSAGES` and `SUPABASE_FAILURE_MESSAGE` are for. The daily limit is
  defined once, in `shared/meal-parse.ts`, because the service that enforces it, the
  `llm_call_budget()` function that reports it and the Settings card that shows it all
  need the same number.
- **A model refusal is not retried, deliberately.** `finishReason` of SAFETY, RECITATION,
  BLOCKLIST, PROHIBITED_CONTENT, SPII or IMAGE_SAFETY means the model declined, and
  asking again produces the same refusal: retrying costs the user a second call out of
  their sixty to reach the same place. It also gets its own message, because the ordinary
  advice — "add a short note about what it was" — describes a note that would be refused
  for exactly the same reason. Do not collapse the two back into one retry.
- That converter identifies Zod types by `_def.typeName`, not `instanceof`: the two zod
  installs in this repo (root for `shared/`, `server/` for the service) are different copies
  and `instanceof` is false across them.
- Aggregations belong in Postgres, not in the browser.
- The Cloudflare build is Nitro's `cloudflare-module` preset. **Do not hand-write a
  wrangler config**: the preset generates `.output/server/wrangler.json` (`main`, the
  `ASSETS` binding, `nodejs_compat`, `no_bundle`, ESM rules) plus
  `.wrangler/deploy/config.json`, which is what makes a bare `wrangler deploy` from the
  root work. Nitro ignores a hand-set `main` or `assets` with a warning, so the only
  field worth configuring is the Worker name, pinned in `vite.config.ts` — unpinned it is
  derived from the git remote, and that name sets the Worker's own `*.workers.dev`
  hostname. The canonical origin is the custom domain, `https://tracknutri.app`, attached
  to the script in Cloudflare's dashboard rather than in this repository; the
  `*.workers.dev` hostname still works and is allow-listed alongside it. The name stays
  pinned because a custom domain is attached to a script _name_: renaming the Worker would
  leave the domain pointing at a script that no longer receives deploys.
- `VITE_*` values are inlined at build time, so `npm run build:cloudflare` supplies the
  production `VITE_PARSE_MEAL_URL` inline and `.env` keeps the localhost one for dev.
  `vite.config.ts` fails a production build with a missing, localhost or non-https
  parse-meal URL: nothing downstream can detect that afterwards.
- `src/lib/admin.ts` — the admin page. Two rules. **An invite address is normalised to
  `lower(trim(email))` before it is stored**, in the browser and again by a trigger on
  `allowed_emails`, because an invite that looks added and can never match is worse than
  no invite. And **`invite_requests` is the only write an uninvited person can cause**:
  the row's address comes from the `email` claim of their signed JWT, not from the
  request body, one row per address is enforced by a unique index, and a trigger skips
  repeats. Do not add an email to that body, and do not give `authenticated` an update or
  delete policy on the table.
- `src/lib/calls.ts` — the meal-analysis budget for the signed-in user; the admin page
  reads everyone's from `admin_spend()`, which shares `local_day_start()` with
  `llm_call_budget()` so there is one day-boundary rule and not two.
- Deployment is documented in README.md, "Deploying to production": two Render services
  from `render.yaml` and a Cloudflare Worker for the frontend.
- The build targets Cloudflare Workers via Nitro's `cloudflare-module` preset
  (`vite.config.ts`); switch to `node-server` to self-host the SSR bundle.
