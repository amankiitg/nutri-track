-- Undo 20261107150000_week_verdict_complete_days.
--
-- Puts back the function as `20260911161000` left it: a window ending on the date passed, so today is
-- included again. Run this only if the complete-days window has to come out of a database that is
-- still being used; the Today card will go back to averaging a part-day against a whole target.

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
