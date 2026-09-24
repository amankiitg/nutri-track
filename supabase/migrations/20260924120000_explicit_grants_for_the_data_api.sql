-- The Data API's access to a table is two separate things: a privilege granted on the table, and
-- an RLS policy that lets a row through. A policy without a grant is not access — PostgREST
-- answers "permission denied for table meals" and never reaches the policy. Both are required,
-- and they answer different questions: the grant says *this role may touch this table at all*,
-- the policy says *which rows it may touch*.
--
-- Until now half of that was being done for us by a platform default privilege:
--
--   alter default privileges for role postgres in schema public
--     grant all on tables to anon, authenticated, service_role;
--
-- Measured on 2026-09-24 by creating a table and reading its ACL: it came out as
-- `postgres=arwdDxtm/postgres, anon=arwdDxtm/postgres, authenticated=arwdDxtm/postgres,
-- service_role=arwdDxtm/postgres` with no grant written anywhere in this repository. That is
-- also why the live tables show `anon` with ALL: no migration has ever granted anything to anon.
-- Supabase is withdrawing the default on 2026-10-30, so a table created after that date gets only
-- what its own migration grants.
--
-- This file grants nothing that is not already held — the ACL and row-count fingerprint taken
-- before and after applying it are identical — so it changes no behaviour on this project. It
-- exists because after October 30 the migration *is* the access: a fresh project built from this
-- history, and every table added later, depends on these statements rather than on the platform.
-- Read it as the reference list of what each table needs.
--
-- Deliberately absent:
--   - `anon` on any table. Every route that touches these tables requires a session. The two
--     things an unauthenticated visitor can do are `check_email_allowed` (a function) and
--     creating their own `invite_requests` row, and the second is an authenticated write.
--   - restating the default privileges above. A blanket default is exactly what we are losing,
--     and it is invisible: it would grant access to a table before anyone decided it should
--     have any. The convention is that a migration creating a table grants on it explicitly.
--   - `truncate`, `references` and `trigger` for anyone but the owner: nothing in the app needs
--     them, and the platform default was granting all three.

-- The Data API cannot see inside a schema the role has no USAGE on, whatever the table grants
-- say. Held already, and stated here so the chain is complete.
grant usage on schema public to anon, authenticated, service_role;

-- The user's own data, read and written by the browser under RLS.
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.targets to authenticated;
grant select, insert, update, delete on public.meals to authenticated;
grant select, insert, update, delete on public.meal_items to authenticated;
grant select, insert, update, delete on public.weight_log to authenticated;

-- Written by the parse-meal service on the caller's own token, read by Settings for the budget
-- card. No update and no delete: a call that happened is a historical fact, and `llm_call_budget`
-- counts rows rather than maintaining a total.
grant select, insert on public.llm_calls to authenticated;

-- The admin page. `allowed_emails` has no update because inviting an address twice is a no-op
-- rather than an edit (`ignoreDuplicates` on the service side, a trigger normalising here), and
-- `invite_requests` has update because approving one writes a decision onto the row.
grant select on public.admins to authenticated;
grant select, insert, delete on public.allowed_emails to authenticated;
grant select, insert, update on public.invite_requests to authenticated;

-- The dashboard and the trends screen read the view; nothing writes it, and the macros and
-- verdicts behind it come from functions granted separately.
grant select on public.daily_summaries to authenticated;

-- The service role: the sweeper, which reads every user's meals to decide which photos are still
-- referenced, and the admin functions. Not RLS-scoped, which is why it is `all` per table rather
-- than the narrow sets above.
grant all on public.profiles to service_role;
grant all on public.targets to service_role;
grant all on public.meals to service_role;
grant all on public.meal_items to service_role;
grant all on public.weight_log to service_role;
grant all on public.llm_calls to service_role;
grant all on public.admins to service_role;
grant all on public.allowed_emails to service_role;
grant all on public.invite_requests to service_role;
grant select on public.daily_summaries to service_role;
