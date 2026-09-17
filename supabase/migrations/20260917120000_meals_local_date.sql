-- The day a meal belongs to, recorded when the meal is written rather than derived when it is read.
--
-- Until now every screen derived a meal's day from `eaten_at` and the profile's *current*
-- timezone, in exactly one place: the `daily_summaries` view. Everything else — `daily_totals`,
-- `trailing_days`, `week_verdict`, `get_period_summary`, `get_weight_series` and the period
-- buckets — reads `local_date` from it. `meals_for_day` carried a second copy of the expression.
--
-- That made the day boundary a function of a setting, which is why the app has never followed the
-- device: changing the timezone re-cut every historical day. Recording the day at write time is
-- what makes a timezone change mean "from now on" instead of "always has been".
--
-- **The backfill uses the profile's current timezone, which is the same expression the view
-- evaluated before this migration.** That is deliberate and it is the only choice that cannot
-- invent history: any other value would silently move existing meals between days, with no way to
-- tell which. The residual cost, stated rather than hidden: if a profile's zone changed in the
-- past, those meals are recorded on the day they were written *as of the zone today*, not the zone
-- at the time. That is what the app already showed, so nothing on screen moves — verified by
-- comparing the aggregate totals and a hash of every row before and after applying this.

-- 1. The column, nullable to begin with so the backfill can fill it.
alter table public.meals add column local_date date;

-- 2. Backfill, using the pre-migration expression verbatim: same coalesce, same date cast.
update public.meals m
   set local_date = (m.eaten_at at time zone coalesce(p.timezone, 'UTC'))::date
  from public.profiles p
 where p.user_id = m.user_id;

-- 3. A meal whose owner has no profile row cannot be dated, and this stops the migration rather
--    than letting one through. Such a meal is also invisible today, because the view joins
--    profiles with an inner join, so this should be unreachable — measured 0 of 48 when written.
alter table public.meals alter column local_date set not null;

-- 4. Written by the table itself, so every writer agrees and a future one cannot forget. A trigger
--    rather than a default, because it depends on another table and on `eaten_at`, which can be
--    changed after the fact. `before insert or update of eaten_at` means an insert from any path —
--    `save_meal` today, anything tomorrow — gets the day without having to know this rule.
create or replace function public.set_meal_local_date()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.local_date := (new.eaten_at at time zone coalesce(
    (select p.timezone from public.profiles p where p.user_id = new.user_id), 'UTC'))::date;
  return new;
end;
$$;

create trigger meals_set_local_date
  before insert or update of eaten_at on public.meals
  for each row execute function public.set_meal_local_date();

-- 5. The one place a day was derived. The inner join to profiles is kept even though the timezone
--    is no longer read from it: the join is what decides which meals are visible, and removing it
--    would surface meals whose owner has no profile row — a change in the data, not in the fix.
create or replace view public.daily_summaries with (security_invoker = true) as
with meal_days as (
  select m.id as meal_id, m.user_id, m.local_date
  from public.meals m
  join public.profiles p on p.user_id = m.user_id
  where m.deleted_at is null
),
agg as (
  select md.user_id, md.local_date,
         count(distinct md.meal_id) as meal_count,
         coalesce(sum(mi.calories), 0) as calories,
         coalesce(sum(mi.protein_g), 0) as protein_g,
         coalesce(sum(mi.carbs_g), 0) as carbs_g,
         coalesce(sum(mi.fat_g), 0) as fat_g,
         coalesce(sum(mi.fiber_g), 0) as fiber_g
  from meal_days md
  join public.meal_items mi on mi.meal_id = md.meal_id
  group by md.user_id, md.local_date
)
select a.user_id, a.local_date, a.meal_count, a.calories, a.protein_g, a.carbs_g, a.fat_g, a.fiber_g,
       t.calories as target_calories, t.protein_g as target_protein_g,
       t.carbs_g as target_carbs_g, t.fat_g as target_fat_g,
       case
         when t.calories is null then null
         when a.calories < t.calories * 0.9 then 'under'
         when a.calories > t.calories * 1.1 then 'over'
         else 'on_track'
       end as status
from agg a
left join lateral (
  select * from public.targets t
  where t.user_id = a.user_id and t.effective_from <= a.local_date
  order by t.effective_from desc limit 1
) t on true;

-- 6. The second copy of the derivation. Replaced textually rather than retyped, because retyping
--    the whole body is how an unrelated edit gets introduced; and guarded, because a replacement
--    that silently matches nothing would leave this function deriving a day while the view no
--    longer does — two readers disagreeing about which day a meal is on, which is worse than
--    either behaviour on its own.
do $$
declare
  original text;
  patched  text;
begin
  original := pg_get_functiondef('public.meals_for_day(date)'::regprocedure);
  patched  := replace(
    original,
    '(m.eaten_at at time zone coalesce(p.timezone, ''UTC''))::date = p_date',
    'm.local_date = p_date');

  if patched = original then
    raise exception
      'meals_for_day still derives its day: the expected expression was not found, so nothing was replaced';
  end if;

  execute patched;
end;
$$;
