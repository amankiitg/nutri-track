# NutriTrack — your daily food guide

A mobile-first PWA that tracks calories and nutrients from a photo, a voice note, or
typed text, and tells you each day whether your intake is on track for your weight goal.

Primary input is a photo of the food; second is voice; typed text is the fallback. A
vision/text LLM parses the input into structured food items, and you always review and
edit before anything is saved.

**Stack:** React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui, TanStack Start/Router,
Supabase (auth, Postgres, storage), Recharts, and a small Express service on Render that
parses meals with Google Gemini's structured output.

---

## Prerequisites

- **Node.js 20+** and npm (npm is this repo's only package manager — there is no `bun.lock`)
- A **Supabase project** (for auth, database and storage)
- A **Google Cloud OAuth client** if you want Google sign-in
- A **Google AI Studio API key** if you want meal parsing (see below)

## Setup

```sh
npm install
cp .env.example .env   # then fill in the values
```

### Environment variables

There is one `.env`, and every name in it is documented and commented in `.env.example`.
`.env` is gitignored — never commit it.

The **prefix decides which of two consumers reads a name**:

- **`VITE_*` is read by the browser.** Vite substitutes these into the client bundle at
  build time, so a `VITE_` name must never hold a secret.
- **Everything else is read by the `server/` Node service** from `process.env` — locally
  from `.env`, in production from Render's environment panel. `server/src/config.ts`
  validates them at boot and refuses to start if one is missing.

Client-exposed:

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` — the Supabase project URL and the
  `anon` / publishable key. Both are public by design
- `VITE_SUPABASE_PROJECT_ID` — the project ref. Not read by any code, kept as the ref of
  record
- `VITE_PARSE_MEAL_URL` — where the browser POSTs a meal to be parsed. Locally
  `http://localhost:8787/parse-meal`; in production the Render service URL

Server-only. Copy exactly these into Render's environment panel:

- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` — the same values as the `VITE_` pair above.
  The publishable key is needed because PostgREST and Storage reject a request with no
  `apikey` header; it grants nothing on its own, since every request the service makes
  also carries the caller's own token
- `SUPABASE_PROJECT_ID` — the project ref. Not read by any code
- `GEMINI_API_KEY` — **the only genuine secret in the file**
- `GEMINI_VISION_MODEL` — the stable model id from AI Studio, e.g. `gemini-3.8-flash`.
  One id serves photos and text alike, because Flash is multimodal, so there is no
  separate text model to keep in step. Pin a stable version rather than a `-latest`
  alias, which gets hot-swapped underneath you
- `PORT` — local development only. Render injects its own; the default is 8787
- `ALLOWED_ORIGINS` — a comma-separated CORS allow-list. Locally `http://localhost:8080`

`SUPABASE_SERVICE_ROLE_KEY` is deliberately **absent from both `.env.example` and the
service's configuration**. The service never bypasses RLS: it verifies the caller's JWT and
uses that same token for every database and storage call, so RLS is what authorises. A key
that is never read cannot leak. (The only module that would read it,
`src/integrations/supabase/client.server.ts`, is imported by nothing.)

**Never** put a secret behind a `VITE_` prefix: Vite substitutes those values into the
client bundle at build time, so they end up readable in the browser.

### Google sign-in / email redirect URLs

The app sends OAuth and email-verification returns to `/auth/callback`. In Supabase, add
the matching URLs under **Authentication → URL Configuration → Redirect URLs**:

- `http://localhost:8080/auth/callback` (local dev — the dev server runs on port 8080)
- `https://<your-domain>/auth/callback` (each deployed environment)

Then enable **Authentication → Providers → Google** and paste in your Google client ID
and secret. Google's own console needs the Supabase callback URL
(`https://<project-ref>.supabase.co/auth/v1/callback`) as an authorised redirect URI.

### Database migrations

Migrations live in `supabase/migrations/` and are the only way the schema changes. **Never
edit an applied migration** — add a new timestamped file.

```sh
npx supabase login                       # once
npx supabase link --project-ref "$SUPABASE_PROJECT_ID"
npx supabase db push                     # apply pending migrations to the linked project

npx supabase migration new <name>        # scaffold a new empty migration
npx supabase db diff -f <name>           # or generate one from local changes
```

To work against a local stack instead, run `npx supabase start` and use
`npx supabase db reset` to replay every migration from scratch.

Every table must have Row Level Security enabled and a policy of the form
`user_id = auth.uid()`. A new table without RLS is a bug.

## Everyday commands

| Command               | What it does                                         |
| --------------------- | ---------------------------------------------------- |
| `npm run dev`         | Dev server on <http://localhost:8080>                |
| `npm run build`       | Production build (client + SSR bundle via Nitro)     |
| `npm run typecheck`   | `tsc --noEmit` — TypeScript strict mode              |
| `npm test`            | Vitest (unit + component tests, jsdom)               |
| `npm run test:server` | Vitest (node) for the `server/` service              |
| `npm run smoke`       | One real Gemini call on a real image (spends tokens) |
| `npm run sweep`       | Orphan-photo sweeper, dry run                        |
| `npm run sweep:live`  | Orphan-photo sweeper, actually deleting              |
| `npm run lint`        | ESLint                                               |
| `npm run format`      | Prettier across the repo                             |

The build targets **Cloudflare Workers** by default (Nitro's `cloudflare-module` preset,
configured in `vite.config.ts`). To self-host the SSR bundle instead, change the preset to
`node-server`.

## The parse-meal service

`server/` is a small Express service that turns photos, a transcript or typed text into
structured meal items via Google Gemini. It is a **separate npm package** with its own lockfile
and its own test suite, because Render builds it alone with `rootDir: server`.

It owns no data of its own. It verifies the Supabase access token the browser sends as a
bearer header, derives the user id from the _verified_ token — never from the request body —
and then uses that same token for every database and storage call. RLS is the only thing
authorising anything, and the service holds no key that could bypass it.
Meal parsing uses Gemini's **native structured output**. The response schema is derived
from the Zod contract in `shared/meal-parse.ts` rather than written out a second time, so
the prompt, the model's contract and the validator are one description. The reply is
validated against that contract anyway and the sanity checks (Atwater, calorie and gram
bounds) still run: a schema-constrained model is a strong guarantee, not a proof. The
single retry is kept for the cases where the model returns nothing at all — a safety
refusal or a truncated reply — which is why that branch is live rather than dead code.

```sh
cd server
npm install
npm run dev        # http://localhost:8787
npm test           # the model is mocked, so the suite cannot spend a token
npm run typecheck
npm run build      # bundles to dist/index.js with the shared contract inlined
npm start          # runs the built bundle
```

The frontend reaches it through `VITE_PARSE_MEAL_URL`.

### The orphan-photo sweeper

A capture uploads its photos **before** the meal is saved, because the model has to read them.
Anything that fails in between — a crash, a closed tab, a discard — can leave objects in
`meal-photos` that no `meals.photo_paths` names. The capture sheet cleans up after itself on
close and on cancel; this job is the backstop for the cases it cannot reach.

`server/src/sweep.ts` holds the rules, and they are two sentences:

1. **A photo a meal references is never deleted**, however old it is.
2. **An unreferenced photo is deleted only once it is provably older than the grace period**
   (24 hours). If its age cannot be established — a missing or unparseable timestamp — it is
   kept.

Both are properties of a pure function and are tested directly. It deletes through the
**Storage API**, never SQL: `protect_delete` blocks direct deletes from `storage.objects`.

This is the **only** thing in the project that reads `SUPABASE_SERVICE_ROLE_KEY`, and that is
not a convenience — it is required. The sweeper has to know which photos are still referenced
by _any_ meal, for _every_ user. Read through RLS with a user's token, that query returns one
user's meals and every other user's photos look like orphans. So the key lives in its own
config (`server/src/sweep-config.ts`) that the web service never loads, and the reference read
fails loudly rather than returning a partial answer: if it cannot be read, nothing is deleted.

```sh
npm run sweep                          # dry run: reports, deletes nothing
npm run sweep:live                     # actually delete
npm run sweep -- --older-than-hours 1  # a shorter grace period, for investigating
```

A dry run names every path it would delete, so the log is reviewable rather than a count.

### Going live with the sweeper

**The deployed job ships in dry-run mode.** The Render cron job runs `node dist/sweep.js` with
no `--live`, and `SWEEP_DRY_RUN` defaults to `true`, so it reports and deletes nothing.

Once a dry run's log looks right — the paths it names are genuinely abandoned uploads, and no
path belonging to a saved meal appears — flip it:

1. Render dashboard → the `nutritrack-sweep-orphan-photos` service → **Environment**.
2. Change `SWEEP_DRY_RUN` from `true` to `false`. Save; Render restarts the service.
3. Nothing else. The next scheduled run deletes.

No commit, no redeploy and no blueprint change are needed, because the switch is an environment
value. `--dry-run` on the command line still overrides it back, and locally `npm run sweep`
is a dry run whatever `.env` says, since the command line outranks the environment.

An unrecognised `SWEEP_DRY_RUN` value (a typo, say) stops the job with a non-zero exit rather
than guessing. That direction is deliberate: guessing "true" leaves a few wasted megabytes,
guessing "false" deletes photos.

### Deploying to Render

`render.yaml` is a Render Blueprint describing the whole service. In the dashboard choose
**New → Blueprint**, pick this repository, and Render reads these settings from the file:

| Setting           | Value                     |
| ----------------- | ------------------------- |
| Root directory    | `server`                  |
| Build command     | `npm ci && npm run build` |
| Start command     | `npm start`               |
| Health check path | `/health`                 |

On the first deploy Render prompts for every variable marked `sync: false` — copy the
server-only block out of `.env.example` (or `.env`) into the panel. Set `ALLOWED_ORIGINS`
to the origin the frontend is actually served from, and point `VITE_PARSE_MEAL_URL` at the
deployed service URL.

Only `server/` is uploaded: `shared/meal-parse.ts` is compiled into the bundle at build
time, so nothing outside `rootDir` is needed at runtime. Anything outside `ALLOWED_ORIGINS`
is refused by CORS before a handler runs.

`render.yaml` also declares the sweeper as a second service, which is **not** a web service:

| Setting        | Value                     |
| -------------- | ------------------------- |
| Type           | `cron`                    |
| Root directory | `server`                  |
| Build command  | `npm ci && npm run build` |
| Command        | `node dist/sweep.js`      |
| Schedule       | `0 4 * * *` (04:00 UTC)   |

It shares the build with the web service — `npm run build` emits both `dist/index.js` and
`dist/sweep.js` — so the two cannot drift apart, and a broken build fails both. The schedule is
in UTC and nothing depends on the hour: the grace period, not the timing, is what protects a
capture in progress. It needs `SUPABASE_SERVICE_ROLE_KEY` and `SWEEP_DRY_RUN`; the web service
must never be given the former. See [Going live with the sweeper](#going-live-with-the-sweeper).

Gemini is configured entirely through these two names, so swapping models never needs a
code change:

| Variable              | Purpose                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GEMINI_API_KEY`      | Google AI Studio API key. Must never appear under `src/` or `shared/`                                                                                       |
| `GEMINI_VISION_MODEL` | Stable model id from AI Studio, e.g. `gemini-3.8-flash`. Multimodal, so it serves photos and text alike; pin a stable version rather than a `-latest` alias |

All model traffic goes through the service. The key must never reach the browser, and
never appears under `src/` or `shared/`.

## Project layout

```
src/                           The browser app
  routes/                      TanStack Router file-based routes
    _authenticated/            Session-gated shell (today, trends, settings)
    auth.tsx                   Sign in / sign up
    auth_.callback.tsx         OAuth + email-verification return handler
    onboarding.tsx             First-run wizard
  components/
    onboarding/                Wizard, field components and settings form
    ui/                        shadcn/ui primitives
  lib/
    targets.ts                 BMR/TDEE/macro maths (pure, unit-tested)
    dashboard.ts               Today's RPC calls and its presentation logic
    profile.ts                 Profile + target persistence
    onboarding.ts              Form state, Zod validation, draft persistence
  integrations/supabase/       Supabase clients (browser, server, auth middleware)

shared/meal-parse.ts           The parse-meal contract: prompt, Zod schemas, sanity
                               checks, meal fingerprint. Imported by the browser as
                               @shared/* and by the service relatively. Must stay free
                               of browser- and Node-only APIs, since both run it.

server/                        The parse-meal service (Express 5, deployed to Render)
  src/config.ts                Zod-validated process.env, checked at boot
  src/app.ts                   Routes, CORS, error handling
  src/parse-meal.ts            Rate limit, prompt assembly, the single retry
  src/llm.ts                   The provider-neutral model interface
  src/gemini.ts                The Gemini client: structured output, inline images
  src/response-schema.ts       Derives the response schema from the Zod contract
  src/caller-store.ts          Every Supabase read and write, scoped to the caller
  src/sweep.ts                 Orphan-photo sweep rules (pure), store and planner
  src/sweep-config.ts          The sweeper's own config: the service role key, and
                               nothing the web service ever loads
  scripts/sweep-orphan-photos.ts  The cron entry point
  scripts/smoke-gemini.ts      One real model call, run by hand

supabase/migrations/           Postgres schema, RLS, views and the dashboard functions
```

### The Today dashboard

A calorie ring, macro bars, a trailing-7-day verdict and the day's meal timeline with
swipe-to-delete and undo, plus a quick weight entry.

**Every number comes from a Postgres function**, not from the browser. A "day" is a day in
the _profile's_ timezone, and the trailing window has to include the days on which nothing
was logged — which is exactly what summing "the rows that came back" gets wrong. The
functions read `daily_summaries` and keep RLS in force (`security invoker`):

| Function                    | Returns                                                        |
| --------------------------- | -------------------------------------------------------------- |
| `daily_totals(date)`        | Today's totals, target, remaining and status                   |
| `trailing_days(date, days)` | One row per day in the window, including empty ones            |
| `week_verdict(date, days)`  | One row: the averages and the verdict                          |
| `meals_for_day(date)`       | The day's meals with their items and per-meal totals, as jsonb |

Two things about it are deliberate and easy to mistake for bugs:

- **An unlogged day has a null `status`**, not `under`. `calorie_status(0, target)` is
  "under" by arithmetic and a lie in English.
- **The verdict only averages days that have both a meal and a target.** Averaging intake
  over days-with-food against a target averaged over days-with-a-target mixes two different
  spans, and on a new account that produced a confident `on_track` from four days of food
  and one day of target. `days_judged` is reported separately from `days_logged` so the
  sentence can be honest about its own sample, and too small a sample says so.

Deleting from the timeline is a **soft delete** (`meals.deleted_at`), which is what makes
undo possible and what takes the meal out of every total, since `daily_summaries` filters
on it. The photos are deliberately kept: the row still names them, so the sweeper leaves
them alone. See the note in AGENTS.md — a deleted meal's photos persist indefinitely.

### Body measurements

The quick-entry card on Today records weight, and a waist when one was measured. Waist is
optional and its field is deliberately **not** prefilled with the last value, unlike
weight: a stale number sitting in the box is one accidental Save away from being recorded
as today's measurement.

Both are stored canonically — kilograms and centimetres — and converted only for display
using the helpers in `src/lib/units.ts`. `weight_log.waist_cm` is nullable and stays
nullable; a missing measurement must never read as zero.

Recording a weight updates `profiles.weight_kg`, which is the value the next BMR/TDEE
calculation starts from. It does **not** rewrite today's calorie target — see the note in
`src/routes/_authenticated/today.tsx`.

Only `units` in `profiles` is unit-dependent. Everything the user measures is stored
canonically, so switching between metric and imperial reinterprets nothing. Verified: after
a round trip through both settings, `height_cm`, `weight_kg`, `target_weight_kg`,
`pace_kg_per_week` and the computed `targets` row were all bit-identical.

### The Trends screen

A Week / Month / Year segmented control, a date navigator, daily calorie bars with the
target drawn across them, a macro donut and a stacked macro bar over time, a weight line
with its 7-day rolling average and waist as a second series, and four stat tiles.

**All aggregation is in Postgres**, over the same day spine as the dashboard:

| Function                         | Returns                                                          |
| -------------------------------- | ---------------------------------------------------------------- |
| `get_period_summary(start, end)` | One row per day in the range plus the period's totals, as jsonb  |
| `get_weight_series(start, end)`  | The weigh-ins in the range, each with its trailing 7-day average |

Three things about it are deliberate:

- **The current period is clamped to today.** Asking for the rest of September would return
  a zero row per future day and drag every average towards zero. The label still names the
  whole calendar period.
- **Macros are in calories, not grams, in both charts.** A gram of fat is 2.25 times the
  energy of a gram of carbohydrate, so a donut of grams would compare things that are not
  comparable. The conversion happens in Postgres so both charts share one basis.
- **The averages cover only days that have both food and a target.** `days_judged` is
  reported separately from `days_logged`, so a period that predates the user's first target
  is described honestly rather than averaged into something misleading.

Dates cross this boundary as `YYYY-MM-DD` strings, never as `Date` objects. The period
label is rendered with `Intl` rather than date-fns, because date-fns gives "Sep" where the
rest of the app shows "Sept".

## Conventions

- One logical change per commit, e.g. `feat(parse-meal): ...` or `fix(dedupe): ...`
- TypeScript strict mode; no `any` in new code; validate every external payload with Zod
- One `.env` for every variable; secrets are server-only and never carry a `VITE_` prefix
- The parse-meal service never uses the service role key — it forwards the caller's JWT
- The orphan-photo sweeper is the one place `SUPABASE_SERVICE_ROLE_KEY` is read, from its own
  config, because it must see every user's meals to know which photos are referenced
- Row Level Security on every table, policy `user_id = auth.uid()`
- Aggregations belong in Postgres, not in the browser
- Day boundaries are resolved in the profile's timezone, never the device's
