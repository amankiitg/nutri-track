-- --------------------------------------------------------------------------- --
-- The sync's counters, in the words a person needs to tell three cases apart:
-- nothing to do, everything refused, and nothing read at all.
--
-- The old row had `contacts`, which was the count of upserts the API accepted. That number could
-- not distinguish "50 already there" from "0 rows read", and on 25 Nov 06:15 it said 0 with 5
-- excluded while roughly fifty contacts sat in Resend, which is exactly that ambiguity.
--
-- So the row now keeps seven numbers, each row counted once:
--
--   checked       rows the run walked
--   added         contacts Resend did not have
--   already       contacts that were already in step
--   names         contacts whose first name was filled in
--   failed        contacts Resend refused
--   excluded      addresses the two rules kept out (a total, not a per run count)
--   unsubscribed  people who turned product mail off (a total, not a per run count)
-- --------------------------------------------------------------------------- --

alter table public.email_sync_state
  add column if not exists checked integer not null default 0,
  add column if not exists added integer not null default 0,
  add column if not exists already integer not null default 0,
  add column if not exists names integer not null default 0,
  add column if not exists failed integer not null default 0,
  add column if not exists first_error text;

-- The old counter cannot be turned into any of the new ones, so it goes rather than sitting there
-- reading zero next to seven numbers that mean something.
alter table public.email_sync_state drop column if exists contacts;

drop function if exists public.email_sync_record(text, integer, integer, integer);

create or replace function public.email_sync_record(
  p_secret text,
  p_checked integer,
  p_added integer,
  p_already integer,
  p_names integer,
  p_failed integer,
  p_excluded integer,
  p_unsubscribed integer,
  p_first_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $$
begin
  perform public.email_sync_check_secret(p_secret);

  insert into public.email_sync_state
    (id, last_sync_at, checked, added, already, names, failed, excluded, unsubscribed, first_error,
     updated_at)
  values (
    true,
    now(),
    greatest(coalesce(p_checked, 0), 0),
    greatest(coalesce(p_added, 0), 0),
    greatest(coalesce(p_already, 0), 0),
    greatest(coalesce(p_names, 0), 0),
    greatest(coalesce(p_failed, 0), 0),
    greatest(coalesce(p_excluded, 0), 0),
    greatest(coalesce(p_unsubscribed, 0), 0),
    -- A sentence, trimmed, and never an address: the caller has already made sure of that.
    nullif(left(trim(coalesce(p_first_error, '')), 300), ''),
    now()
  )
  on conflict (id) do update
    set last_sync_at = excluded.last_sync_at,
        checked = excluded.checked,
        added = excluded.added,
        already = excluded.already,
        names = excluded.names,
        failed = excluded.failed,
        excluded = excluded.excluded,
        unsubscribed = excluded.unsubscribed,
        first_error = excluded.first_error,
        updated_at = excluded.updated_at;
end $$;

revoke execute on function public.email_sync_record(text, integer, integer, integer, integer, integer, integer, integer, text) from public;
grant execute on function public.email_sync_record(text, integer, integer, integer, integer, integer, integer, integer, text) to anon;

create or replace function public.admin_email_sync_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog, pg_temp
as $$
declare
  v_row public.email_sync_state%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  select * into v_row from public.email_sync_state s where s.id = true;

  return jsonb_build_object(
    'last_sync_at', v_row.last_sync_at,
    'checked', coalesce(v_row.checked, 0),
    'added', coalesce(v_row.added, 0),
    'already', coalesce(v_row.already, 0),
    'names', coalesce(v_row.names, 0),
    'failed', coalesce(v_row.failed, 0),
    'excluded', coalesce(v_row.excluded, 0),
    'unsubscribed', coalesce(v_row.unsubscribed, 0),
    'first_error', v_row.first_error
  );
end $$;

revoke execute on function public.admin_email_sync_summary() from public, anon;
grant execute on function public.admin_email_sync_summary() to authenticated;
