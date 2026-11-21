-- The way back from 20261121120000_has_password_evidence.sql.
--
-- The guard, the recorder and the column go, in that order, and auth_entry_state is dropped back to
-- the body it had after 20261121090000_no_password_claim.sql: no password evidence at all, every
-- email account link_only. That is a worse screen than the one above, and it is the true state of
-- the database before the column existed.

drop trigger if exists profiles_has_password_guard on public.profiles;
drop function if exists public.profiles_has_password_guard();
drop function if exists public.mark_has_password();

alter table public.profiles drop column if exists has_password;
create or replace function public.auth_entry_state(p_email text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_canonical text;
  v_hash text;
  v_ip_hash text;
  v_same integer;
  v_same_ip integer;
  v_all integer;
  v_user_id uuid;
  v_invited boolean;
  v_has_google boolean;
  v_has_email boolean;
begin
  if length(v_email) = 0
     or length(v_email) > 254
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return 'not_invited';
  end if;

  v_canonical := public.email_canonical(v_email);
  v_hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');
  v_ip_hash := public.ip_hash(public.request_ip());

  delete from public.auth_entry_state_throttle where checked_at < now() - interval '1 hour';

  select count(*) into v_same
    from public.auth_entry_state_throttle t
   where t.email_hash = v_hash
     and t.checked_at > now() - interval '10 minutes';
  select count(*) into v_same_ip
    from public.auth_entry_state_throttle t
   where t.ip_hash = v_ip_hash
     and t.checked_at > now() - interval '10 minutes';
  select count(*) into v_all
    from public.auth_entry_state_throttle t
   where t.checked_at > now() - interval '10 minutes';

  if v_same >= 10 or (v_ip_hash is not null and v_same_ip >= 30) or v_all >= 500 then
    return 'busy';
  end if;

  insert into public.auth_entry_state_throttle (email_hash, ip_hash) values (v_hash, v_ip_hash);

  v_invited := exists (
    select 1 from public.allowed_emails a
     where public.email_canonical(a.email) = v_canonical
  );

  select u.id into v_user_id
    from auth.users u
   where public.email_canonical(u.email) = v_canonical
   limit 1;

  if v_user_id is null then
    if v_invited then
      return 'invited_new';
    end if;
    if public.open_signups() then
      return 'open_signup';
    end if;
    return 'not_invited';
  end if;

  v_has_google := exists (
    select 1 from auth.identities i where i.user_id = v_user_id and i.provider = 'google'
  );
  v_has_email := exists (
    select 1 from auth.identities i where i.user_id = v_user_id and i.provider = 'email'
  );

  if v_has_google and not v_has_email then
    return 'google_only';
  end if;

  -- No password claim: see the note at the top. The stored password hash is a random value for an
  -- account created by a magic link, so its presence says nothing about whether the person can type
  -- one, and this function therefore does not look at it.
  return case when v_has_google then 'link_only_google' else 'link_only' end;
end $$;

revoke execute on function public.auth_entry_state(text) from public;
grant execute on function public.auth_entry_state(text) to anon, authenticated;
