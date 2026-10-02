-- CORRECTION: editing a meal that is already on the record.
--
-- NOT APPLIED YET. Written to be read before it is run.
--
-- Until now a meal could be created, shown, copied and soft-deleted, but never corrected. The
-- only way to fix a wrong number was to delete the meal and log it again, which threw away the
-- row's own history: `llm_raw` went with it, and the photos came back associated with a new row.
--
-- A second function rather than a mode on `save_meal`, for two reasons that are both about
-- `save_meal` doing its own job well:
--
--   1. `save_meal` is idempotent on purpose. A repeated `input_fingerprint` returns the existing
--      meal untouched and writes nothing, which is right for a retry and exactly wrong for a
--      correction — whose whole purpose is to change numbers on a row that already exists.
--   2. `save_meal` owns creation, so it sets the fingerprint, the idempotency key, the photos and
--      the source. An edit owns none of those. Merging the two would put a "do not write these"
--      list inside the function that writes them, which is a rule that cannot be enforced by
--      reading the code around it.
--
-- WHAT AN EDIT MAY CHANGE: the time eaten, the meal type, the notes, and the items.
--
-- WHAT IT MAY NOT, and why:
--   * `input_fingerprint` and `idempotency_key` are how this meal was recognised when it was
--     logged. Rewriting them would re-open a duplicate question that has already been answered,
--     and could collide with a *different* meal through the partial unique indexes.
--   * `photo_paths` and `photo_hashes` belong to the capture. Correcting the food does not change
--     which photographs were taken of it.
--   * `source` records how these numbers were obtained, which is provenance rather than content.
--   * `deleted_at` is the timeline's business, not the editor's. An edit of a soft-deleted meal
--     is refused outright, below.
--
-- `user_id` and `created_at` are absent for the same reason: an edit does not change whose meal
-- it is or when it was first written.
--
-- `local_date` is the one field an edit changes without naming it. The `before insert or update
-- of eaten_at` trigger from 20260917120000 recomputes it from the profile's zone at that moment,
-- so moving a meal's time across a day boundary moves the day with it — the rule every other
-- writer follows, and the reason the day is stored rather than derived.
--
-- That trigger is also why the time is written in a statement of its own, and only when it moved.
-- Naming `eaten_at` fires it whether or not the value changed, which would recompute the meal's
-- day from the profile's zone as it is *now*: on a meal logged before a timezone change, editing
-- the food on it would move that meal to another day, one meal at a time, through the back door of
-- a control that has nothing to do with days. Splitting the statement is what makes an edit which
-- does not touch the time unable to touch the day.
--
-- The bound on that claim, stated rather than left implied: a JS `Date` holds milliseconds where
-- the column holds microseconds, so a stored time with sub-millisecond precision would compare as
-- changed when it had not, and its day would be recomputed after all. Every meal this app has
-- written is millisecond precision, because the client sends `Date.prototype.toISOString()`, so
-- this cannot bite today. Left unsolved deliberately — closing it means deciding which of two
-- unequal instants is the real one, and the honest answer is that neither was intentional.
--
-- `edited_at` is set here and only here. A trigger could not do it: a trigger on `meals` cannot
-- tell this writer from `save_meal`, so it would mark a meal's creation as an edit of it.

alter table public.meals add column if not exists edited_at timestamptz;

/**
 * Writes an edit to a meal and its items in one transaction, as the calling user, under RLS.
 *
 * The item list is the whole meal as the review screen leaves it, and is reconciled rather than
 * appended to:
 *   * an item carrying `existing_item_id` is that row of this meal, and is updated in place;
 *   * an item without it is new, and is inserted;
 *   * a row of this meal that the payload no longer names has been removed on the screen, and is
 *     deleted.
 *
 * `llm_raw` is written only by the insert, and the model's original reply for an existing row
 * therefore survives any number of corrections. That is the reason the column exists.
 *
 * Returns { meal_id, updated }. Raises `P0002` when the meal is not this user's, is not there, or
 * has been soft-deleted, and `22023` when the payload would leave the meal with no items or name
 * one item twice. The client turns both into a sentence; the text here is for a log, and names no
 * table, column or constraint, because PostgREST hands function errors to a phone.
 */
