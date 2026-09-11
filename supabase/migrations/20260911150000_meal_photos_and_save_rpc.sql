-- meals carried singular photo_path / photo_hash from Prompt 1, which cannot hold
-- the "up to 3 photos per meal" the capture flow produces. They are replaced with
-- parallel arrays rather than keeping a "primary photo" alongside, so the path and
-- its hash cannot drift apart. meals has zero rows, so nothing needs migrating.
--
-- Also adds the client-supplied idempotency key and the save_meal RPC that writes
-- a meal and its items in one transaction.

-- The partial index on the old column goes with it; drop explicitly for clarity.
drop index if exists public.meals_user_photo_hash_idx;

alter table public.meals
  drop column if exists photo_path,
  drop column if exists photo_hash,
  add column photo_paths text[] not null default '{}',
  add column photo_hashes text[] not null default '{}',
  add column idempotency_key uuid;

-- Any of the up to three photos matching in the last 24 hours is a duplicate, so
-- this is an overlap test rather than equality.
create index meals_photo_hashes_idx on public.meals using gin (photo_hashes);

alter table public.meals
  add constraint meals_photo_paths_max3 check (cardinality(photo_paths) <= 3),
  add constraint meals_photo_hashes_max3 check (cardinality(photo_hashes) <= 3),
  -- One hash per path: the two arrays are positional, so a mismatch would make the
  -- dedupe lookups and the meal-card thumbnail disagree.
  add constraint meals_photo_arrays_match
    check (cardinality(photo_paths) = cardinality(photo_hashes));

-- Plain (not partial) unique index: ON CONFLICT (user_id, idempotency_key) cannot
-- infer a partial index, and NULLs are distinct so rows without a key are fine.
create unique index meals_user_idempotency_uniq
  on public.meals (user_id, idempotency_key);

/**
 * Writes a meal and its items in one transaction, as the calling user, under RLS.
 *
 * Idempotent in two ways:
 *   - a repeated `idempotency_key` returns the original meal untouched;
 *   - an `input_fingerprint` that already exists returns that meal instead of
 *     raising, so the UI can offer "you already logged this, open it?".
 *
 * Returns { meal_id, created } where `created` is false when an existing meal was
 * returned. Never touches another user's rows: user_id is taken from auth.uid()
 * and the insert policies re-check it.
 */
create or replace function public.save_meal(_meal jsonb, _items jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
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

  -- Idempotent replay: same key, same answer, nothing written.
  if _key is not null then
    select id into _meal_id
      from public.meals
     where user_id = _user_id and idempotency_key = _key;
    if _meal_id is not null then
      return jsonb_build_object('meal_id', _meal_id, 'created', false);
    end if;
  end if;

  -- Exact repeat of a meal already logged: return it rather than violating the
  -- unique fingerprint index.
  select id into _meal_id
    from public.meals
   where user_id = _user_id and input_fingerprint = _fingerprint;
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
end $$;

revoke execute on function public.save_meal(jsonb, jsonb) from public, anon;
grant execute on function public.save_meal(jsonb, jsonb) to authenticated;
