-- A soft-deleted meal must not claim its fingerprint or its idempotency key.
--
-- `save_meal` looked both up without filtering `deleted_at`, and neither unique index
-- excluded deleted rows. So after deleting a meal, re-logging the same photo with the
-- same (or no) note inside the same ten-minute fingerprint bucket found the deleted
-- row, returned it as `{created: false}`, and wrote nothing — the app reported a save
-- that never happened. Measured before this migration: the lookup resolved to the
-- deleted meal, and the insert that would have followed was rejected by
-- `meals_user_fingerprint_uniq`.
--
-- Both halves are needed and neither is sufficient:
--   - with only the filter, the lookup misses and the insert then raises, turning a
--     silent no-save into a user-visible unique violation at the end of a paid model
--     call — a different failure, not a smaller one;
--   - with only a partial index, the lookup still finds the deleted row.
--
-- The indexes come first so that no intermediate state can pair a filtered lookup with
-- a plain index.

-- `if exists` and no `concurrently`: migrations run in one transaction, and this table
-- is small enough that the brief exclusive lock is not worth the complexity.
drop index if exists public.meals_user_fingerprint_uniq;
create unique index meals_user_fingerprint_uniq
  on public.meals (user_id, input_fingerprint)
  where deleted_at is null;

drop index if exists public.meals_user_idempotency_uniq;
create unique index meals_user_idempotency_uniq
  on public.meals (user_id, idempotency_key)
  where deleted_at is null;

-- This replaces the earlier note that chose a plain index so that
-- `on conflict (user_id, idempotency_key)` could infer it. Nothing in this repository
-- uses that form — the only writers are `save_meal`, which looks up and then inserts.
-- A partial index is still inferable, but the conflict target must name the predicate:
-- `on conflict (user_id, idempotency_key) where deleted_at is null`. If a future upsert
-- is written without that clause Postgres will not find an arbiter and will error,
-- which is the loud version of this hazard rather than a silent one.
--
-- NULLs remain distinct in a partial unique index, so rows saved without a key or
-- without a fingerprint are still not in conflict with each other.
--
-- The function below is replaced in place rather than dropped and recreated. Dropping a
-- function drops its ACL with it, and this one is not default: `20260911150000` revoked
-- EXECUTE from public and anon, so a drop would hand EXECUTE back to PUBLIC and make anon
-- able to write meals. `create or replace` keeps the ACL, and the grants are restated
-- after it anyway, so any drift is corrected here rather than inherited.

/**
 * Writes a meal and its items in one transaction, as the calling user, under RLS.
 *
 * Idempotent in two ways, both of them now scoped to meals that still exist:
 *   - a repeated `idempotency_key` returns the original meal untouched;
 *   - an `input_fingerprint` that already exists returns that meal instead of
 *     raising, so the UI can offer "you already logged this, open it?".
 *
 * A soft-deleted meal is in neither set. Its fingerprint is free to be used again,
 * which is what makes delete-then-re-log work, and its key is free too — otherwise the
 * filter above would only move the collision to the index.
 *
 * Returns { meal_id, created } where `created` is false when an existing live meal was
 * returned. Never touches another user's rows: user_id is taken from auth.uid() and the
 * insert policies re-check it.
 */
create or replace function public.save_meal(_meal jsonb, _items jsonb)
returns jsonb
language plpgsql
security invoker
set search_path to 'public'
as $function$
declare
  _user_id uuid := auth.uid();
  _meal_id uuid;
  _key uuid := nullif(_meal ->> 'idempotency_key', '')::uuid;
  _fingerprint text := _meal ->> 'input_fingerprint';
