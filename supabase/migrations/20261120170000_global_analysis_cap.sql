-- --------------------------------------------------------------------------- --
-- The two things an analysis now has to prove before it runs.
--
-- 1. That the address is verified. Magic links and Google both prove an inbox, but the rule is
--    stated server side rather than assumed: an account created some other way, or one whose
--    confirmation was never completed, must not spend a model call.
--
-- 2. That the day, across everybody, has room left. The cap itself lives in the service's
--    environment (`GLOBAL_DAILY_ANALYSIS_CAP`), because it is a spending decision rather than a
--    data one; this function only counts, and counting every row is why it is security definer
--    and returns a number rather than rows.
--
-- Trial analyses are counted too: they reserve a row in `llm_calls` like any other, so one count
-- covers signed-in users and the trial together, which is how the cost is actually incurred.
-- --------------------------------------------------------------------------- --

/**
 * How many analyses have run since midnight UTC.
 *
 * UTC rather than each caller's local day: a global cap has to have one boundary, and a boundary
 * per timezone would let the cap reset several times over as the planet turns. The admin card says
 * "today" and means this day.
 */
create or replace function public.global_analyses_today()
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return (
    select count(*)::integer
      from public.llm_calls c
     where c.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
  );
end $$;

revoke execute on function public.global_analyses_today() from public, anon;
grant execute on function public.global_analyses_today() to authenticated, service_role;

/**
 * Whether the caller's address has been proven.
 *
 * True when Supabase marked the address confirmed, or when the account signs in with Google, whose
 * own verification is stronger than ours. A caller with no session gets false rather than an error,
 * because the answer is used as a guard and a guard that throws is a guard somebody removes.
 */
create or replace function public.caller_email_verified()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    return false;
  end if;

  if exists (select 1 from auth.identities i where i.user_id = v_user and i.provider = 'google') then
    return true;
  end if;

  return exists (
    select 1 from auth.users u where u.id = v_user and u.email_confirmed_at is not null
  );
end $$;

revoke execute on function public.caller_email_verified() from public, anon;
grant execute on function public.caller_email_verified() to authenticated, service_role;
