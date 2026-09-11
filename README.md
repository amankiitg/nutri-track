# NutriTrack — your daily food guide

A mobile-first PWA that tracks calories and nutrients from a photo, a voice note, or
typed text, and tells you each day whether your intake is on track for your weight goal.

Primary input is a photo of the food; second is voice; typed text is the fallback. A
vision/text LLM parses the input into structured food items, and you always review and
edit before anything is saved.

**Stack:** React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui, TanStack Start/Router,
Supabase (auth, Postgres, storage, Edge Functions) and Recharts.

---

## Prerequisites

- **Node.js 20+** and npm (npm is this repo's only package manager — there is no `bun.lock`)
- A **Supabase project** (for auth, database, storage and Edge Functions)
- A **Google Cloud OAuth client** if you want Google sign-in
- A **DeepSeek API key** if you want meal parsing (Step 2, see below)

## Setup

```sh
npm install
cp .env.example .env   # then fill in the values
```

### Environment variables

All of these are documented in `.env.example`. `.env` is gitignored — never commit it.

| Variable                        | Where it comes from                                          | Notes                                                                              |
| ------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `SUPABASE_URL`                  | Supabase → Project Settings → API → Project URL              | Server-side copy                                                                   |
| `SUPABASE_PUBLISHABLE_KEY`      | Supabase → Project Settings → API → `anon` / publishable key | Server-side copy. Safe to expose to the browser, but RLS is what protects the data |
| `SUPABASE_PROJECT_ID`           | Supabase → Project Settings → General → Reference ID         | Used by the Supabase CLI                                                           |
| `VITE_SUPABASE_URL`             | Same value as `SUPABASE_URL`                                 | The `VITE_` prefix means Vite inlines it into the browser bundle                   |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Same value as `SUPABASE_PUBLISHABLE_KEY`                     | Same                                                                               |
| `VITE_SUPABASE_PROJECT_ID`      | Same value as `SUPABASE_PROJECT_ID`                          | Same                                                                               |
| `SUPABASE_SERVICE_ROLE_KEY`     | Supabase → Project Settings → API → `service_role` key       | **Server-only.** Bypasses RLS. Never give it a `VITE_` prefix                      |

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

| Command             | What it does                                     |
| ------------------- | ------------------------------------------------ |
| `npm run dev`       | Dev server on <http://localhost:8080>            |
| `npm run build`     | Production build (client + SSR bundle via Nitro) |
| `npm run typecheck` | `tsc --noEmit` — TypeScript strict mode          |
| `npm test`          | Vitest (unit + component tests, jsdom)           |
| `npm run lint`      | ESLint                                           |
| `npm run format`    | Prettier across the repo                         |

The build targets **Cloudflare Workers** by default (Nitro's `cloudflare-module` preset,
configured in `vite.config.ts`). To self-host the SSR bundle instead, change the preset to
`node-server`.

## Edge Functions

There are **no Edge Functions in this repo yet** — the `parse-meal` function that calls
DeepSeek arrives in Step 2. Once `supabase/functions/` exists:

```sh
npx supabase functions serve parse-meal --env-file .env    # local
npx supabase functions deploy parse-meal                   # deploy
```

Function secrets are set on the project, never in the repo:

```sh
npx supabase secrets set DEEPSEEK_API_KEY=... DEEPSEEK_VISION_MODEL=... DEEPSEEK_TEXT_MODEL=...
npx supabase secrets list
```

| Secret                  | Purpose                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEEPSEEK_API_KEY`      | DeepSeek API key. Must never appear in any file under `src/`                                                                                                                    |
| `DEEPSEEK_VISION_MODEL` | Vision model id used for photo parsing. Currently `deepseek-v4-flash-vision-exp`; keep it configurable rather than hardcoded, as a newer model may be available on your account |
| `DEEPSEEK_TEXT_MODEL`   | Text model id, currently `deepseek-chat`                                                                                                                                        |

All DeepSeek traffic goes through the Edge Function. The key must never reach the browser.

## Project layout

```
src/
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
    profile.ts                 Profile + target persistence
    onboarding.ts              Form state, Zod validation, draft persistence
  integrations/supabase/       Supabase clients (browser, server, auth middleware)
supabase/migrations/           Postgres schema, RLS and views
```

## Conventions

- One logical change per commit, e.g. `feat(parse-meal): ...` or `fix(dedupe): ...`
- TypeScript strict mode; no `any` in new code; validate every external payload with Zod
- All secrets stay server-side in Supabase Edge Function secrets
- Row Level Security on every table, policy `user_id = auth.uid()`
- Aggregations belong in Postgres, not in the browser
