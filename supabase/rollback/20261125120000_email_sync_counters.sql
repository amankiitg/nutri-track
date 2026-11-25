-- The way back from 20261125120000_email_sync_counters.sql.
--
-- The seven counters go and `contacts` comes back, because that is the row this schema had before:
-- five numbers that could not tell "nothing new" from "nothing read". The record function returns to
-- its four argument form, and the summary to the four keys the old card read.

drop function if exists public.email_sync_record(text, integer, integer, integer, integer, integer, integer, integer, text);

alter table public.email_sync_state
  drop column if exists checked,
  drop column if exists added,
  drop column if exists already,
  drop column if exists names,
  drop column if exists failed,
  drop column if exists first_error;

alter table public.email_sync_state add column if not exists contacts integer not null default 0;

create or replace function public.email_sync_record(
  p_secret text,
  p_contacts integer,
  p_excluded integer,
  p_unsubscribed integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $$
begin
  perform public.email_sync_check_secret(p_secret);

  insert into public.email_sync_state
    (id, last_sync_at, contacts, excluded, unsubscribed, updated_at)
  values (
    true,
    now(),
    greatest(coalesce(p_contacts, 0), 0),
    greatest(coalesce(p_excluded, 0), 0),
    greatest(coalesce(p_unsubscribed, 0), 0),
    now()
  )
  on conflict (id) do update
    set last_sync_at = excluded.last_sync_at,
        contacts = excluded.contacts,
        excluded = excluded.excluded,
        unsubscribed = excluded.unsubscribed,
        updated_at = excluded.updated_at;
end $$;

revoke execute on function public.email_sync_record(text, integer, integer, integer) from public;
grant execute on function public.email_sync_record(text, integer, integer, integer) to anon;

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
    'contacts', coalesce(v_row.contacts, 0),
    'excluded', coalesce(v_row.excluded, 0),
    'unsubscribed', coalesce(v_row.unsubscribed, 0)
  );
end $$;

revoke execute on function public.admin_email_sync_summary() from public, anon;
grant execute on function public.admin_email_sync_summary() to authenticated;
