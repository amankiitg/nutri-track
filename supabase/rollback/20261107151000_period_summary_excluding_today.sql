-- Undo 20261107151000_period_summary_excluding_today.
--
-- Puts back the three-argument form from 20260911191000_period_buckets.sql: every day in the range
-- counted, today included. Run this only if the exclusion has to come out of a database still in
-- use; the Trends tiles will go back to moving every time somebody eats breakfast.

drop function if exists public.get_period_summary(date, date, text, date);

-- An earlier draft of the migration being undone created a three-`date` form; it must not survive
-- the undo either, or an unnamed two-argument call becomes ambiguous.
drop function if exists public.get_period_summary(date, date, date);

create function public.get_period_summary(
  p_start date,
  p_end date,
  p_bucket text default 'day'
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
  day_rows as (
    select * from public.trailing_days(p_end, (select days from span))
  ),
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
      (max(local_date)) as bucket_end,
      count(*)::integer as bucket_days,
      count(*) filter (where meal_count > 0)::integer as days_logged,
      coalesce(sum(calories), 0) as calories,
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
    'window_days', (select count(*) from day_rows),
    'buckets', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'bucket_start', bucket_start,
            'bucket_end', bucket_end,
            'bucket_days', bucket_days,
            'days_logged', days_logged,
            'meal_count', meal_count,
            'calories', calories,
            'protein_kcal', protein_kcal,
            'carbs_kcal', carbs_kcal,
            'fat_kcal', fat_kcal,
            'target_calories', case
              when avg_target_calories is null then null
              else round(avg_target_calories * bucket_days)
            end,
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
      'days_logged', (select count(*) from day_rows where meal_count > 0),
      'days_judged', (
        select count(*) from day_rows where meal_count > 0 and target_calories is not null
      ),
      'days_on_track', (
        select count(*) from day_rows
        where meal_count > 0 and target_calories is not null and status = 'on_track'
      ),
      'adherence_pct', (
        select round(100.0 * count(*) filter (where status = 'on_track') / nullif(count(*), 0))
        from day_rows
        where meal_count > 0 and target_calories is not null
      ),
      'avg_calories', (
        select round(avg(calories)) from day_rows
        where meal_count > 0 and target_calories is not null
      ),
      'avg_target_calories', (
        select round(avg(target_calories)) from day_rows
        where meal_count > 0 and target_calories is not null
      ),
      'avg_protein_g', (
        select round(avg(protein_g), 1) from day_rows
        where meal_count > 0 and target_calories is not null
      ),
      'avg_target_protein_g', (
        select round(avg(target_protein_g), 1) from day_rows
        where meal_count > 0 and target_calories is not null
      ),
      'avg_carbs_g', (
        select round(avg(carbs_g), 1) from day_rows
        where meal_count > 0 and target_calories is not null
      ),
      'avg_fat_g', (
        select round(avg(fat_g), 1) from day_rows
        where meal_count > 0 and target_calories is not null
      ),
      'protein_kcal', (
        select round(avg(protein_g) * 4) from day_rows
        where meal_count > 0 and target_calories is not null
      ),
      'carbs_kcal', (
        select round(avg(carbs_g) * 4) from day_rows
        where meal_count > 0 and target_calories is not null
      ),
      'fat_kcal', (
        select round(avg(fat_g) * 9) from day_rows
        where meal_count > 0 and target_calories is not null
      ),
      'total_meals', (select coalesce(sum(meal_count), 0) from day_rows)
    )
  );
$$;

revoke execute on function public.get_period_summary(date, date, text) from public, anon;
grant execute on function public.get_period_summary(date, date, text) to authenticated, service_role;
