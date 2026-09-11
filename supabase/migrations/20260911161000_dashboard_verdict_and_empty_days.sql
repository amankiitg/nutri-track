-- Two corrections to 20260911160000_today_dashboard_functions, found by running the
-- functions against real rows rather than by reasoning about them.
--
-- 1. `status` was 'under' on a day with nothing logged.
--
--    `calorie_status(0, target)` is 'under' by arithmetic and a lie in English. A day
--    nobody logged is unknown, not low. `meal_count` was already returned so a caller
--    could work around it, but a field whose meaning depends on remembering to check
--    another field is a trap, and the trends screen would have walked into it. An
--    unlogged day now reports a null status.
--
-- 2. `week_verdict` averaged its two sides over different sets of days.
--
--    `avg(calories) from logged` (days with a meal) against `avg(target_calories) from
--    logged` (the same rows, but `avg` skips nulls, and a target only exists from the
--    day it was created). On a new account the window straddles the first target, so a
--    four-day intake average was being compared against a one-day target and called
--    'on_track'. Observed, not hypothesised: 1550 against 1636, from 4 days of food and
--    1 day of target.
--
--    The average and the verdict are now restricted to days that have both a meal and a
--    target, and `days_judged` reports that sample separately from `days_logged`. The
--    sentence on screen can then be honest about both numbers, and a window with too
--    little overlap says so instead of guessing.

create or replace function public.daily_totals(p_date date)
returns table (
  local_date date,
  meal_count integer,
  calories numeric,
  protein_g numeric,
  carbs_g numeric,
  fat_g numeric,
  fiber_g numeric,
  target_calories integer,
  target_protein_g numeric,
  target_carbs_g numeric,
  target_fat_g numeric,
  remaining_calories numeric,
  status text
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    p_date as local_date,
    coalesce(s.meal_count, 0)::integer as meal_count,
    coalesce(s.calories, 0) as calories,
    coalesce(s.protein_g, 0) as protein_g,
    coalesce(s.carbs_g, 0) as carbs_g,
    coalesce(s.fat_g, 0) as fat_g,
    coalesce(s.fiber_g, 0) as fiber_g,
    t.calories as target_calories,
    t.protein_g as target_protein_g,
    t.carbs_g as target_carbs_g,
    t.fat_g as target_fat_g,
    case when t.calories is null then null else t.calories - coalesce(s.calories, 0) end
      as remaining_calories,
    case
      when coalesce(s.meal_count, 0) = 0 then null
      else public.calorie_status(coalesce(s.calories, 0), t.calories)
    end as status
  from (select 1) anchor
  left join public.daily_summaries s
    on s.user_id = auth.uid() and s.local_date = p_date
  left join lateral public.target_on(p_date) t on true;
$$;

create or replace function public.trailing_days(p_end_date date, p_days integer default 7)
returns table (
  local_date date,
  day_offset integer,
  meal_count integer,
  calories numeric,
  protein_g numeric,
  carbs_g numeric,
  fat_g numeric,
  target_calories integer,
  target_protein_g numeric,
  status text
)
language sql
stable
security invoker
set search_path = public
as $$
  with span as (
    select generate_series(
      p_end_date - (least(greatest(coalesce(p_days, 7), 1), 90) - 1),
      p_end_date,
      interval '1 day'
    )::date as d
  )
  select
    span.d as local_date,
    (p_end_date - span.d)::integer as day_offset,
    coalesce(s.meal_count, 0)::integer as meal_count,
    coalesce(s.calories, 0) as calories,
    coalesce(s.protein_g, 0) as protein_g,
    coalesce(s.carbs_g, 0) as carbs_g,
    coalesce(s.fat_g, 0) as fat_g,
    t.calories as target_calories,
    t.protein_g as target_protein_g,
    case
      when coalesce(s.meal_count, 0) = 0 then null
      else public.calorie_status(coalesce(s.calories, 0), t.calories)
    end as status
  from span
  left join public.daily_summaries s
    on s.user_id = auth.uid() and s.local_date = span.d
  left join lateral public.target_on(span.d) t on true
  order by span.d;
$$;

-- The return type changes, so the old signature has to go rather than be replaced.
drop function if exists public.week_verdict(date, integer);

create function public.week_verdict(p_end_date date, p_days integer default 7)
returns table (
  window_days integer,
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
  with days as (
    select * from public.trailing_days(p_end_date, p_days)
  ),
  logged as (
    select * from days where meal_count > 0
  ),
  -- The sample both averages and the verdict are computed from: a day with food and a
  -- target to measure it against. Same denominator on both sides.
  judged as (
    select * from logged where target_calories is not null
  ),
  agg as (
    select
      (select count(*) from days)::integer as window_days,
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
