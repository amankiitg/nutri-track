-- The weight a target was computed from, and the decision about when to recompute.
--
-- Nothing recomputed targets before this: `saveProfileWithTargets` runs from onboarding
-- and Settings only, so as weight falls the TDEE it was derived from falls too and the
-- target does not follow. At 1.55 activity the relationship is exactly 10 x 1.55 = 15.6
-- kcal per kg, so five kilos of unrecorded loss is 78 kcal a day of silent drift.
--
-- The decision is made here and the arithmetic is not. `computeTargets` in
-- `src/lib/targets.ts` is the only definition of the BMR/TDEE/deficit maths and
-- AGENTS.md forbids a second copy, so this function answers "is it stale, and by how
-- much" and the caller does the rest.

-- What the target was derived from. Nullable, and NULL is meaningful rather than
-- missing: every row written before this migration has no basis, and the rule below
-- treats "unknown" as "recompute once, then it is populated". So the first dashboard
-- load after deploy repairs the current row rather than leaving it adrift forever.
alter table public.targets
  add column if not exists weight_kg numeric(5,2);

comment on column public.targets.weight_kg is
  'The weight this target was computed from, in kilograms. NULL means the basis is unknown (written before this column existed).';

-- A typo guard, not a physiological judgement.
alter table public.targets
  drop constraint if exists targets_weight_kg_range;
alter table public.targets
  add constraint targets_weight_kg_range
  check (weight_kg is null or (weight_kg >= 20 and weight_kg <= 400));

-- Should tomorrow's target be recomputed, and from what?
--
-- The basis for the comparison is the trailing 7-day average weight, not the latest
-- reading. A single weigh-in is a noisy estimate of body mass; the average of the last
-- week is what the threshold should be measured against, and it is also the figure the
-- new target is computed from, so the number that triggers the recompute is the number
-- the recompute uses.
--
-- The window is a second guard that falls out of that choice: readings must be within
-- the last seven days, so this fires while someone is actively weighing in and stays
-- quiet when they are not. A stale reading that happens to be 2 kg off does not rewrite
-- anything, because there is nothing recent to suggest the weight has actually changed.
--
-- `needed` is true when there are readings and either the effective target has no basis
-- (self-heal, once) or the average differs from that basis by at least the threshold.
-- Comparison is `>=`: a 1.5 kg threshold means "1.5 kg off is enough", and 1.5 kg is
-- worth 21-29 kcal at every activity level where the calorie floor is not binding,
-- comfortably inside the +/-10% band `calorie_status` already uses.
--
-- `next_effective_from` is returned rather than computed by the caller so that the
-- "tomorrow, never today" rule lives in one place: writing a row under a day already in
-- progress would move the remaining calories while the user is looking at them.
create or replace function public.target_refresh_needed(
  p_today date,
  p_threshold_kg numeric default 1.5,
  p_days integer default 7
)
returns table (
  basis_kg numeric,
  basis_effective_from date,
  average_kg numeric,
  readings integer,
  difference_kg numeric,
  needed boolean,
  next_effective_from date
)
language sql
stable
security invoker
set search_path = public
as $$
  with current_target as (
    select t.weight_kg as basis, t.effective_from
    from public.target_on(p_today) t
  ),
  recent as (
    select
      round(avg(w.weight_kg), 2) as average_kg,
      count(*)::integer as readings
    from public.weight_log w
    where w.user_id = auth.uid()
      and w.logged_on between p_today - (greatest(coalesce(p_days, 7), 1) - 1) and p_today
  )
  select
    ct.basis as basis_kg,
    ct.effective_from as basis_effective_from,
    r.average_kg,
    coalesce(r.readings, 0) as readings,
    case
      when ct.basis is null or r.average_kg is null then null
      else round(abs(r.average_kg - ct.basis), 2)
    end as difference_kg,
    coalesce(
      coalesce(r.readings, 0) > 0
      and r.average_kg is not null
      and (ct.basis is null or abs(r.average_kg - ct.basis) >= p_threshold_kg),
      false
    ) as needed,
    (p_today + 1)::date as next_effective_from
  -- The anchor row means this always returns exactly one row, including for a user with
  -- no target at all. A function the dashboard calls on load should not have a shape
  -- that depends on whether the account is new.
  from (select 1) anchor
  left join current_target ct on true
  left join recent r on true;
$$;

revoke execute on function public.target_refresh_needed(date, numeric, integer) from public, anon;
grant execute on function public.target_refresh_needed(date, numeric, integer) to authenticated, service_role;
