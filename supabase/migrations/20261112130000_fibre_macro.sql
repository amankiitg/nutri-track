-- Fibre becomes a first-class macro.
--
-- Fibre was already stored on every `meal_items` row and totalled by `daily_summaries`, but
-- nothing read it: the meal JSON had no meal-level total, the weekly verdict had no average,
-- and there was no target to measure either against. This migration adds the one column that
-- was missing and the readings that are derived from it.
--
-- The target lives on `profiles`, not on `targets`. Every other target is arithmetic on the
-- body (Mifflin-St Jeor, then a macro split), so it belongs in the history table that records
-- what it was computed from. Fibre is a guideline the person chooses, not a number the BMR
-- produces, and putting it in `targets` would mean every profile save and every stale-weight
-- refresh had to carry it forward or silently reset it. One value, one place.
--
-- Default 30 g/day, which is the UK guideline for an adult. The column is NOT NULL with a
-- default so no reader has to decide what a missing fibre target means.
--
-- Rollback: supabase/rollback/20261112130000_fibre_macro.sql

alter table public.profiles
  add column fiber_target_g numeric(6,1) not null default 30;

alter table public.profiles
  add constraint profiles_fiber_target_g_range check (fiber_target_g between 0 and 200);

comment on column public.profiles.fiber_target_g is
  'Daily fibre target in grams. 30 by default; chosen in Settings, not derived from the body.';

-- A meal's own fibre total, beside its protein, carbs and fat.
--
-- Return type is unchanged (jsonb), so this is a replacement rather than a drop. The value is
-- coalesced to zero so a meal whose items all have unknown fibre reads "0 g fibre" rather than
-- disappearing from the line, which is the same thing `daily_summaries` does.
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
      'fiber_g', coalesce(sum(mi.fiber_g), 0),
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

-- The weekly verdict gains the fibre average, over the same judged days as the protein line.
--
-- Fibre is joined straight to `daily_summaries` rather than threaded through
-- `trailing_days`: that function's contract is about calories and macros per day, and adding
-- a column to its return type would force every caller to be dropped and recreated for one
-- number that only these two readers want. The join is scoped to the same seven days and runs
-- under the caller's RLS.
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
  avg_fiber_g numeric,
  avg_target_fiber_g numeric,
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
  judged as (
    select * from logged where target_calories is not null
  ),
  fibre as (
    select
      d.local_date,
      coalesce(s.fiber_g, 0) as fiber_g
    from days d
    left join public.daily_summaries s
      on s.user_id = auth.uid() and s.local_date = d.local_date
  ),
  judged_fibre as (
    select f.* from fibre f join judged j on j.local_date = f.local_date
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
      (select round(avg(target_protein_g), 1) from judged) as avg_target_protein_g,
      (select round(avg(fiber_g), 1) from judged_fibre) as avg_fiber_g,
      coalesce(
        (select p.fiber_target_g from public.profiles p where p.user_id = auth.uid()),
        30
      ) as avg_target_fiber_g
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
    a.avg_fiber_g,
    a.avg_target_fiber_g,
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

-- Trends: fibre per bucket and across the period, over the same settled days as the rest.
--
-- Same signature and jsonb return, so this is a replacement. The day spine stays in
-- `trailing_days`; only the fibre column is joined in, for the same reason as above.
create or replace function public.get_period_summary(
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
  day_rows as (
    select * from public.trailing_days(p_end, (select days from span))
  ),
  settled as (
    select * from day_rows where p_exclude is null or local_date <> p_exclude
  ),
  fibre_days as (
    select
      d.local_date,
      coalesce(s.fiber_g, 0) as fiber_g
    from day_rows d
    left join public.daily_summaries s
      on s.user_id = auth.uid() and s.local_date = d.local_date
  ),
  placed as (
    select
      case
        when p_bucket = 'week' then date_trunc('week', day_rows.local_date)::date
        else day_rows.local_date
      end as bucket_start,
      day_rows.*,
      f.fiber_g
    from day_rows
    left join fibre_days f on f.local_date = day_rows.local_date
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
      -- Per logged day, so a weekly bucket can be compared against the daily 30 g target.
      round(avg(fiber_g) filter (where meal_count > 0), 1) as avg_fiber_g,
      round(avg(target_calories) filter (where target_calories is not null)) as avg_target_calories,
      round(avg(target_protein_g) filter (where target_protein_g is not null), 1)
        as avg_target_protein_g,
      coalesce(
        (select p.fiber_target_g from public.profiles p where p.user_id = auth.uid()),
        30
      ) as avg_target_fiber_g
    from placed
    group by bucket_start
  )
  select jsonb_build_object(
    'start', p_start,
    'end', p_end,
    'bucket', p_bucket,
    'window_days', (select count(*) from settled),
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
            'avg_fiber_g', avg_fiber_g,
            'avg_target_fiber_g', avg_target_fiber_g,
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
      'avg_fiber_g', (
        select round(avg(f.fiber_g), 1)
        from settled st
        join fibre_days f on f.local_date = st.local_date
        where st.meal_count > 0 and st.target_calories is not null
      ),
      'avg_target_fiber_g', coalesce(
        (select p.fiber_target_g from public.profiles p where p.user_id = auth.uid()),
        30
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
