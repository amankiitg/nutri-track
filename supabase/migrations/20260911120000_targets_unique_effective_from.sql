-- One target row per user per calendar day.
--
-- saveProfileWithTargets used to read today's row and then update-or-insert it,
-- which can race: two concurrent saves can both miss and both insert. A unique
-- constraint lets PostgREST collapse that into a single upsert.
--
-- Pre-existing duplicates are collapsed to the most recently written row first,
-- so this migration cannot fail on apply.

with ranked as (
  select
    id,
    row_number() over (
      partition by user_id, effective_from
      order by created_at desc, id desc
    ) as rn
  from public.targets
)
delete from public.targets t
using ranked r
where t.id = r.id
  and r.rn > 1;

alter table public.targets
  add constraint targets_user_id_effective_from_key unique (user_id, effective_from);
