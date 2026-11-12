-- Undo 20261112130000_fibre_macro.
--
-- Restores the functions that read `profiles.fiber_target_g` before dropping the column, in
-- the order they last existed: `week_verdict` as 20261107150000 left it, `get_period_summary`
-- as 20261107151000 left it, and `meals_for_day` from 20260917120000 (the 20260911160000 body
-- with the day read from `meals.local_date`).
--
-- Run this only if fibre has to come out of a database still in use. The Today and Trends
-- screens will lose the fibre line and any client expecting those fields will fail validation,
-- so roll the frontend back with it.

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

drop function if exists public.get_period_summary(date, date, text, date);

create function public.get_period_summary(
  p_start date,
  p_end date,
  p_bucket text default 'day',
  p_exclude date default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with span as (
    select least(greatest((p_end - p_start) + 1, 1), 400) as days
  ),
  -- Every day in the range, including the one that is still happening. The chart draws these.
  day_rows as (
    select * from public.trailing_days(p_end, (select days from span))
  ),
  -- The days that are over. `p_exclude` is null when the period has finished, so this is then the
  -- whole range; it is today when the period is still running.
  settled as (
    select * from day_rows where p_exclude is null or local_date <> p_exclude
  ),
  -- A day bucket is its own start and end; a week bucket runs Monday to Sunday, using
  -- the same Monday-start convention as the Trends navigator so the bars line up with
  -- the dates the user stepped through.
  placed as (
    select
      case
        when p_bucket = 'week' then date_trunc('week', local_date)::date
        else local_date
      end as bucket_start,
      day_rows.*
    from day_rows
  ),
  buckets as (
    select
      bucket_start,
      -- The bucket's own extent: seven days for a full week, fewer at the edges of a
      -- range that does not start on a Monday.
      (max(local_date)) as bucket_end,
      count(*)::integer as bucket_days,
      count(*) filter (where meal_count > 0)::integer as days_logged,
      coalesce(sum(calories), 0) as calories,
      -- `trailing_days` gives grams, so the energy conversion happens here — the same
      -- 4/4/9 the per-day figures used, applied to the bucket's total. For a one-day
      -- bucket this is identical to the per-day figure it replaces.
      round(coalesce(sum(protein_g), 0) * 4) as protein_kcal,
      round(coalesce(sum(carbs_g), 0) * 4) as carbs_kcal,
      round(coalesce(sum(fat_g), 0) * 9) as fat_kcal,
      coalesce(sum(protein_g), 0) as protein_g,
      coalesce(sum(carbs_g), 0) as carbs_g,
      coalesce(sum(fat_g), 0) as fat_g,
      coalesce(sum(meal_count), 0)::integer as meal_count,
      round(avg(calories) filter (where meal_count > 0)) as avg_calories,
      round(avg(protein_g) filter (where meal_count > 0), 1) as avg_protein_g,
      round(avg(carbs_g) filter (where meal_count > 0), 1) as avg_carbs_g,
      round(avg(fat_g) filter (where meal_count > 0), 1) as avg_fat_g,
      -- The per-day allowance in force across the bucket, averaged over the days that
      -- have one. A target changes at most a few times a year, so in practice this is
      -- that day's target; averaging is what keeps a bucket spanning a change sane.
      round(avg(target_calories) filter (where target_calories is not null)) as avg_target_calories,
      round(avg(target_protein_g) filter (where target_protein_g is not null), 1)
        as avg_target_protein_g
    from placed
    group by bucket_start
  )
  select jsonb_build_object(
    'start', p_start,
    'end', p_end,
    'bucket', p_bucket,
    -- The days the tiles divide by, which is the settled set and not the drawn one: "3 of 7 days"
    -- beside a chart of eight bars would be counting two different windows.
    'window_days', (select count(*) from settled),
    -- Echoed back so the screen can say which day it left out and mean it.
    'excluded', p_exclude,
    'buckets', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'bucket_start', bucket_start,
            'bucket_end', bucket_end,
            'bucket_days', bucket_days,
            'days_logged', days_logged,
            'meal_count', meal_count,
            -- The bar: what was eaten across the bucket.
            'calories', calories,
            'protein_kcal', protein_kcal,
            'carbs_kcal', carbs_kcal,
            'fat_kcal', fat_kcal,
            -- The line: what the bucket was allowed. A week's worth of daily
            -- allowance, so a weekly bar is compared against a weekly figure rather
            -- than against one day's target.
            'target_calories', case
              when avg_target_calories is null then null
              else round(avg_target_calories * bucket_days)
            end,
            -- The verdict, from per-day averages rather than bucket totals. A week with
            -- three logged days and four empty ones is not "under"; it is partly
            -- unrecorded, and comparing its sum against a seven-day allowance would say
            -- the opposite.
            'avg_calories', avg_calories,
            'avg_target_calories', avg_target_calories,
            'avg_protein_g', avg_protein_g,
            'avg_carbs_g', avg_carbs_g,
            'avg_fat_g', avg_fat_g,
            'status', public.calorie_status(avg_calories, avg_target_calories)
          )
          order by bucket_start
        ),
        '[]'::jsonb
      )
      from buckets
    ),
    'totals', jsonb_build_object(
      'days_logged', (select count(*) from settled where meal_count > 0),
      'days_judged', (
        select count(*) from settled where meal_count > 0 and target_calories is not null
      ),
      'days_on_track', (
        select count(*) from settled
        where meal_count > 0 and target_calories is not null and status = 'on_track'
      ),
      'adherence_pct', (
        select round(100.0 * count(*) filter (where status = 'on_track') / nullif(count(*), 0))
        from settled
        where meal_count > 0 and target_calories is not null
      ),
      'avg_calories', (
        select round(avg(calories)) from settled
        where meal_count > 0 and target_calories is not null
      ),
      'avg_target_calories', (
        select round(avg(target_calories)) from settled
        where meal_count > 0 and target_calories is not null
      ),
      'avg_protein_g', (
        select round(avg(protein_g), 1) from settled
        where meal_count > 0 and target_calories is not null
      ),
      'avg_target_protein_g', (
        select round(avg(target_protein_g), 1) from settled
        where meal_count > 0 and target_calories is not null
      ),
      'avg_carbs_g', (
        select round(avg(carbs_g), 1) from settled
        where meal_count > 0 and target_calories is not null
      ),
      'avg_fat_g', (
        select round(avg(fat_g), 1) from settled
        where meal_count > 0 and target_calories is not null
      ),
      'protein_kcal', (
        select round(avg(protein_g) * 4) from settled
        where meal_count > 0 and target_calories is not null
      ),
      'carbs_kcal', (
        select round(avg(carbs_g) * 4) from settled
        where meal_count > 0 and target_calories is not null
      ),
      'fat_kcal', (
        select round(avg(fat_g) * 9) from settled
        where meal_count > 0 and target_calories is not null
      ),
      'total_meals', (select coalesce(sum(meal_count), 0) from settled)
    )
  );
