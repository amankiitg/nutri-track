-- The Trends screen's two reads.
--
-- Both are built on what already exists rather than on a fresh join: the day spine and
-- the daily figures come from `trailing_days`, which reads `daily_summaries`, which is
-- the one place the meals-to-local-day join lives. The rule for this screen is the same
-- one the dashboard follows — aggregation happens here, not in the browser.

-- The dashboard asks for a 7-day window; Trends asks for a year. The old cap of 90 was
-- a guard against a caller requesting a decade, not a statement about legitimate views,
-- so it moves rather than being duplicated into a second day-spine function.
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
      p_end_date - (least(greatest(coalesce(p_days, 7), 1), 400) - 1),
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

-- One row per day across an arbitrary date range, plus the period's totals, as a single
-- jsonb value.
--
-- One round trip rather than two, because the chart and the stat tiles describe the same
-- range and must not be able to disagree about it — a second call with a slightly
-- different range would be a silent inconsistency, not an error.
--
-- The day rows include days with nothing logged. That matters twice over: the bar chart
-- should show a gap rather than skip a day, and every average below is taken over the
-- days that *can* be judged, which is a number this function has to count rather than
-- assume.
--
-- The averages are restricted to days that have both food and a target, for the reason
-- the dashboard's verdict is: a target only exists from the day it was created, so on a
-- young account averaging intake across days-with-food against a target averaged across
-- days-with-a-target compares two different spans. `days_judged` is returned beside
-- `days_logged` so the screen can be honest about the sample it is describing.
--
-- The macro figures are given as calories, not grams. A donut of "grams of protein,
-- carbs and fat" would imply 100 g of fat and 100 g of carbohydrate are the same share
-- of anything, and they differ by a factor of 2.25. Converting here keeps that
-- arithmetic in one place instead of every renderer doing it slightly differently.
create or replace function public.get_period_summary(p_start date, p_end date)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with span as (
    -- Clamped to the same bound `trailing_days` enforces, so a reversed or silly range
    -- produces one day rather than an error, and never an unbounded scan.
    select least(greatest((p_end - p_start) + 1, 1), 400) as days
  ),
  day_rows as (
    select * from public.trailing_days(p_end, (select days from span))
  ),
  logged as (
    select * from day_rows where meal_count > 0
  ),
  judged as (
    select * from logged where target_calories is not null
  )
  select jsonb_build_object(
    'start', (select min(local_date) from day_rows),
    'end', p_end,
    'window_days', (select count(*) from day_rows),
    'days', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'local_date', local_date,
            'meal_count', meal_count,
            'calories', calories,
            'protein_g', protein_g,
            'carbs_g', carbs_g,
            'fat_g', fat_g,
            'target_calories', target_calories,
            'status', status
          )
          order by local_date
        ),
        '[]'::jsonb
      )
      from day_rows
    ),
    'totals', jsonb_build_object(
      'days_logged', (select count(*) from logged),
      'days_judged', (select count(*) from judged),
      'days_on_track', (select count(*) from judged where status = 'on_track'),
      'adherence_pct', (
        select round(100.0 * count(*) filter (where status = 'on_track') / nullif(count(*), 0))
        from judged
      ),
      'avg_calories', (select round(avg(calories)) from judged),
      'avg_target_calories', (select round(avg(target_calories)) from judged),
      'avg_protein_g', (select round(avg(protein_g), 1) from judged),
      'avg_target_protein_g', (select round(avg(target_protein_g), 1) from judged),
      'avg_carbs_g', (select round(avg(carbs_g), 1) from judged),
      'avg_fat_g', (select round(avg(fat_g), 1) from judged),
      'protein_kcal', (select round(avg(protein_g) * 4) from judged),
      'carbs_kcal', (select round(avg(carbs_g) * 4) from judged),
      'fat_kcal', (select round(avg(fat_g) * 9) from judged),
      'total_meals', (select coalesce(sum(meal_count), 0) from day_rows)
    )
  );
$$;

-- The weight line, with a 7-day rolling average and waist as a second series.
--
-- Rows are the days on which something was measured, not every day in the range: a
-- weigh-in is an event, and interpolating a line across the days nobody stood on the
-- scale would draw measurements that were never taken.
--
-- The rolling average looks back seven days from each measurement and is deliberately
-- *not* restricted to the requested range, so the first point on screen is an average of
-- seven days rather than of however much of the window happens to precede it. Without
-- that, the start of every period would look like a spike.
--
-- Weight is noisy week to week on water and glycogen; that is what the average is for.
-- The raw points stay in the response because hiding them would be a different kind of
-- dishonesty.
create or replace function public.get_weight_series(p_start date, p_end date)
returns table (
  logged_on date,
  weight_kg numeric,
  waist_cm numeric,
  weight_avg_7d numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    w.logged_on,
    w.weight_kg,
    w.waist_cm,
    (
      select round(avg(prior.weight_kg), 2)
      from public.weight_log prior
      where prior.user_id = w.user_id
        and prior.logged_on between w.logged_on - 6 and w.logged_on
    ) as weight_avg_7d
  from public.weight_log w
  where w.user_id = auth.uid()
    and w.logged_on between p_start and p_end
  order by w.logged_on;
$$;

revoke execute on function public.get_period_summary(date, date) from public, anon;
revoke execute on function public.get_weight_series(date, date) from public, anon;
grant execute on function public.get_period_summary(date, date) to authenticated, service_role;
grant execute on function public.get_weight_series(date, date) to authenticated, service_role;