begin
  if _user_id is null then
    raise exception 'save_meal requires an authenticated user' using errcode = '28000';
  end if;

  if _fingerprint is null or _fingerprint = '' then
    raise exception 'save_meal requires input_fingerprint' using errcode = '22004';
  end if;

  -- Idempotent replay: same key, same answer, nothing written. Scoped to live meals,
  -- because the key of a meal the user deleted should not block a fresh save.
  if _key is not null then
    select id into _meal_id
      from public.meals
     where user_id = _user_id and idempotency_key = _key and deleted_at is null;
    if _meal_id is not null then
      return jsonb_build_object('meal_id', _meal_id, 'created', false);
    end if;
  end if;

  -- Exact repeat of a meal already logged: return it rather than violating the unique
  -- fingerprint index. A deleted meal is not a repeat of anything, so it is excluded —
  -- the same rule the dashboard, the day view and the duplicate banner all follow.
  select id into _meal_id
    from public.meals
   where user_id = _user_id and input_fingerprint = _fingerprint and deleted_at is null;
  if _meal_id is not null then
    return jsonb_build_object('meal_id', _meal_id, 'created', false);
  end if;

  insert into public.meals (
    user_id, eaten_at, meal_type, source, notes,
    photo_paths, photo_hashes, input_fingerprint, idempotency_key
  )
  values (
    _user_id,
    coalesce(nullif(_meal ->> 'eaten_at', '')::timestamptz, now()),
    (_meal ->> 'meal_type')::public.meal_type,
    (_meal ->> 'source')::public.meal_source,
    nullif(_meal ->> 'notes', ''),
    array(select jsonb_array_elements_text(coalesce(_meal -> 'photo_paths', '[]'::jsonb))),
    array(select jsonb_array_elements_text(coalesce(_meal -> 'photo_hashes', '[]'::jsonb))),
    _fingerprint,
    _key
  )
  returning id into _meal_id;

  insert into public.meal_items (
    meal_id, name, quantity, unit, grams, calories, protein_g, carbs_g, fat_g,
    fiber_g, sugar_g, sodium_mg, confidence, user_edited, llm_raw
  )
  select
    _meal_id,
    item ->> 'name',
    nullif(item ->> 'quantity', '')::numeric,
    nullif(item ->> 'unit', ''),
    nullif(item ->> 'grams', '')::numeric,
    coalesce(nullif(item ->> 'calories', '')::numeric, 0),
    coalesce(nullif(item ->> 'protein_g', '')::numeric, 0),
    coalesce(nullif(item ->> 'carbs_g', '')::numeric, 0),
    coalesce(nullif(item ->> 'fat_g', '')::numeric, 0),
    nullif(item ->> 'fiber_g', '')::numeric,
    nullif(item ->> 'sugar_g', '')::numeric,
    nullif(item ->> 'sodium_mg', '')::numeric,
    nullif(item ->> 'confidence', '')::numeric,
    coalesce((item ->> 'user_edited')::boolean, false),
    item -> 'llm_raw'
  from jsonb_array_elements(coalesce(_items, '[]'::jsonb)) as item;

  return jsonb_build_object('meal_id', _meal_id, 'created', true);
end $function$;
-- Not a no-op on a `create or replace`: it makes the privilege explicit here, so this
-- file is the whole story of what the function is allowed to do.
revoke execute on function public.save_meal(jsonb, jsonb) from public, anon;
grant execute on function public.save_meal(jsonb, jsonb) to authenticated;

-- The migration is worthless if either half silently did not apply, and a plain index
-- looks like nothing at all from the outside: it accepts every write this change was
-- made to allow, and rejects the one it was made to allow.
do $guard$
declare
  _fingerprint_index text;
  _idempotency_index text;
  _body text;
  _filters int;
begin
  select indexdef into _fingerprint_index from pg_indexes
   where schemaname = 'public' and indexname = 'meals_user_fingerprint_uniq';
  if _fingerprint_index is null or _fingerprint_index not ilike '%deleted_at is null%' then
    raise exception 'meals_user_fingerprint_uniq is not partial: %', _fingerprint_index;
  end if;

  select indexdef into _idempotency_index from pg_indexes
   where schemaname = 'public' and indexname = 'meals_user_idempotency_uniq';
  if _idempotency_index is null or _idempotency_index not ilike '%deleted_at is null%' then
    raise exception 'meals_user_idempotency_uniq is not partial: %', _idempotency_index;
  end if;

  -- Counted rather than merely found: one filtered lookup and one unfiltered one is
  -- exactly the broken state this migration exists to prevent, and `ilike '%and
  -- deleted_at is null%'` cannot tell them apart. `regexp_count` is not used so this
  -- does not depend on the server version.
  select prosrc into _body from pg_proc
   where proname = 'save_meal' and pronamespace = 'public'::regnamespace;
  _filters := (
    length(lower(_body)) - length(replace(lower(_body), 'and deleted_at is null', ''))
  ) / length('and deleted_at is null');
  if _filters <> 2 then
    raise exception 'save_meal has % filtered lookups, expected 2', _filters;
  end if;
end $guard$;
