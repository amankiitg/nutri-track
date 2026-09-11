-- What is left of today's meal-analysis budget, for the person who spent it.
--
-- The limit is enforced by the service (`server/src/parse-meal.ts`) and defined once,
-- in `shared/meal-parse.ts`, which is also where the Settings screen reads it from.
-- This function does not decide anything: it reports how many model calls the caller
-- has made since midnight *in their own profile's timezone*, and when the next
-- midnight is.
--
-- The day boundary is computed here rather than in the browser for the same reason as
-- every other one in this schema. The service starts its window at
-- `startOfLocalDay(now, profile.timezone)`; if the client counted from the phone's own
-- midnight instead, a phone that had travelled, or a profile whose zone differs from
-- the device's, would show a budget that had already reset — or one that had not.
-- Those two numbers disagreeing is worse than not showing the number at all.
--
-- `security invoker`, so RLS on `llm_calls` is what authorises the read and this cannot
-- become a way to count somebody else's calls.
create or replace function public.llm_call_budget()
returns table (used integer, resets_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  with zone as (
    -- Same fallback as `daily_summaries`: a missing or null timezone is UTC, not an
    -- error. An *invalid* zone is taken at face value here, exactly as that view takes
    -- it — the column is already load-bearing for every other day boundary, so a bad
    -- value is a pre-existing problem rather than one for this function to paper over.
    select coalesce(
      (select p.timezone from public.profiles p where p.user_id = auth.uid()),
      'UTC'
    ) as tz
  ),
  bounds as (
    select
      -- "Now, read as wall-clock time in the profile's zone" -> that local date ->
      -- midnight that day -> back to an instant. The round trip is what makes it a
      -- local midnight rather than a UTC one.
      ((now() at time zone tz)::date)::timestamp at time zone tz as day_start,
      (((now() at time zone tz)::date) + 1)::timestamp at time zone tz as next_start
    from zone
  )
  select
    (select count(*)::integer from public.llm_calls c where c.created_at >= b.day_start) as used,
    b.next_start as resets_at
  from bounds b;
$$;

grant execute on function public.llm_call_budget() to authenticated;
