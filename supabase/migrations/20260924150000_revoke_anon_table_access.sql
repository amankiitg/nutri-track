-- `anon` holds ALL privileges on every table and view in `public`, inherited from the platform
-- default privilege measured in `20260924120000`. Nothing in this repository ever granted the
-- role anything, and no policy is written for it either, so the grant has been inert rather than
-- useful: a signed-out read came back **empty** (RLS filters every row) instead of being denied.
--
-- Inert is not the same as safe. A role holding TRUNCATE, REFERENCES, UPDATE and DELETE on the
-- users' meals is a standing offer that only a missing policy stands between, and the point of
-- the grant layer is that it does not depend on the policy layer at all — the two answer
-- different questions, and this is what makes the first one say no. After 2026-10-30 the default
-- will not apply to new tables; this removes what it already left on the existing ones.
--
-- What `anon` keeps:
--   - USAGE on schema `public`, so the Data API can reach the one thing it may call.
--   - EXECUTE on `check_email_allowed`, the signed-out audience's only request: "is this address
--     invited?". It is `security definer`, so it reads `allowed_emails` as its owner and needs no
--     privilege on the table from whoever calls it. That is also why revoking the table does not
--     break the sign-in screen, which was verified rather than assumed — see below.
--
-- Verified immediately before and after applying this file, as both roles, in one rolled-back
-- transaction: signed out (`anon`), all ten relations denied at the grant, with
-- `check_email_allowed` still returning true; signed in (`authenticated`) with a JWT carrying the
-- `email` claim, `daily_summaries`, `daily_totals`, `trailing_days`, `week_verdict` and
-- `meals_for_day` all reading, and `save_meal` returning `created: true`. A signed-out page load
-- of `/privacy` and `/auth` returned 200 in both states.

revoke all on public.allowed_emails from anon;
revoke all on public.admins from anon;
revoke all on public.profiles from anon;
revoke all on public.targets from anon;
revoke all on public.meals from anon;
revoke all on public.meal_items from anon;
revoke all on public.weight_log from anon;
revoke all on public.llm_calls from anon;
revoke all on public.invite_requests from anon;
revoke all on public.daily_summaries from anon;

-- The guard, because a `revoke` that silently matches nothing looks exactly like one that worked,
-- and the next reader would have no way to tell. Both halves are checked: that `anon` has nothing
-- on a table, and that it still has what it needs elsewhere.
do $guard$
declare
  _still_granted text;
  _can_check boolean;
begin
  select string_agg(c.relname, ', ' order by c.relname) into _still_granted
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join lateral aclexplode(c.relacl) a on true
    join pg_roles r on r.oid = a.grantee
   where n.nspname = 'public' and c.relkind in ('r', 'v') and r.rolname = 'anon';

  if _still_granted is not null then
    raise exception 'anon still holds privileges on: %', _still_granted;
  end if;

  _can_check := has_function_privilege('anon', 'public.check_email_allowed(text)', 'execute');
  if not _can_check then
    raise exception 'anon lost EXECUTE on check_email_allowed, which the sign-in screen needs';
  end if;
end $guard$;
