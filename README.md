# NutriTrack: your daily food guide

A mobile-first PWA that tracks calories and nutrients from a photo, a voice note, or
typed text, and tells you each day whether your intake is on track for your weight goal.

Primary input is a photo of the food; second is voice; typed text is the fallback. A
vision/text LLM parses the input into structured food items, and you always review and
edit before anything is saved.

**Running at <https://tracknutri.app>.** Sign-in is invite-only, so a visitor meets the sign-in
screen rather than a dashboard; <https://tracknutri.app/privacy> is readable without an account.

**Stack:** React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui, TanStack Start/Router,
Supabase (auth, Postgres, storage), Recharts, and a small Express service on Render that
parses meals with Google Gemini's structured output.

**Free trial:** a signed-out visitor can try 10 meal scans at https://tracknutri.app/try
without an account. The landing page's demo media tries public/demo/meal-demo.mp4, then
public/demo/meal-demo.gif, then the placeholder SVG. Replace public/demo/meal-demo.gif
(or add public/demo/meal-demo.mp4) and deploy.

---

## Prerequisites

- **Node.js 20+** and npm (npm is this repo's only package manager; there is no `bun.lock`)
- A **Supabase project** (for auth, database and storage)
- A **Google Cloud OAuth client** if you want Google sign-in
- A **Google AI Studio API key** if you want meal parsing (see below)

## Setup

```sh
npm install
cp .env.example .env   # then fill in the values
```

### Environment variables

There is **one** `.env`, and every name in it is documented and commented in `.env.example`.
`.env` is gitignored. Never commit it.

There are **three** consumers of it, and the prefix is the thing to look at, because it decides how
far a value travels:

- **`VITE_*` is read by the browser.** Vite substitutes these into the client bundle at
  build time, so a `VITE_` name must never hold a secret.
- **Everything else is read by the `server/` Node service** from `process.env`: locally
  from `.env`, in production from Render's environment panel. `server/src/config.ts`
  validates them at boot and refuses to start if one is missing.
- **Two Gmail names are read only by the local invite tool** in `tools/invite`, which runs on a
  laptop, is part of no deployed service, and creates a draft rather than sending. It is the one
  consumer that is not a deploy target, which is why its credential has its own block in
  `.env.example` rather than sharing the server's.

Client-exposed:

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`: the Supabase project URL and the
  `anon` / publishable key. Both are public by design
- `VITE_SUPABASE_PROJECT_ID`: the project ref. Not read by any code, kept as the ref of
  record
- `VITE_PARSE_MEAL_URL`: where the browser POSTs a meal to be parsed. Locally
  `http://localhost:8787/parse-meal`; in production the Render service URL
- `VITE_TURNSTILE_SITE_KEY`: the Cloudflare Turnstile site key for the free trial at
  `/try`. Public by design; the secret lives server-side. Without it `/try` answers
  "Trial unavailable right now"

Server-only. Copy exactly these into Render's environment panel:

- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`: the same values as the `VITE_` pair above.
  The publishable key is needed because PostgREST and Storage reject a request with no
  `apikey` header; it grants nothing on its own, since every request the service makes
  also carries the caller's own token
- `SUPABASE_PROJECT_ID`: the project ref. Not read by any code
- `GEMINI_API_KEY`: **the only genuine secret in the file**
- `GEMINI_VISION_MODEL`: the stable model id from AI Studio, e.g. `gemini-3.8-flash`.
  One id serves photos and text alike, because Flash is multimodal, so there is no
  separate text model to keep in step. Pin a stable version rather than a `-latest`
  alias, which gets hot-swapped underneath you
- `TEXT_THINKING_BUDGET`: optional, and normally left out. A token budget for text-only
  analyses: unset means the model's own minimum, which for a Gemini 3 model is the `low`
  level rather than a token count, so setting it sends that number of thoughts tokens
  instead. Photo analyses keep the model's default either way, because reading the plate
  is the part worth the tokens
- `PORT`: local development only. Render injects its own; the default is 8787
- `ALLOWED_ORIGINS`: a comma-separated CORS allow-list. Locally `http://localhost:8080`

`SUPABASE_SERVICE_ROLE_KEY` is deliberately **absent from the parse-meal service's
configuration**. That service never bypasses RLS: it verifies the caller's JWT and uses that
same token for every database and storage call, so RLS is what authorises. A key it never reads
cannot leak from it. (The one module in the frontend that would read it,
`src/integrations/supabase/client.server.ts`, is imported by nothing.)

It **is** in `.env.example`, in its own `--- Sweeper-only ---` block, because the orphan-photo
sweeper genuinely needs it. See [the sweeper](#the-orphan-photo-sweeper). One credential, one
reader, in its own config file, so that "is this key in play on this service?" is answered by a
file rather than by a guess.

**Never** put a secret behind a `VITE_` prefix: Vite substitutes those values into the
client bundle at build time, so they end up readable in the browser.

### Google sign-in / email redirect URLs

The app sends OAuth and email-verification returns to `/auth/callback`. In Supabase, add
the matching URLs under **Authentication → URL Configuration → Redirect URLs**:

- `http://localhost:8080/auth/callback` (local dev; the dev server runs on port 8080)
- `https://<your-domain>/auth/callback` (each deployed environment)

Then enable **Authentication → Providers → Google** and paste in your Google client ID
and secret. Google's own console needs the Supabase callback URL
(`https://<project-ref>.supabase.co/auth/v1/callback`) as an authorised redirect URI.

### Email delivery before inviting anyone

Supabase's **default SMTP server only delivers to members of the project team**, and it is heavily
rate limited. That is fine while the only account is yours: your own verification email arrives and
nobody else is waiting for one. It stops being fine the moment a real person is invited, because
their verification link is never sent, and the sign-up screen cannot tell them that — it reports
what Supabase reported, which is success.

Configure custom SMTP before inviting anyone: **Authentication → Emails → SMTP Settings**, with
Resend, Postmark, SES or any other provider, and set the sender name and address. Then send
yourself a verification email through the real form and confirm it arrives from the new sender
before telling somebody else to sign up.

### Database migrations

Migrations live in `supabase/migrations/` and are the only way the schema changes. **Never
edit an applied migration**. Add a new timestamped file.

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

**A migration that creates a table also grants on it, beside its policies**, because a grant and a
policy are different things and both are required. The grant says a role may touch the table at
all; the policy says which rows it may touch. A policy on a table no role may touch is never
consulted (PostgREST answers `permission denied for table meals` and the policy is not reached),
so RLS does **not** cover this, and it is easy to assume it does. It was invisible until recently
because the platform granted `all` on every new table in `public` to `anon`, `authenticated` and
`service_role` for you, and **Supabase withdraws that default on 2026-10-30**: from then on, the
migration is the only thing that makes a table reachable.

`20260924120000_explicit_grants_for_the_data_api.sql` states the grants for every table that
exists and is the list to copy: `authenticated` gets only the verbs the app uses, `service_role`
gets `all` because the sweeper is not RLS-scoped, and `anon` gets nothing, since every route needs
a session. `20260924150000_revoke_anon_table_access.sql` then removed what the default had already
granted `anon`. It keeps `USAGE` on the schema and `EXECUTE` on `check_email_allowed`, which is
`security definer`, so the sign-in screen's "is this address invited?" needs no privilege on
`allowed_emails` from the person asking.

## Everyday commands

| Command                      | What it does                                                      |
| ---------------------------- | ----------------------------------------------------------------- |
| `npm run dev`                | Dev server on <http://localhost:8080>                             |
| `npm run build`              | Production build (client + SSR bundle via Nitro)                  |
| `npm run build:cloudflare`   | Production build with the deployed parse-meal URL                 |
| `npm run deploy`             | Build for production, then `wrangler deploy`                      |
| `npm run preview:cloudflare` | Serve the built Worker locally under workerd                      |
| `npm run typecheck`          | `tsc --noEmit`: TypeScript strict mode                            |
| `npm test`                   | Vitest (unit + component tests, jsdom)                            |
| `npm run test:server`        | Vitest (node) for the `server/` service                           |
| `npm run test:invite`        | The invite tool's own tests (node:test)                           |
| `npm run invite`             | Local only: creates a Gmail draft of the invite, never sends      |
| `npm run invite:check`       | Reports whether the mailbox credential works, and creates nothing |
| `npm run invite:preview`     | Regenerates `docs/invite-email.html` from the invite source       |
| `npm run smoke`              | One real Gemini call on a real image (spends tokens)              |
| `npm run sweep`              | Orphan-photo sweeper, dry run                                     |
| `npm run sweep:live`         | Orphan-photo sweeper, actually deleting                           |
| `npm run lint`               | ESLint                                                            |
| `npm run format`             | Prettier across the repo                                          |

The build targets **Cloudflare Workers** by default (Nitro's `cloudflare-module` preset,
configured in `vite.config.ts`). To self-host the SSR bundle instead, change the preset to
`node-server`.

## The parse-meal service

`server/` is a small Express service that turns photos, a transcript or typed text into
structured meal items via Google Gemini. It is a **separate npm package** with its own lockfile
and its own test suite, because Render builds it alone with `rootDir: server`.

It owns no data of its own. It verifies the Supabase access token the browser sends as a
bearer header, derives the user id from the _verified_ token, never from the request body,
and then uses that same token for every database and storage call. RLS is the only thing
authorising anything, and the service holds no key that could bypass it.
Meal parsing uses Gemini's **native structured output**. The response schema is derived
from the Zod contract in `shared/meal-parse.ts` rather than written out a second time, so
the prompt, the model's contract and the validator are one description. The reply is
validated against that contract anyway and the sanity checks (Atwater, calorie and gram
bounds) still run: a schema-constrained model is a strong guarantee, not a proof.

**The single retry covers a malformed reply, and never a refusal.** A refusal (`SAFETY`,
`RECITATION`, `IMAGE_SAFETY` and the rest of the list in `server/src/parse-meal.ts`) is
deterministic: asked again in the same words it produces the same refusal, so retrying it spends a
second call out of the user's sixty to arrive at the same place. It also gets its own message,
because the ordinary advice ("add a short note about what it was") describes a note that would be
refused for exactly the same reason. A reply that fails the contract is the opposite case: worth
one more go, told precisely what was wrong with the first.

**Analyses are capped at twenty per user per local day**, and sixty for an admin account, counted in
Postgres rather than in the browser. `DAILY_ANALYSIS_LIMIT` and `ADMIN_DAILY_ANALYSIS_LIMIT` on the
parse-meal service are the authority, and both default to the numbers in `shared/meal-parse.ts`. The
app does not compile a limit into the browser: `GET /analysis-limit` answers with the number the
service is actually enforcing (and which of the two applies to the caller), so an operator changing
the variable moves the promise on screen along with the enforcement. The `llm_call_budget()` function
reports the count, the service enforces the cap, and `render.yaml` carries both variables.

```sh
cd server
npm install
npm run dev        # http://localhost:8787
npm test           # the model is mocked, so the suite cannot spend a token
npm run typecheck
npm run build      # bundles to dist/index.js with the shared contract inlined
npm start          # runs the built bundle
npm run gmail:consent  # once, on a laptop: the refresh token the deployed /invite route needs
```

No model call needs a Gmail credential. `/invite` is the only route that does, it creates drafts
and never sends, and the service starts without those variables: the route just answers that the
feature is not set up.

The frontend reaches it through `VITE_PARSE_MEAL_URL`.

### The orphan-photo sweeper

A capture uploads its photos **before** the meal is saved, because the model has to read them.
Anything that fails in between (a crash, a closed tab, a discard) can leave objects in
`meal-photos` that no `meals.photo_paths` names. The capture sheet cleans up after itself on
close and on cancel; this job is the backstop for the cases it cannot reach.

`server/src/sweep.ts` holds the rules, and they are two sentences:

1. **A photo a meal references is never deleted**, however old it is.
2. **An unreferenced photo is deleted only once it is provably older than the grace period**
   (24 hours). If its age cannot be established (a missing or unparseable timestamp), it is
   kept.

Both are properties of a pure function and are tested directly. It deletes through the
**Storage API**, never SQL: `protect_delete` blocks direct deletes from `storage.objects`.

This is the **only** thing in the project that reads `SUPABASE_SERVICE_ROLE_KEY`, and that is
not a convenience. It is required. The sweeper has to know which photos are still referenced
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

Once a dry run's log looks right (the paths it names are genuinely abandoned uploads, and no
path belonging to a saved meal appears), flip it:

1. Render dashboard → the `nutritrack-sweep-orphan-photos` service → **Environment**.
2. Change `SWEEP_DRY_RUN` from `true` to `false`. Save; Render restarts the service.
3. Nothing else. The next scheduled run deletes.

No commit, no redeploy and no blueprint change are needed, because the switch is an environment
value. `--dry-run` on the command line still overrides it back, and locally `npm run sweep`
is a dry run whatever `.env` says, since the command line outranks the environment.

An unrecognised `SWEEP_DRY_RUN` value (a typo, say) stops the job with a non-zero exit rather
than guessing. That direction is deliberate: guessing "true" leaves a few wasted megabytes,
guessing "false" deletes photos.

### Deploying to production

`render.yaml` declares two services, both building from `server/`:

| Service                          | Type   | Plan      | What it runs                             |
| -------------------------------- | ------ | --------- | ---------------------------------------- |
| `nutritrack-parse-meal`          | `web`  | `starter` | `npm start`: the parse-meal API          |
| `nutritrack-sweep-orphan-photos` | `cron` | `starter` | `node dist/sweep.js`, daily at 04:00 UTC |

Neither service uses the free instance type, for different reasons. The web service is
**not** free on purpose: a free instance sleeps after about fifteen minutes idle and the
next request pays a cold start of tens of seconds, which is the wrong thing to meet while
standing at a dinner table waiting to log a meal. The cron job cannot be free. Render does
not offer the free instance type for cron jobs at all. It bills by run time rather than
continuously, and this one finishes in seconds, so its cost is negligible.

Two field names are worth knowing before editing this file, because getting either wrong
fails the whole deploy, including the service that was already working: a cron job uses
**`startCommand`**, the same field a web service uses, and **not** `command`. And the
`plan` value must be one Render offers for that service type.

#### 1. Render environment variables

Render prompts for these on the first Blueprint deploy (`sync: false` means the value
lives in the dashboard and never in the file).

**Web service: `nutritrack-parse-meal`**

| Key                         | Value                                      | Differs from local `.env`?     |
| --------------------------- | ------------------------------------------ | ------------------------------ |
| `SUPABASE_URL`              | `https://luxomuhczhtczfxwornl.supabase.co` | No                             |
| `SUPABASE_PUBLISHABLE_KEY`  | the `sb_publishable_…` value               | No: public by design           |
| `GEMINI_API_KEY`            | your AI Studio key                         | No                             |
| `GEMINI_VISION_MODEL`       | `gemini-3.8-flash`                         | No                             |     | `TEXT_THINKING_BUDGET` | unset, or a whole number of tokens | No: optional |     | `ALLOWED_ORIGINS` | **the deployed frontend origin** | **Yes**: locally `http://localhost:8080` |
| `GMAIL_OAUTH_CLIENT_ID`     | the OAuth client from Google Cloud         | **Yes**: not filled in locally |
| `GMAIL_OAUTH_CLIENT_SECRET` | as above                                   | **Yes**                        |
| `GMAIL_OAUTH_REFRESH_TOKEN` | from `npm run gmail:consent` in `server/`  | **Yes**                        |
| `INVITE_SENDER_ADDRESS`     | the mailbox the drafts are created in      | **Yes**: not a secret          |

The four Gmail ones are **optional to the service and not to the feature**: with any of them
missing it still starts and serves `/parse-meal`, and `/invite` answers that invites are not set up.
They are a refresh token rather than an app password because this credential lives on Render, where
it has to be revocable on its own and scoped to `gmail.compose` rather than the whole mailbox.
`npm run gmail:consent` is the one-time step that produces the token, run on a laptop; it writes the
token outside this repository.

#### Gmail refresh token

The `/invite` route creates a draft in Gmail, on behalf of a mailbox, with a refresh token. The
token is minted on a laptop and lives only in Render's environment panel. `server/scripts/gmail-consent.ts`
does the minting: it prints a consent URL, you approve it in your browser, and it writes
`~/.nutritrack-gmail-refresh-token` (mode `0600`, outside this repository) so the credential cannot be
committed by accident.

```sh
cd server
npm run gmail:consent           # writes the file; prints its path, not the token
npm run gmail:consent -- --print  # the same, and shows the token on an interactive terminal
```

`--print` is for pasting the value into Render's panel, and it only prints when stdout is a terminal:
a redirected or piped stdout is a log, and a credential in a log is a credential that leaks. Clear the
scrollback afterwards and delete the file (`rm ~/.nutritrack-gmail-refresh-token`) once the value is
in Render. Nothing in this repository reads the file; the deployed service reads
`GMAIL_OAUTH_REFRESH_TOKEN` from its environment.

**If `/invite` answers "Google sign-in for drafts has expired"** (and the service logs
`gmail refresh token expired or was revoked` with `error: invalid_grant`), the token is gone rather
than wrong, and no retry will help. That is almost always the seven-day expiry described below. Mint
a new one and replace `GMAIL_OAUTH_REFRESH_TOKEN` on `nutritrack-parse-meal`:

1. Run the script as above, approve the consent screen in your browser.
2. In Render → `nutritrack-parse-meal` → **Environment**, set `GMAIL_OAUTH_REFRESH_TOKEN` to the new
   value and save. The service restarts on its own.
3. `rm ~/.nutritrack-gmail-refresh-token`, and try the invite again from the admin page.

**Keep the OAuth app in Production, or every token dies in seven days.** A Google Cloud project whose
OAuth consent screen is in **Testing** issues refresh tokens that expire **7 days** after consent —
this is a rule about the publishing status, not about the app's code, so re-minting a token buys a
week and no more. Fix it once, in **Google Cloud console → APIs & Services → OAuth consent screen →
Publishing status → Publish app**, which moves it to **In production**. For this app that needs no
verification review: it is a single-user personal app under Google's under-100-users exemption, and
the only reader is the admin already clicking through the "unverified app" screen. Two things do
change at that point: the token stops expiring on a timer, and the consent screen stops appearing as a
warning to whoever grants it. Passing 100 users would change the picture — a restricted scope for a
public app means verification plus an annual security assessment — which is a separate decision from
this one.

**Cron job: `nutritrack-sweep-orphan-photos`**

| Key                         | Value                                              | Differs from local `.env`?                                                 |
| --------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------- |
| `SUPABASE_URL`              | as above                                           | No                                                                         |
| `SUPABASE_PUBLISHABLE_KEY`  | as above                                           | No                                                                         |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → `service_role` | **Yes**: not filled in locally, and must never be given to the web service |

Two things **not** to set: `PORT` (Render injects it) and `NODE_VERSION` /
`SWEEP_DRY_RUN` (already literal in the file). `SWEEP_DRY_RUN` stays `true` until a dry
run looks right. See [Going live with the sweeper](#going-live-with-the-sweeper).

#### 2. Supabase dashboard

Authentication → **URL Configuration**:

- **Site URL**: the deployed frontend origin.
- **Redirect URLs**: add `https://<frontend-origin>/auth/callback`. Keep
  `http://localhost:8080/auth/callback` for local development.

#### 3. Google Cloud

**Nothing here changes when the frontend origin changes.** This app signs in with
`signInWithOAuth`, so Supabase brokers the exchange and Google only ever learns Supabase's
own callback:

- **Authorized redirect URIs**: must contain
  `https://<project-ref>.supabase.co/auth/v1/callback`. It does not move with the frontend:
  Google redirects to Supabase, and Supabase forwards to the app.
- **Authorized JavaScript origins**: **not used by this flow.** That list exists for the
  Google Identity Services button, which this app does not render. Adding the frontend
  origin here changes nothing; leaving it out breaks nothing.

A wrong redirect URI fails as `redirect_uri_mismatch` from Google, not as an app error.

#### 4. The frontend: Cloudflare Workers

The build already targets **Cloudflare Workers** (Nitro's `cloudflare-module` preset in
`vite.config.ts`), so Cloudflare is the path of least resistance: no build changes, a
generous free tier, and a global CDN. A static host such as Render, Netlify or Vercel
works too but needs the preset changed, either to `node-server` (which serves the SSR
bundle as a Node service) or to `static`, which would make `src/server.ts`, the SSR
error wrapper, dead code.

**You do not hand-write a wrangler config.** The preset generates one on every build, at
`.output/server/wrangler.json`, containing `main`, `assets` (bound as `ASSETS`),
`compatibility_flags: ["nodejs_compat"]`, `no_bundle` and the ESM rules the Nitro output
needs. It also writes `.wrangler/deploy/config.json`, a pointer that makes a bare
`wrangler deploy` from the repository root use that generated file, which is why the
command below has no `--config` or `--cwd`. Adding a root `wrangler.toml` would be a
second copy of generated truth, and Nitro _ignores_ any `main` or `assets` set by hand
(with a warning), so the only field worth stating is the Worker name, which
`vite.config.ts` pins to `nutritrack`. Unpinned, Nitro derives it from the git remote,
and that name sets the Worker's own hostname, `*.workers.dev`, which is **not** the
origin Supabase and Google pin to. The canonical origin is the custom domain, below. The
name stays pinned anyway: a custom domain is attached to a script _name_, so renaming the
Worker would leave the domain pointing at a script that no longer receives deploys.

```sh
wrangler login
npm run deploy          # builds for production, then wrangler deploy
npm run preview:cloudflare   # runs the built Worker locally under workerd
```

`.output` and `.wrangler` are both gitignored: they are build products, regenerated
every time.

**The `VITE_*` values are inlined at build time**, so they must be right _when the build
runs_, not when the Worker serves.

| Key                             | Value                                                   |
| ------------------------------- | ------------------------------------------------------- |
| `VITE_SUPABASE_URL`             | `https://luxomuhczhtczfxwornl.supabase.co`              |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | the `sb_publishable_…` value                            |
| `VITE_PARSE_MEAL_URL`           | `https://nutritrack-parse-meal.onrender.com/parse-meal` |
| `VITE_TURNSTILE_SITE_KEY`       | `0x4AAAAAAF6qU7ugp2HStVCT`                             |

`npm run build:cloudflare` supplies the production `VITE_PARSE_MEAL_URL` and
`VITE_TURNSTILE_SITE_KEY` inline, so the repository's `.env` can keep pointing at
`http://localhost:8787/parse-meal` for local development. That is the whole reason the two
are separate commands: one `.env` cannot serve both, and Vite's `process.env` wins over
`.env`, so the inline values take effect without editing the file. (A host that builds from
git would instead need the four values in its own build environment.)

`vite.config.ts` **refuses to build for production** with a missing, `localhost`, or
non-`https` parse-meal URL, and with a missing `VITE_TURNSTILE_SITE_KEY`. Nothing
downstream could catch either afterwards (the request fails identically to the service
being down, and `/try` answers "Trial unavailable right now"), so the build is the last
point at which it is still visible. `npm run build` with `.env` as shipped therefore fails
on purpose, and says which command to use instead.

Finally, once the frontend has an origin, **add it to `ALLOWED_ORIGINS` on the Render
service**. Verified behaviour: a request from an origin not on that list is refused with
`403` and no `Access-Control-Allow-Origin` header, so every parse request from the
deployed app fails until this is done, and it looks like the service being down rather
than like a CORS policy.

**The app is served at `https://tracknutri.app`.** That is the canonical origin, and moving
it means updating **two** allow lists, not three:

1. Supabase → Authentication → URL Configuration: **Site URL** and **Redirect URLs**.
2. `ALLOWED_ORIGINS` on the Render parse-meal service.

Google Cloud is the third place you would expect to look, and it is the one that never
moves. The only Google setting this flow uses is **Authorized redirect URIs**, and that
holds Supabase's callback rather than the app's. **Authorized JavaScript origins is not
used at all**. It belongs to the Google Identity Services button, which this app does not
render, so an origin added there has no effect, and a domain move is not a Google change.

`https://nutritrack.nutritrack.workers.dev` still works and is allow-listed in both lists
alongside the canonical origin, because the same Worker answers on both hostnames. Treat it
as a working alias rather than a second deployment: same build, same inlined
`VITE_PARSE_MEAL_URL`, same Supabase project, so there is nothing to keep in step beyond
those two lists.

**An install from the workers.dev URL is a separate PWA identity, not a stale copy of
this one.** Everything an installed web app keeps is partitioned by origin (the service
worker registration, CacheStorage, and `localStorage`, which is where the Supabase session
lives), and the manifest's `"id": "/"` resolves against whichever origin served it. So the
old install keeps working, with its own sign-in, against the same data. The shared cache
name in `sw.js` is harmless for the same reason: caches are per-origin.

Nothing in the manifest or the service worker is origin-dependent (every path in both is
root-relative), which is what made the move free. That is worth preserving. An absolute
`start_url` is the trap: after a domain move, tapping an old icon would navigate the
installed app outside its own scope and eject it into a browser.

**The fix for an old install is to delete the icon.** It will not move itself and it will
not stop working, so it does nothing worse than sit there as a duplicate. A Cloudflare
redirect from the workers.dev hostname to `tracknutri.app` is the tempting alternative and
is worse: a cross-origin navigation leaves the PWA's scope, so the icon becomes a bookmark
that opens Safari, and the shell it cached can no longer be served.

`render.yaml` is a Render Blueprint describing the whole stack. In the dashboard choose
**New → Blueprint**, pick this repository, and Render reads the service definitions from
the file. Only `server/` is uploaded: `shared/meal-parse.ts` is compiled into the bundle
at build time, so nothing outside `rootDir` is needed at runtime, and anything outside
`ALLOWED_ORIGINS` is refused by CORS before a handler runs.

The sweeper and the web service share one build (`npm run build` emits both
`dist/index.js` and `dist/sweep.js`), so they cannot drift apart, and a broken build fails
both. The sweeper's schedule is in UTC and nothing depends on the hour: the grace period,
not the timing, is what protects a capture in progress. It is the only service that reads
`SUPABASE_SERVICE_ROLE_KEY`, and the web service must never be given it.

Gemini is configured through three names, so swapping models never needs a code change:

| Variable               | Purpose                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GEMINI_API_KEY`       | Google AI Studio API key. Must never appear under `src/` or `shared/`                                                                                                                     |
| `GEMINI_VISION_MODEL`  | Stable model id from AI Studio, e.g. `gemini-3.8-flash`. Multimodal, so it serves photos and text alike; pin a stable version rather than a `-latest` alias                               |
| `TEXT_THINKING_BUDGET` | Optional token budget for text-only analyses. Unset means the model's own minimum, which for a Gemini 3 model is the `low` thinking level; photo analyses always keep the model's default |

All model traffic goes through the service. The key must never reach the browser, and
never appears under `src/` or `shared/`.

## Project layout

```
src/                           The browser app
  routes/                      TanStack Router file-based routes
    privacy.tsx                Public, and readable with no session: OAuth review fetches it
    auth.tsx                   Sign in / sign up (invite-only)
    auth_.callback.tsx         OAuth + email-verification return handler
    onboarding.tsx             First-run wizard
    _authenticated/            Session-gated shell
      today.tsx                The dashboard: ring, macros, timeline, weight
      trends.tsx               The charts over a week / month / year
      settings.tsx             Targets, units, and today's analysis count
      admin.tsx                Invites, requests and per-user spend (admins only)
  components/
    capture/                   Capture sheet, duplicate banner, the add-a-meal dock
    review/                    Review screen, the item card, and the edit sheet
    dashboard/                 Ring, macro bars, timeline, weight entry
    trends/                    The charts
    admin/                     Invite, request and spend panels, and the not-on-the-list card
    onboarding/                Wizard, field components and settings form
    ui/                        shadcn/ui primitives
    app/, pwa/                 Brand mark; install prompt
  lib/
    targets.ts                 BMR/TDEE/macro maths (pure, unit-tested)
    dashboard.ts               Today's RPC calls and its presentation logic
    trends.ts                  The Trends screen: which dates, and how to say them
    review.ts                  The review screen's model: items, arithmetic, the payload
    capture.ts                 Upload, the parse request, failure messages
    duplicates.ts              Photo-hash and name-similarity matching (pure)
    duplicates-repo.ts         The thin queries: duplicates, loading a meal, writing an edit
    admin.ts                   Invites, requests, spend, and their presentation
    calls.ts                   The analysis budget for the signed-in user
    units.ts                   Metric/imperial conversion, and display rounding
    profile.ts                 Profile + target persistence
    onboarding.ts              Form state, Zod validation, draft persistence
    speech.ts, pwa.ts          Dictation; service worker registration
  integrations/supabase/       Supabase clients (browser, server, auth middleware)

public/                        manifest.webmanifest, sw.js, icons

shared/
  meal-parse.ts                The parse-meal contract: prompt, Zod schemas, sanity checks,
                               the meal fingerprint and the daily call limit. Imported by the
                               browser as @shared/* and by the service relatively. Must stay
                               free of browser- and Node-only APIs, since both run it.
  invite-email.ts              The one copy of what an invite says

server/                        The parse-meal service (Express 5, deployed to Render)
  src/config.ts                Zod-validated process.env, checked at boot
  src/app.ts                   Routes, CORS, error handling
  src/parse-meal.ts            Rate limit, prompt assembly, and the retry-or-not decision
  src/llm.ts                   The provider-neutral model interface
  src/gemini.ts                The Gemini client: structured output, inline images
  src/response-schema.ts       Derives the response schema from the Zod contract
  src/caller-store.ts          Every Supabase read and write, scoped to the caller
  src/gmail.ts                 The deployed invite sender: creates drafts, never sends
  src/invite.ts                The invite route, and who is allowed to call it
  src/sweep.ts                 Orphan-photo sweep rules (pure), store and planner
  src/sweep-config.ts          The sweeper's own config: the service role key, and
                               nothing the web service ever loads
  scripts/                     The cron entry point, the Gemini smoke test, gmail:consent

supabase/migrations/           Postgres schema, RLS, grants, views and the RPCs
render.yaml                    The Render Blueprint for the two server/ services
```

## Logging a meal

One capture, three ways in (a photo, a voice note, or typed text), and the same review screen at
the end of all three.

**The photos are uploaded before the meal exists.** They have to be: the model reads them, and it
is called before anything is written. That ordering is why the orphan-photo sweeper exists, and why
the capture sheet deletes its own uploads when it is closed or discarded. The gap between
"uploaded" and "saved" is real, and something has to cover it.

**A capture is recognised before it is parsed.** A photo whose SHA-256 matches one used in the last
24 hours, or a meal with similar names within ninety minutes, raises the duplicate banner before
any model call happens: the round trip, and one of the user's sixty analyses, avoided. The banner
offers the earlier meal rather than deciding for the user: "it is a new meal" is a real answer,
because a second helping looks exactly like a repeat. Taking that answer sets a marker which skips
the hash check _and_ reaches the meal's fingerprint, so the save is not swallowed as a repeat
either.

**`save_meal` is idempotent in two ways.** A repeated client key returns the original meal
untouched, and a fingerprint that already exists returns that meal instead of raising, so the UI can
say "you have already logged this" rather than showing a constraint error. Both are scoped to meals
that still exist, which is what makes delete-then-re-log work.

The review screen is where the numbers stop being the model's and become the user's. It owns the
idempotency key from the moment it mounts, so a double tap on Save cannot log two meals, and it is
the only route from a capture to a saved meal.

## Editing a saved meal

A meal can be corrected after it is saved, and this is the one place the schema is deliberately
cautious about what a write may touch.

**Two ways in, because a gesture cannot be the only one.** Swipe left reveals Delete, swipe right
reveals Edit, and both live in the row's `⋯` menu as well: the only path that is visible without
knowing a gesture, since a mouse user has no reason to drag a meal sideways. The two directions are
deliberately hard to confuse: letting go latches an action only when one direction travelled far
enough _and_ beat the other by a margin, so a drag that goes out one way and comes back springs shut
rather than guessing between an edit and a delete. Delete keeps its undo. Edit has none, because
closing it unsaved changes nothing.

**An edit may change the time, the meal type, the notes and the items, and nothing else.**
`update_meal` writes exactly that list, and a guard in the migration fails it if the function ever
so much as names the fingerprint, the idempotency key, the photos, the source or `deleted_at`.
Those record how the meal came to exist; an edit changes what it says, not how it was obtained.
Items are reconciled rather than appended: an item that names a row is updated in place, one that
does not is inserted, and a row the payload no longer names is deleted. A named row that turns out
not to belong to this meal aborts the whole call, because the silent alternative is that the item
vanishes while the payload still carries its numbers and the person is told it saved.

**The model's original reply is written only by the insert**, so `llm_raw` for an existing item
survives any number of corrections, which is the reason the column exists. Re-analysing during an
edit is the exception, and the confirmation says so in as many words: the rows on screen are
replaced, and what the model originally said about them goes with them.

**`meals.edited_at` marks an edit and only an edit.** A trigger could not do it, because a trigger
cannot tell `update_meal` from `save_meal`, so it would stamp a creation as an edit.

The remaining-calories line needed a rule of its own here, and it is the same trap the dashboard's
footer had. The day's remainder already counts this meal, so subtracting the corrected total from it
would take the meal off the day twice: 408 left with a 130 kcal meal in it must read 408, and a
correction to 200 must read 338. The stored total is added back first (`remainingAfterEdit`), and it
is derived from the loaded items rather than passed in, so there is one source of truth for the
number the footer subtracts from.

One gap, stated rather than hidden: that basis is _today's_ remainder, so it means something for a
meal on the day being asked about and nothing for one on another day. The sheet is reached from
today's timeline, so it is true for every meal that can currently be edited, and a meal edited from
a past day would need that day's remainder instead.

## The Today dashboard

A calorie ring, macro bars, a trailing-7-day verdict and the day's meal timeline (swipe left to
delete with an undo, swipe right to edit, and a `⋯` menu holding both), plus a quick weight entry.

**Every number comes from a Postgres function**, not from the browser. The trailing window has to
include the days on which nothing was logged, which is exactly what summing "the rows that came
back" gets wrong. A day is the day a meal was written on: see
[the day a meal belongs to](#the-day-a-meal-belongs-to) below. The functions read `daily_summaries`
and keep RLS in force (`security invoker`):

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

### The day a meal belongs to

**`meals.local_date` is written when the meal is written, and never derived when it is read.** A
trigger on `meals` computes it from the profile's timezone at that moment, and every reader
(`daily_summaries`, `meals_for_day`, the trends functions) uses that column and nothing else.

The obvious design is the other one, and it is worth saying why it was abandoned. Deriving the day
at read time from the _current_ timezone makes the day boundary a function of a setting: change the
timezone and every historical day is re-cut, so last Tuesday can stop being Tuesday. That is why the
app has never followed the device. With the day stored, changing the zone means "from now on"
instead of "always has been", and a meal keeps the day it was logged on. Changing a meal's _time_
across a day boundary still moves the day with it, which is the rule every other writer follows.

The backfill that introduced the column used the profile's _current_ zone (the same expression the
old view evaluated), **because that is the only value that cannot invent history**. The residual
cost, stated rather than hidden: if a zone changed in the past, those meals are dated as of today's
zone rather than the zone at the time. That is what the app already showed, so nothing moved on
screen. It must not be "fixed" by guessing from `profiles.updated_at`, which moves for weight,
protein and goals too, so it is not evidence of a zone change.

Deleting from the timeline is a **soft delete** (`meals.deleted_at`), which is what makes
undo possible and what takes the meal out of every total, since `daily_summaries` filters
on it. The photos are deliberately kept: the row still names them, so the sweeper leaves
them alone. See the note in AGENTS.md: a deleted meal's photos persist indefinitely.

### Body measurements

The quick-entry card on Today records weight, and a waist when one was measured. Waist is
optional and its field is deliberately **not** prefilled with the last value, unlike
weight: a stale number sitting in the box is one accidental Save away from being recorded
as today's measurement.

Both are stored canonically (kilograms and centimetres) and converted only for display
using the helpers in `src/lib/units.ts`. `weight_log.waist_cm` is nullable and stays
nullable; a missing measurement must never read as zero.

Recording a weight updates `profiles.weight_kg`, which is the value the next BMR/TDEE
calculation starts from. It does **not** rewrite today's calorie target. See the note in
`src/routes/_authenticated/today.tsx`.

Only `units` in `profiles` is unit-dependent. Everything the user measures is stored
canonically, so switching between metric and imperial reinterprets nothing. Verified: after
a round trip through both settings, `height_cm`, `weight_kg`, `target_weight_kg`,
`pace_kg_per_week` and the computed `targets` row were all bit-identical.

## The Trends screen

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

## Invites, requests and the admin page

The app is invite-only, and three different things are called "invite". They are easy to confuse,
so:

| What               | For whom          | What it does                                                                          |
| ------------------ | ----------------- | ------------------------------------------------------------------------------------- |
| `/admin`           | an admin, in app  | adds an address to `allowed_emails`, drafts the email, approves requests, shows spend |
| `tools/invite`     | an admin, laptop  | the same invite over IMAP, for when the mailbox credential lives on the machine       |
| the sign-in screen | someone uninvited | one write and nothing else: a row in `invite_requests` saying "let me in"             |

**An address has to be on `allowed_emails` before the app will do anything with it.** The sign-in
screen asks `check_email_allowed` and every insert policy checks `is_email_allowed()`, so an
uninvited person who signs in is told they are not on the list and offered the request button. The
first admin comes from `bootstrap_first_admin()`: the earliest account on the allow list is promoted,
and only while `admins` is still empty. Gating it on the allow list being empty, as it first was,
would have disabled it permanently the moment anyone was invited.

**Access to the admin page is decided three times over, and only the last one matters.** The tab is
hidden for non-admins, the route redirects unless `is_admin()` says true, and every read and write
behind it is refused by RLS. The third is the control; the first two exist so a normal user does not
see a door they cannot open, and so a mistake in the page cannot become a leak: the worst it could
do is render a page of errors. A second admin cannot be created from the page: the `admins` table
has no insert policy, so nobody can promote an account with their own token.

**An invite address is normalised to `lower(trim(email))` before it is stored**, in the browser and
again by a trigger on `allowed_emails`. An invite that looks added and can never match is worse than
no invite at all.

**`invite_requests` is the only write an uninvited person can cause.** The row's address comes from
the `email` claim of their signed JWT and never from the request body, one row per address is
enforced by a unique index, and a trigger skips repeats. `authenticated` has no update or delete
policy on that table, so a request cannot be rewritten or withdrawn, which is also why nothing in
the browser can put an address into that body.

### The two invite senders, neither of which can send

Both create a **draft**, and the safety property is what makes that safe to say twice: the only
Gmail endpoint either reaches is `drafts.create`, and `server/test/gmail.test.ts` reads the source
and fails if a send path is ever named in it, including in a comment. Read the draft, then send it
yourself.

- **The local tool** (`tools/invite`, `npm run invite`) is a two-box page on
  <http://127.0.0.1:8788> that talks to Gmail over IMAP with an app password from the repo's `.env`.
  It binds to `127.0.0.1` and not `0.0.0.0` because the credential is a password to a mailbox, not a
  row in a table. Serving it from the app would mean shipping that password somewhere or holding a
  session that can write to the mailbox. Its credential must never be printed, logged or put in an
  error message, which is what `tools/invite/src/redact.ts` exists for, including `imapflow`'s
  unhandled `error` event, an uncaught exception that prints a stack.
- **The deployed service** (`POST /invite`) uses a Gmail OAuth refresh token so an admin can invite
  someone from a phone. A refresh token rather than an app password because this one lives on
  Render: revocable on its own, scoped to `gmail.compose`, and attributed to a named app in the
  account's third-party access list. That scope is _restricted_, which for a public app would mean
  Google's verification plus an annual security assessment; this app is personal use under Google's
  under-100-users exemption, so it needs neither and the reader clicks through one unverified-app
  screen. Passing 100 users would change that.

The invite body is `shared/invite-email.ts`, which `tools/invite` imports too, so there is one copy
of what an invite says. `docs/invite-email.html` is generated from it by `npm run invite:preview`
and is not edited by hand: two copies of an email drift, and the copy that drifts is the one you
send. Adding the address and drafting the email are one request, drafted first, so a failure grants
nobody access.

## Privacy and account deletion

`/privacy` is a real page rather than a placeholder, and it is deliberately **outside** the
authenticated shell: Google's OAuth reviewers fetch that URL while verifying the consent screen, so
it has to render for a signed-out visitor with no session and no data of its own.

It describes what the code actually does, which is why it names the soft delete (a deleted meal
keeps its photos so the undo can work) and says plainly that **account deletion is not built yet**.
That is a gap, not a claim: a privacy page that promises a capability the app does not have is worse
than a short one, because it is the page someone believes. Deleting an account means cascading rows
across meals, items, weight, targets and the storage bucket, and none of that exists yet.

## Conventions

- One logical change per commit, e.g. `feat(parse-meal): ...` or `fix(dedupe): ...`
- TypeScript strict mode; no `any` in new code; validate every external payload with Zod
- One `.env` for every variable; secrets are server-only and never carry a `VITE_` prefix
- The parse-meal service never uses the service role key: it forwards the caller's JWT
- The orphan-photo sweeper is the one place `SUPABASE_SERVICE_ROLE_KEY` is read, from its own
  config, because it must see every user's meals to know which photos are referenced
- Row Level Security on every table, policy `user_id = auth.uid()`, **and an explicit grant beside
  it**: a grant and a policy are different things, and a table needs both
- Aggregations belong in Postgres, not in the browser
- The day a meal belongs to is **stored when the meal is written** (`meals.local_date`) and never
  derived at read time, so a timezone change means "from now on" rather than re-cutting history
- Neither invite path can send: both put the message in Drafts rather than sending it, and the
  deployed one is checked by a test that fails if a send path is ever named in its source
