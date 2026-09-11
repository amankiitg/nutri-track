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
4. **Secrets stay server-side** in Supabase Edge Function secrets: `DEEPSEEK_API_KEY`,
   `DEEPSEEK_VISION_MODEL`, `DEEPSEEK_TEXT_MODEL`. The DeepSeek key must never appear in any
   file under `src/`. If you find it there, that is a P0 bug — flag it and fix it first.
   Nothing secret may carry a `VITE_` prefix; Vite inlines those into the browser bundle.
5. **Row Level Security on every table**, policy `user_id = auth.uid()`. A new table without
   RLS is a bug.
6. **TypeScript strict mode.** No `any` in new code. Validate every external payload with
   Zod — including anything a model returns.
7. **If a requirement conflicts with existing code, stop and ask** rather than guessing.

## Commands

```sh
npm run dev        # http://localhost:8080
npm run build      # client + SSR bundle
npm run typecheck  # tsc --noEmit
npm test           # vitest (jsdom)
npm run lint
npm run format
```

## Known issues

- **`/auth` hydration mismatch (dev only).** Arriving at `/auth` via the redirect from a
  guarded route (`/onboarding`, `/today`, `/settings`, `/trends` while signed out) logs
  `Hydration failed because the server rendered HTML didn't match the client` — the server
  emitted the Suspense fallback where the client emitted the page. React recovers, the page
  renders correctly, and a direct load of `/auth` is clean. Revisit when the Wrangler
  preview is set up, to confirm whether it also occurs in a production build.

## Layout and conventions

- `src/routes/` — TanStack Router file-based routes. `_authenticated/` is the session-gated
  shell; `auth_.callback.tsx` is the OAuth return handler (the trailing `_` keeps it from
  nesting under `auth.tsx`, which would otherwise need to render an `<Outlet />`).
- `src/lib/targets.ts` — all BMR/TDEE/macro maths. Pure functions, unit-tested against a
  worked example. Do not reimplement this maths anywhere else.
- `src/components/onboarding/steps.tsx` — the question groups, shared by the onboarding
  wizard and the settings form. Change them in one place.
- `supabase/functions/_shared/` — code the browser and the Edge Functions both import,
  reachable as `@shared/*`. Bare imports such as `zod` resolve from `node_modules` in Vite
  and from the import map in `supabase/functions/deno.json` in Deno; that mapping is
  required for `functions deploy`, so keep the versions in step.
- Aggregations belong in Postgres, not in the browser.
- The build targets Cloudflare Workers via Nitro's `cloudflare-module` preset
  (`vite.config.ts`); switch to `node-server` to self-host the SSR bundle.