create or replace function public.update_meal(_meal_id uuid, _meal jsonb, _items jsonb)
returns jsonb
language plpgsql
security invoker
set search_path to 'public'
as $function$
declare
  _user_id uuid := auth.uid();
  _found uuid;
  _stored_at timestamptz;
  _keep uuid[];
  _named int;
  _updated int;
begin
  if _user_id is null then
    raise exception 'update_meal requires an authenticated user' using errcode = '28000';
  end if;

  -- Locked, not merely read. The reconciliation below deletes rows this meal owns, so a
  -- concurrent hard delete or a timeline undo must not land between reading the meal and
  -- rewriting its items.
  select m.id, m.eaten_at into _found, _stored_at
    from public.meals m
   where m.id = _meal_id
     and m.user_id = _user_id
     and m.deleted_at is null
     for update;

  if _found is null then
    raise exception 'update_meal: that meal is not on this user''s record' using errcode = 'P0002';
  end if;

  -- The rows the payload still claims. An item with no `existing_item_id` is a new one, which is
  -- the same absent-key convention the payload uses for the model's own output.
  select coalesce(array_agg((item ->> 'existing_item_id')::uuid), '{}'::uuid[])
    into _keep
    from jsonb_array_elements(coalesce(_items, '[]'::jsonb)) as item
   where nullif(item ->> 'existing_item_id', '') is not null;

  _named := coalesce(cardinality(_keep), 0);

  -- Checked before anything is written, so a payload that cannot be honoured leaves the meal as
  -- it was rather than halfway through.
  if coalesce(jsonb_array_length(coalesce(_items, '[]'::jsonb)), 0) = 0 then
    raise exception 'update_meal: a meal cannot be left with no items' using errcode = '22023';
  end if;

  -- One row named twice would be written twice, with whichever copy the planner processed last
  -- deciding the numbers. That is not a state to leave to chance, and it is invisible from the
  -- outside: the meal would be saved, and simply hold a number nobody typed.
  if _named <> (select count(distinct k) from unnest(_keep) as k) then
    raise exception 'update_meal: an item was named more than once' using errcode = '22023';
  end if;

  -- The meal row. Only the fields an edit owns; see the note at the top of this file for what is
  -- deliberately missing from this list. `notes` is normalised exactly as `save_meal` normalises
  -- it — `nullif` on the empty string — so an emptied box stores SQL NULL rather than an empty
  -- string, and the same meal reads the same however it was written.
  --
  -- Note what is absent: the time. It is written separately, immediately below, and only when it
  -- moved, so that the statement which fires the day trigger is not the statement that runs on
  -- every edit.
  update public.meals m
     set meal_type = coalesce(nullif(_meal ->> 'meal_type', '')::public.meal_type, m.meal_type),
         notes = nullif(_meal ->> 'notes', ''),
         edited_at = now()
   where m.id = _found;

  -- The time, and the only place the day can move. Two conditions, and both matter: the payload
  -- has to carry a time at all, and it has to be a different instant from the one stored. The
  -- comparison is between timestamps rather than strings, so `12:05:00Z` and `12:05:00+00:00` are
  -- recognised as the same moment and neither counts as a change.
  --
  -- A payload with no time leaves the stored one alone rather than clearing it: the column is NOT
  -- NULL, and an omitted key is not a request to unset it.
  if nullif(_meal ->> 'eaten_at', '') is not null
     and (_meal ->> 'eaten_at')::timestamptz is distinct from _stored_at then
    update public.meals m
       set eaten_at = (_meal ->> 'eaten_at')::timestamptz
     where m.id = _found;
  end if;

  -- Removing an item on the review screen removes its row. `_keep` is empty when every item was
  -- replaced, and `<> all ('{}')` is true of every row, so a fully replaced meal is emptied here
  -- and refilled by the insert below.
  delete from public.meal_items mi
   where mi.meal_id = _found
     and mi.id <> all (_keep);

  -- Updated in place. The columns not named here are the ones an edit must not touch: the row's
  -- id, the meal it belongs to, when it was created, and the model's original reply — which this
  -- statement therefore cannot overwrite however incomplete the payload is.
  update public.meal_items mi
     set name = item ->> 'name',
         quantity = nullif(item ->> 'quantity', '')::numeric,
         unit = nullif(item ->> 'unit', ''),
         grams = nullif(item ->> 'grams', '')::numeric,
         calories = coalesce(nullif(item ->> 'calories', '')::numeric, 0),
         protein_g = coalesce(nullif(item ->> 'protein_g', '')::numeric, 0),
         carbs_g = coalesce(nullif(item ->> 'carbs_g', '')::numeric, 0),
         fat_g = coalesce(nullif(item ->> 'fat_g', '')::numeric, 0),
         fiber_g = nullif(item ->> 'fiber_g', '')::numeric,
         sugar_g = nullif(item ->> 'sugar_g', '')::numeric,
         sodium_mg = nullif(item ->> 'sodium_mg', '')::numeric,
         confidence = nullif(item ->> 'confidence', '')::numeric,
         user_edited = coalesce((item ->> 'user_edited')::boolean, false)
    from jsonb_array_elements(coalesce(_items, '[]'::jsonb)) as item
   where mi.meal_id = _found
     and mi.id = nullif(item ->> 'existing_item_id', '')::uuid;

  get diagnostics _updated = row_count;

  -- Every named row has to have been this meal's. Without this the failure is silent and one
  -- sided: a row id belonging to another meal updates nothing and is not in `_keep`, so it has
  -- already been deleted two statements up — the item would silently vanish while the payload
  -- still carried its numbers, and the person would be told the edit was saved. Raising rolls the
  -- whole call back instead.
  if _updated <> _named then
    raise exception 'update_meal: % of % named items are not on meal %',
      _named - _updated, _named, _found
      using errcode = 'P0002';
  end if;

  -- The new items. The model's original reply is stored for these and only these: they have no
  -- earlier value to protect. An item typed by hand arrives without the key, so the value read
  -- from the payload is a SQL NULL and the column is empty rather than holding a JSON null.
  insert into public.meal_items (
    meal_id, name, quantity, unit, grams, calories, protein_g, carbs_g, fat_g,
    fiber_g, sugar_g, sodium_mg, confidence, user_edited, llm_raw
  )
  select
    _found,
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
  from jsonb_array_elements(coalesce(_items, '[]'::jsonb)) as item
   where nullif(item ->> 'existing_item_id', '') is null;

  return jsonb_build_object('meal_id', _found, 'updated', true);
