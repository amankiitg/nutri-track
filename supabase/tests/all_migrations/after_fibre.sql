-- Runtime checks for the fibre migration, over synthetic rows only.
--
-- The migration test proves the file applies; the functions it replaces can still fail when
-- called (an ambiguous column or a grouped select over a scalar subquery both parse and only
-- fail at execution). These fixtures are three complete days of 10, 20 and 30 g of fibre, one
-- meal each, so the weekly average is 20.0 and the default target is 30.

\set ON_ERROR_STOP on

insert into public.profiles
  (user_id, display_name, dob, sex, height_cm, weight_kg, activity_level, goal, timezone)
values
  ('00000000-0000-0000-0000-00000000f001', 'Fibre fixture', '1994-01-01', 'female',
   165, 70, 'moderately_active', 'maintain', 'UTC');

insert into public.targets
  (user_id, effective_from, calories, protein_g, carbs_g, fat_g)
values
  ('00000000-0000-0000-0000-00000000f001', current_date - 30, 2000, 110, 220, 60);

insert into public.meals
  (user_id, eaten_at, meal_type, source, input_fingerprint)
values
  ('00000000-0000-0000-0000-00000000f001',
   ((current_date - 1) + time '12:00')::timestamp at time zone 'UTC',
   'lunch', 'text', 'fibre-day-1'),
  ('00000000-0000-0000-0000-00000000f001',
   ((current_date - 2) + time '12:00')::timestamp at time zone 'UTC',
   'lunch', 'text', 'fibre-day-2'),
  ('00000000-0000-0000-0000-00000000f001',
   ((current_date - 3) + time '12:00')::timestamp at time zone 'UTC',
   'lunch', 'text', 'fibre-day-3');

insert into public.meal_items
  (meal_id, name, calories, protein_g, carbs_g, fat_g, fiber_g)
select id, 'Fibre ' || input_fingerprint, 400, 20, 40, 10,
  case input_fingerprint when 'fibre-day-1' then 30 when 'fibre-day-2' then 20 else 10 end
from public.meals
where user_id = '00000000-0000-0000-0000-00000000f001';

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000f001', false);
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000f001","email":"fibre@example.com"}',
  false
);

do $$
declare
  v_avg numeric;
  v_target numeric;
  v_meal jsonb;
  v_summary jsonb;
  v_bucket_avg numeric;
  v_stored_target numeric;
begin
  select fiber_target_g into v_stored_target
  from public.profiles
  where user_id = '00000000-0000-0000-0000-00000000f001';
  if v_stored_target is distinct from 30 then
    raise exception 'default fiber_target_g is %, expected 30', v_stored_target;
  end if;

  select avg_fiber_g, avg_target_fiber_g into v_avg, v_target
  from public.week_verdict(current_date, 7);
  if v_avg is distinct from 20.0 then
    raise exception 'week_verdict avg_fiber_g is %, expected 20.0', v_avg;
  end if;
  if v_target is distinct from 30 then
    raise exception 'week_verdict avg_target_fiber_g is %, expected 30', v_target;
  end if;

  select public.meals_for_day(current_date - 1) into v_meal;
  if (v_meal -> 0 ->> 'fiber_g')::numeric is distinct from 30 then
    raise exception 'meals_for_day fiber_g is %, expected 30', v_meal -> 0 ->> 'fiber_g';
  end if;

  select public.get_period_summary(current_date - 3, current_date - 1, 'day', null)
    into v_summary;
  if (v_summary -> 'totals' ->> 'avg_fiber_g')::numeric is distinct from 20.0 then
    raise exception 'period avg_fiber_g is %, expected 20.0',
      v_summary -> 'totals' ->> 'avg_fiber_g';
  end if;
  select (bucket ->> 'avg_fiber_g')::numeric into v_bucket_avg
  from jsonb_array_elements(v_summary -> 'buckets') bucket
  where bucket ->> 'bucket_start' = (current_date - 3)::text;
  if v_bucket_avg is distinct from 10.0 then
    raise exception 'first bucket avg_fiber_g is %, expected 10.0', v_bucket_avg;
  end if;

  update public.profiles set fiber_target_g = 25
  where user_id = '00000000-0000-0000-0000-00000000f001';
  select avg_target_fiber_g into v_target from public.week_verdict(current_date, 7);
  if v_target is distinct from 25 then
    raise exception 'week_verdict did not follow the edited target: %', v_target;
  end if;
end $$;

\echo 'ok - fibre totals, meal totals, weekly average and period buckets read the stored rows'
