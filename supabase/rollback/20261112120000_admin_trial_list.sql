-- Rollback for 20261112120000_admin_trial_list.sql
--
-- Drops the list function, puts admin_trial_link_issue back to the body 20261110120000
-- gave it (which did not name source), and drops the column. Dropping the column also
-- drops its check constraint.

drop function if exists public.admin_trial_list(text, integer);

create or replace function public.admin_trial_link_issue(p_email text, p_first_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name text := nullif(left(trim(coalesce(p_first_name, '')), 50), '');
  v_canonical text;
  v_row public.trial_users%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  if length(v_email) = 0
     or length(v_email) > 254
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'not an email address' using errcode = '22023';
  end if;
  v_canonical := public.email_canonical(v_email);

  insert into public.trial_users (email, first_name)
  values (v_canonical, v_name)
  on conflict (email) do update
    set first_name = coalesce(excluded.first_name, public.trial_users.first_name)
  returning * into v_row;

  return jsonb_build_object(
    'email', v_row.email,
    'first_name', v_row.first_name,
    'token_version', v_row.token_version
  );
end $$;

revoke execute on function public.admin_trial_link_issue(text, text) from public, anon;
grant execute on function public.admin_trial_link_issue(text, text) to authenticated;

alter table public.trial_users drop column if exists source;