end $function$;

-- Not a no-op on a `create or replace`: it makes the privilege explicit in this file, so the
-- answer to "who may correct a meal?" is here rather than inherited. `update_meal` writes, so it
-- is narrowed the same way `save_meal` is — revoked from PUBLIC first, because a function is
-- executable by PUBLIC until someone says otherwise.
revoke execute on function public.update_meal(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.update_meal(uuid, jsonb, jsonb) to authenticated;

-- The migration is worthless if it silently did not apply, and every failure below is invisible
-- from the outside: the function would exist, be callable, and be missing the one property that
-- makes it safe. So each claim this file makes is checked rather than assumed.
do $guard$
declare
  _body text;
  _prosecdef boolean;
  _inserts int;
  _name text;
  -- Named, not written. `deleted_at` is deliberately not in this list: the function has to *read*
  -- it to refuse a meal that has been deleted, and a blanket absence check would forbid that.
  _protected text[] := array[
    'input_fingerprint', 'idempotency_key', 'photo_paths', 'photo_hashes', 'source'
  ];
begin
  -- 1. The column an edit is recorded in.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'meals' and column_name = 'edited_at'
  ) then
    raise exception 'meals.edited_at was not added';
  end if;

  -- 2. Invoker rights. A `security definer` version would read and write rows the caller cannot
  --    see, which is the opposite of how every other writer in this schema works.
  select prosrc, prosecdef into _body, _prosecdef
    from pg_proc
   where proname = 'update_meal' and pronamespace = 'public'::regnamespace;

  if _body is null then
    raise exception 'update_meal was not created';
  end if;
  if _prosecdef then
    raise exception 'update_meal is security definer; it must run as the caller';
  end if;

  -- 3. Nobody but a signed-in user may call it.
  if has_function_privilege('anon', 'public.update_meal(uuid, jsonb, jsonb)', 'EXECUTE') then
    raise exception 'anon may execute update_meal';
  end if;
  if not has_function_privilege(
       'authenticated', 'public.update_meal(uuid, jsonb, jsonb)', 'EXECUTE') then
    raise exception 'authenticated may not execute update_meal';
  end if;

  -- 4. Provenance is untouched *because the function never names it*. That is an absence, so it is
  --    checked against every protected column rather than the one that happens to be on the
  --    author's mind. A later edit that adds `notes` and `photo_paths` to the same SET list fails
  --    here rather than quietly widening what a correction can rewrite.
  foreach _name in array _protected loop
    if strpos(lower(_body), _name) > 0 then
      raise exception 'update_meal names %, which an edit must not write', _name;
    end if;
  end loop;

  -- 4b. `deleted_at` is read and not written, which are two different claims. An assignment to it
  --     is a write; the filter in the lookup is the refusal of a deleted meal, and its absence
  --     would mean an edit could resurrect a row the timeline had removed.
  if strpos(lower(_body), 'deleted_at =') > 0 then
    raise exception 'update_meal assigns deleted_at';
  end if;
  if strpos(lower(_body), 'm.deleted_at is null') = 0 then
    raise exception 'update_meal no longer refuses a soft-deleted meal';
  end if;

  -- 5. The model's original reply is written by the insert and by nothing else. Stated as three
  --    claims that survive a comment mentioning the column — where a count of the literal would
  --    not — and one of which is about the amount of writing that can happen at all.
  if strpos(lower(_body), 'llm_raw =') > 0 then
    raise exception 'update_meal assigns llm_raw, which must survive a correction';
  end if;
  if strpos(lower(_body), 'item -> ''llm_raw''') = 0 then
    raise exception 'update_meal no longer stores the model output for a new item';
  end if;
  _inserts := (
    length(lower(_body)) - length(replace(lower(_body), 'insert into public.meal_items', ''))
  ) / length('insert into public.meal_items');
  if _inserts <> 1 then
    raise exception 'update_meal inserts into meal_items % times, expected 1', _inserts;
  end if;

  -- 6. The edit is stamped. Without this the column exists and nothing ever fills it.
  if strpos(lower(_body), 'edited_at = now()') = 0 then
    raise exception 'update_meal does not stamp edited_at';
  end if;

  -- 7. The time is written in a statement of its own, and only when it moved. The failure this
  --    guards is the one the split exists for and is invisible from outside: putting `eaten_at`
  --    back into the main SET list would fire the day trigger on every edit, so an edit that
  --    changes only the food could still move the meal to another day.
  if strpos(lower(_body), 'set eaten_at') = 0 then
    raise exception 'update_meal no longer writes the time in its own statement';
  end if;
  if strpos(lower(_body), 'is distinct from') = 0 then
    raise exception 'update_meal no longer compares the time before writing it';
  end if;
  if strpos(lower(_body), 'eaten_at = coalesce(') > 0 then
    raise exception 'update_meal writes eaten_at in the main SET list again';
  end if;
end $guard$;