$$;

revoke execute on function public.get_period_summary(date, date, text, date) from public, anon;
grant execute on function public.get_period_summary(date, date, text, date)
  to authenticated, service_role;

create or replace function public.meals_for_day(p_date date)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_agg(entry order by entry ->> 'eaten_at'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', m.id,
      'eaten_at', m.eaten_at,
      'meal_type', m.meal_type,
      'source', m.source,
      'notes', m.notes,
      'photo_count', cardinality(m.photo_paths),
      'calories', coalesce(sum(mi.calories), 0),
      'protein_g', coalesce(sum(mi.protein_g), 0),
      'carbs_g', coalesce(sum(mi.carbs_g), 0),
      'fat_g', coalesce(sum(mi.fat_g), 0),
      'item_count', count(mi.id)::integer,
      'items', coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', mi.id,
            'name', mi.name,
            'quantity', mi.quantity,
            'unit', mi.unit,
            'grams', mi.grams,
            'calories', mi.calories,
            'protein_g', mi.protein_g,
            'carbs_g', mi.carbs_g,
            'fat_g', mi.fat_g,
            'fiber_g', mi.fiber_g,
            'confidence', mi.confidence,
            'user_edited', mi.user_edited
          )
          order by mi.created_at
        ) filter (where mi.id is not null),
        '[]'::jsonb
      )
    ) as entry
  from public.meals m
  join public.profiles p on p.user_id = m.user_id
  left join public.meal_items mi on mi.meal_id = m.id
  where m.user_id = auth.uid()
    and m.deleted_at is null
    and m.local_date = p_date
  group by m.id
) rows;
$$;

-- Functions are executable by PUBLIC by default, which would expose them to `anon`.
-- They are harmless without a session — `auth.uid()` is null, so they return zeros —
-- but there is no reason to publish an API nobody uses.
revoke execute on function public.calorie_status(numeric, numeric) from public, anon;
revoke execute on function public.target_on(date) from public, anon;
revoke execute on function public.daily_totals(date) from public, anon;
revoke execute on function public.trailing_days(date, integer) from public, anon;
revoke execute on function public.week_verdict(date, integer) from public, anon;

alter table public.profiles drop constraint if exists profiles_fiber_target_g_range;
alter table public.profiles drop column if exists fiber_target_g;
