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

## Layout and conventions

- `src/routes/` — TanStack Router file-based routes. `_authenticated/` is the session-gated
  shell; `auth_.callback.tsx` is the OAuth return handler (the trailing `_` keeps it from
  nesting under `auth.tsx`, which would otherwise need to render an `<Outlet />`).
- `src/lib/targets.ts` — all BMR/TDEE/macro maths. Pure functions, unit-tested against a
  worked example. Do not reimplement this maths anywhere else.
- `src/components/onboarding/steps.tsx` — the question groups, shared by the onboarding
  wizard and the settings form. Change them in one place.
- Aggregations belong in Postgres, not in the browser.
- The build targets Cloudflare Workers via Nitro's `cloudflare-module` preset
  (`vite.config.ts`); switch to `node-server` to self-host the SSR bundle.
