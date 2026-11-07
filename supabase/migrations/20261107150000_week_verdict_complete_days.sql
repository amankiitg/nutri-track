-- The seven days the Today card averages, now the seven days that are actually over.
--
-- `week_verdict` built its window ending on the date the caller passed, and the caller passes today.
-- So today - a few hours old, usually with one meal in it - was one seventh of the calorie average,
-- one seventh of the protein average, and one of the days counted for "landed within 10% of target".
-- A person reading that card at nine in the morning was being told they were under target for the
-- week, on the strength of a part-day compared against a whole day's target.
--
-- The window now ends the day before the date passed, so `p_end_date` means "the day the person is
-- looking at" and the seven days are the complete ones before it: yesterday back to seven days ago.
-- Nothing else about the arithmetic changes - each day is still compared against *its own* target,
-- and the sample is still the days that have both a meal and a target.
--
-- `window_start` and `window_end` are returned so the rule is visible rather than inferred. A caller
-- that wants to say "31 Oct to 6 Nov" can, and a test can assert that today is not in the span
-- without reading the SQL.
--
-- Rollback: supabase/rollback/20261107150000_week_verdict_complete_days.sql

-- The return type changes, and `create or replace` cannot do that. The grants go with it, which is
-- why they are restated at the bottom rather than assumed.
drop function if exists public.week_verdict(date, integer);

create function public.week_verdict(p_end_date date, p_days integer default 7)
returns table (
  window_days integer,
  window_start date,
  window_end date,
  days_logged integer,
  days_judged integer,
  days_on_track integer,
  avg_calories numeric,
  avg_target_calories numeric,
  avg_protein_g numeric,
  avg_target_protein_g numeric,
  verdict text
)
language sql
stable
security invoker
set search_path = public
as $$
  with bounds as (
    -- The same clamp `trailing_days` applies, so the two cannot disagree about the span.
    select
      least(greatest(coalesce(p_days, 7), 1), 90) as span,
      p_end_date - 1 as last_day
  ),
  days as (
    -- Ending yesterday, not today: the complete days only.
    select * from public.trailing_days((select last_day from bounds), (select span from bounds))
  ),
  logged as (
    select * from days where meal_count > 0
  ),
  -- The sample both averages and the verdict are computed from: a day with food and a target to
  -- measure it against. Same denominator on both sides.
  judged as (
    select * from logged where target_calories is not null
  ),
  agg as (
    select
      (select count(*) from days)::integer as window_days,
      (select last_day - ((select span from bounds) - 1) from bounds) as window_start,
      (select last_day from bounds) as window_end,
      (select count(*) from logged)::integer as days_logged,
      (select count(*) from judged)::integer as days_judged,
      (select count(*) from judged where status = 'on_track')::integer as days_on_track,
      (select round(avg(calories)) from judged) as avg_calories,
      (select round(avg(target_calories)) from judged) as avg_target_calories,
      (select round(avg(protein_g), 1) from judged) as avg_protein_g,
      (select round(avg(target_protein_g), 1) from judged) as avg_target_protein_g
  )
  select
    a.window_days,
    a.window_start,
    a.window_end,
    a.days_logged,
    a.days_judged,
    a.days_on_track,
    a.avg_calories,
    a.avg_target_calories,
    a.avg_protein_g,
    a.avg_target_protein_g,
    case
      when a.days_logged = 0 then 'no_data'
      when a.days_judged = 0 then 'no_target'
      when a.days_judged < 3 then 'too_few_days'
      else coalesce(public.calorie_status(a.avg_calories, a.avg_target_calories), 'no_data')
    end as verdict
  from agg a;
$$;

revoke execute on function public.week_verdict(date, integer) from public, anon;
grant execute on function public.week_verdict(date, integer) to authenticated, service_role;
