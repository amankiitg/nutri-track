-- A stable order for the day, and for the items in each meal.
--
-- Two rules were missing, and neither was an error, which is why neither was noticed:
--
--   * `jsonb_agg(entry order by entry ->> 'eaten_at')` sorted by the *text* of a timestamp. Two
--     meals eaten at the same time had no defined order between them, so a reload could show them
--     swapped (reported with two meals at 20:08).
--   * items were ordered by `created_at` alone, and every item of a meal is inserted by one
--     statement, so they all share a `created_at`. Their order was whatever the plan produced,
--     which is how "Bhel puri" and "Kombucha" swapped between visits.
--
-- The tiebreakers are the row ids. An id is arbitrary, but it is stable, and a stable arbitrary
-- order is what the screen needs: an order that changes between two identical requests is the bug.
--
-- `m.local_date = p_date` is the stored day and has to stay that way. The version before
-- 20260917120000 derived the day from `eaten_at` and the profile's timezone, which re-cut history
-- when the timezone changed; 20260917120000 replaced that expression textually, and this
-- replacement is written from that version rather than from the older text. The guard below fails
-- if this file ever puts the derivation back.

create or replace function public.meals_for_day(p_date date)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $function$
  select coalesce(jsonb_agg(entry order by eaten_at, created_at, id), '[]'::jsonb)
  from (
    select
      m.eaten_at,
      m.created_at,
      m.id,
      jsonb_build_object(
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
            order by mi.created_at, mi.id
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
$function$;

-- `create or replace` keeps the ACL, but stating it here means this file is the whole story of
-- who may call the function rather than a diff against an older one.
revoke execute on function public.meals_for_day(date) from public, anon;
grant execute on function public.meals_for_day(date) to authenticated, service_role;

do $guard$
declare
  _body text;
begin
  select prosrc into _body
    from pg_proc
   where proname = 'meals_for_day' and pronamespace = 'public'::regnamespace;

  if _body is null then
    raise exception 'meals_for_day was not created';
  end if;
  if strpos(lower(_body), 'order by mi.created_at, mi.id') = 0 then
    raise exception 'meals_for_day no longer breaks item ties on id';
  end if;
  if strpos(lower(_body), 'order by eaten_at, created_at, id') = 0 then
    raise exception 'meals_for_day no longer orders meals deterministically';
  end if;
  -- The stored day is the point of 20260917120000. A replacement written from older text would
  -- restore the read-time derivation silently, and nothing on screen would look wrong until a
  -- timezone changed.
  if strpos(lower(_body), 'm.local_date = p_date') = 0 then
    raise exception 'meals_for_day no longer reads the stored day';
  end if;
  if strpos(lower(_body), 'at time zone') > 0 then
    raise exception 'meals_for_day derives the day again';
  end if;
end $guard$;
