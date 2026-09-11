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
npm run lint
npm run format
```

`server/scripts/smoke-gemini.ts` spends real tokens and `server/src/sweep.ts` deletes real
photos. Neither is ever collected by a test suite. Keep it that way: the model in the suite is
a fake, and the sweeper's tests run against a fake store.

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
- That converter identifies Zod types by `_def.typeName`, not `instanceof`: the two zod
  installs in this repo (root for `shared/`, `server/` for the service) are different copies
  and `instanceof` is false across them.
- Aggregations belong in Postgres, not in the browser.
- Deployment is documented in README.md, "Deploying to production": two Render services
  from `render.yaml` and one frontend host. The `VITE_*` values are inlined at build time,
  so the frontend host needs them in its _build_ environment — a stale
  `VITE_PARSE_MEAL_URL` there is the only way a localhost value can reach production.
- The build targets Cloudflare Workers via Nitro's `cloudflare-module` preset
  (`vite.config.ts`); switch to `node-server` to self-host the SSR bundle.
