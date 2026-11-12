# HANDOFF: admin cleanup + trials list

Branch: `feat/admin-collapsible-trials` (pushed; last commit `ccdbad8`)

## Done

1. **Trial figures fixed.** Cause: `admin_trial_stats` is declared `returns table(...)`, so
   PostgREST answers with an array of rows even though it can only return one. `fetchTrialStats`
   validated the raw payload with an object schema, so a perfectly good reply failed parsing and
   the card said "Could not load the trial figures". It now parses `z.array(trialStatsRow).min(1)`
   and reads the first row. Regression tests are in `src/components/admin/panels.test.tsx`
   ("the trial card"): the array payload renders, a non-row still errors.
2. **Collapsible admin sections.** `src/components/admin/Section.tsx` is a button header
   (`aria-expanded`, `aria-controls`, 16px title and summary) wrapping a Card. Pending opens by
   default, Invites/Trials/Model spend start closed. Open state is remembered per section under
   `nutritrack.admin.sections`; reads and writes are wrapped in try/catch and the read is in an
   effect (the onboarding rule). Summaries: `Pending requests (N)`, `Invites (N)`,
   `N started, N scans today.`, `N calls this month.` Tests in `Section.test.tsx` and the
   summary assertions in `panels.test.tsx`.
3. Typecheck and lint pass for these files; 23 admin tests pass.

## Next (not started)

### A. Migration: admin-only recent trials RPC

New file `supabase/migrations/20261112120000_admin_trial_list.sql` (timestamp after
`20261110130000`), plus `supabase/rollback/20261112120000_admin_trial_list.sql`.

Signature suggestion:

```sql
create function public.admin_trial_list(p_search text default null, p_limit integer default 50)
returns table (
  email text,
  source text,          -- 'link' or 'code'
  invited boolean,
  scans_used integer,
  scans_limit integer,
  first_seen timestamptz,
  last_active timestamptz,
  requested_after boolean
)
language plpgsql stable security definer set search_path = public, pg_temp
```

Rules:
- `if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;`
- newest first by `trial_users.created_at desc`, `least(greatest(coalesce(p_limit,50),1),50)`
  so the browser cannot ask for more than 50.
- `invited` = exists in `allowed_emails` matched through `email_canonical`.
- `requested_after` = exists in `invite_requests` with `from_trial = true` for the canonical
  address and `requested_at >= t.created_at`.
- `source`: needs an explicit marker. Recommended: add
  `source text not null default 'code' check (source in ('code','link'))` to `trial_users`,
  set `'link'` on insert in `admin_trial_link_issue` (recreate that function in this migration;
  copy from `20261110120000_trial_links.sql`), and leave the code flow on the default. Backfill
  existing rows with `update public.trial_users set source = 'link' where link_sent_at is not null`
  and say in the comment that this is a best-effort backfill, not a measurement. Alternative if
  the column is not wanted: derive in the RPC from `link_sent_at is not null`, with the same
  comment about the approximation.
- Grants: `revoke execute ... from public, anon; grant execute ... to authenticated;` (copy the
  shape of `admin_trial_stats`). Do not grant `anon`.
- Rollback drops the function and, if added, the `source` column after restoring the previous
  `admin_trial_link_issue`.

Extend `supabase/tests/all_migrations_test.sh` (it already replays every migration, runs the
admin checks, applies rollbacks newest first and re-applies). Add an `after_trial_list.sql` that:
admin sees a row; a non-admin calling `admin_trial_list` gets `42501`; search filters by
canonical email; the limit clamps.

### B. Browser data layer

In `src/lib/admin.ts` add `trialListRow` (Zod) and `fetchTrialList(search: string)` calling
`supabase.rpc("admin_trial_list", { p_search: search === "" ? null : search, p_limit: 50 })`,
parsed with `z.array(...)`. Cast `supabase.rpc` the way `fetchTrialStats` does until types are
regenerated.

### C. Trials section UI

Inside `TrialCard` in `panels.tsx`, below the stats, add a search `Input` (16px) and a list of
at most 50 rows: email; "Email code" or "/t/ link"; "Invited" yes/no; "N of M scans"; "First
seen <day>"; "Last active <day or Never>"; "Asked to join" yes/no. Newest first comes from the
RPC. Keep it inside the existing collapsed Trials section. No meal content and no photos.

### D. Tests

- `fetchTrialList` array parse and search argument in `src/lib/admin-client.test.ts`.
- The Trials list renders rows and filters through the search box in `panels.test.tsx`.
- RPC refusal for non-admins is the migration test (D above); the browser layer only surfaces the
  message.

## Checks before completion

```sh
npx supabase db push --dry-run
npm run test:migrations
npm run typecheck
npm test
cd server && npx tsc --noEmit && npm test
npm run lint
npm run build:cloudflare
```

Deploy order: migration (`npx supabase db push`), Render only if the service changed (it does not
in this task), then `env -u CLOUDFLARE_API_TOKEN npm run deploy`.

## Open questions

- The `source` column is the honest way to tell code from /t/ link. Deriving from
  `link_sent_at` is smaller but mislabels someone who was sent a link and then used the code
  form. Pick the column unless the reviewer prefers the derivation.
- "scans" in the Trials summary is today's scans (`admin_trial_stats` has scans_today only). If
  the reviewer wants all-time scans, add it to that function in the same migration.
