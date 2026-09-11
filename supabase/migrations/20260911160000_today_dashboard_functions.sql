-- The Today dashboard's aggregations, in Postgres.
--
-- Every number the dashboard shows is computed here rather than by fetching rows and
-- adding them up in the browser. The reason is correctness, not taste: a "day" is a day
-- in the *profile's* timezone, and the trailing window has to include the days on which
-- nothing was logged. A client-side sum over the rows that came back silently drops
-- those empty days, which is exactly the case that makes a seven-day average wrong.
--
-- All four functions are `security invoker`, so RLS still authorises every row they
-- read. They are conveniences over `daily_summaries`, not a way around it.

-- One definition of "on track", so the dashboard and the view cannot disagree about
-- what the word means. `daily_summaries` (20260910234510) inlines the same ±10% rule;
-- that migration is applied and is never edited, so if this band ever moves, both
-- must move together.
create or replace function public.calorie_status(p_actual numeric, p_target numeric)
returns text
language sql
immutable
as $$
  select case
    when p_target is null or p_target = 0 then null
    when p_actual < p_target * 0.9 then 'under'
    when p_actual > p_target * 1.1 then 'over'
    else 'on_track'
  end;
$$;

-- The target in force on a given day: the most recent row effective on or before it.
-- `daily_summaries` does the same lookup inline; this is the same rule stated once, so
-- that a day with no meals — where the view has no row at all — can still be given a
-- target to be measured against.
create or replace function public.target_on(p_date date)
returns public.targets
language sql
stable
security invoker
set search_path = public
as $$
  select *
  from public.targets t
  where t.user_id = auth.uid()
    and t.effective_from <= p_date
  order by t.effective_from desc
  limit 1;
$$;

-- Today's ring and macro bars.
--
-- Always returns exactly one row, including when nothing has been logged and when the
-- user has no target at all: the dashboard should show an empty ring, not an error. A
-- null `target_calories` means "no target yet"; nulls propagate to the remaining
-- calories and the status rather than being coerced to zero, because "0 remaining" and
-- "unknown" are different sentences on screen.
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
    public.calorie_status(coalesce(s.calories, 0), t.calories) as status
  from (select 1) anchor
  left join public.daily_summaries s
    on s.user_id = auth.uid() and s.local_date = p_date
  left join lateral public.target_on(p_date) t on true;
$$;

-- One row per day across the trailing window, oldest first, *including* the days with
-- no meals. The window is capped at 90 days: the only caller draws bars, and an
-- unbounded `generate_series` would be a way to make the database do pointless work.
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
    public.calorie_status(coalesce(s.calories, 0), t.calories) as status
  from span
  left join public.daily_summaries s
    on s.user_id = auth.uid() and s.local_date = span.d
  left join lateral public.target_on(span.d) t on true
  order by span.d;
$$;

-- The trailing-window verdict, as one row.
--
-- Averaged over the days that were actually logged, and `days_logged` is reported so
-- the sentence can be honest about its own sample: "3 of the last 7 days" is a
-- different claim from "every day this week". Averaging over all seven days would
-- understate every partial week, which is most of them.
--
-- The target is averaged over the same days, so the two sides of the comparison cover
-- the same span. Fewer than three logged days is not enough to say anything, and says
-- so rather than guessing.
create or replace function public.week_verdict(p_end_date date, p_days integer default 7)
returns table (
  window_days integer,
  days_logged integer,
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
  agg as (
    select
      (select count(*) from days)::integer as window_days,
      (select count(*) from logged)::integer as days_logged,
      (select count(*) from logged where status = 'on_track')::integer as days_on_track,
      (select round(avg(calories)) from logged) as avg_calories,
      (select round(avg(target_calories)) from logged) as avg_target_calories,
      (select round(avg(protein_g), 1) from logged) as avg_protein_g,
      (select round(avg(target_protein_g), 1) from logged) as avg_target_protein_g
  )
  select
    a.window_days,
    a.days_logged,
    a.days_on_track,
    a.avg_calories,
    a.avg_target_calories,
    a.avg_protein_g,
    a.avg_target_protein_g,
    case
      when a.days_logged = 0 then 'no_data'
      when a.days_logged < 3 then 'too_few_days'
      else coalesce(public.calorie_status(a.avg_calories, a.avg_target_calories), 'no_data')
    end as verdict
  from agg a;
$$;

-- A day's meals with their items, each meal carrying its own totals, as one jsonb
-- array ordered by when it was eaten.
--
-- The timeline needs only these rows, and the browser has no business summing them:
-- the ring above is built from `daily_totals`, so a meal total computed a second way
-- in TypeScript would be a second answer to the same question.
--
-- The day is resolved in the profile's timezone, matching `daily_summaries` exactly,
-- including the inner join on `profiles`: the authenticated shell guarantees a profile,
-- and a user without one should see the same nothing in both places.
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
    and (m.eaten_at at time zone coalesce(p.timezone, 'UTC'))::date = p_date
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
revoke execute on function public.meals_for_day(date) from public, anon;

grant execute on function public.calorie_status(numeric, numeric) to authenticated, service_role;
grant execute on function public.target_on(date) to authenticated, service_role;
grant execute on function public.daily_totals(date) to authenticated, service_role;
grant execute on function public.trailing_days(date, integer) to authenticated, service_role;
grant execute on function public.week_verdict(date, integer) to authenticated, service_role;
grant execute on function public.meals_for_day(date) to authenticated, service_role;
