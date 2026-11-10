-- The per-mailbox scan limit, readable by the /try page.
--
-- trial_settings is service_role-only, and the parse-meal service talks to PostgREST
-- as anon, so the page cannot read the limit directly. This security-definer function
-- is the one read path: it is gated by the same secret as every other trial_* function
-- and returns the scans_limit the page prints. It exists so the page never hardcodes
-- "10" and cannot drift from the number trial_scan_start enforces.
create or replace function public.trial_scans_limit(p_server_secret text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_scans_limit integer;
begin
  perform public.trial_check_secret(p_server_secret);

  select s.scans_limit into v_scans_limit
    from public.trial_settings s
   where s.id = true;

  if v_scans_limit is null then
    raise exception 'trial settings not seeded' using errcode = '55000';
  end if;

  return v_scans_limit;
end $$;

revoke execute on function public.trial_scans_limit(text) from public;
grant execute on function public.trial_scans_limit(text) to anon;
