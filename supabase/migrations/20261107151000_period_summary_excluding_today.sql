-- Trends: today is drawn, but it is not counted.
--
-- `get_period_summary` aggregated every day in its range, and the range ends today. So today's
-- part-day was averaged against a whole day's target in all four tiles — average calories, average
-- protein, "N of M within 10%", and the days-logged count — and every one of them moved each time
-- somebody ate breakfast. It is the same defect the Today card had
-- (`20261107150000_week_verdict_complete_days.sql`), reached through a different function.
--
-- The two questions are split rather than collapsed. `day_rows` and `buckets` still cover the whole
-- range including today, because the chart below the tiles *draws* today as a bar and hiding a day
-- that has already started reads as "the app lost a meal". The totals are computed over the settled
-- days: everything in the range except `p_exclude`, which the caller sets to today when the range
-- contains it and leaves null for a period that has already finished.
--
-- `total_meals` moves onto the settled set with the rest. Left over every day it would sit beside
-- `days_logged` describing a different period, and the tiles are read as one block. `window_days`
-- follows it, because it is the denominator the tiles print.
--
-- The signature gains a fourth argument rather than a parallel function: Postgres cannot add a
-- parameter in place, and a second three-argument form with a `date` where this one has `text` makes
-- an unnamed call ambiguous. `p_exclude date default null` keeps the three-argument call working,
-- which is the one the client makes.
--
-- Rollback: supabase/rollback/20261107151000_period_summary_excluding_today.sql

-- An earlier draft of this migration carried the exclusion in a third `date` argument of its own.
-- Dropping it keeps an unnamed two-argument call unambiguous, and is a no-op on a database that never
-- saw that draft.
drop function if exists public.get_period_summary(date, date, date);

-- A parameter cannot be added in place, so the old signature goes and the new one is created. The
-- new signature is dropped too, so re-running this file against a database that already has it is a
-- replacement rather than a "function already exists" error — which is what happened the first time
-- this migration was revised after it had been applied.
drop function if exists public.get_period_summary(date, date, text);
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
