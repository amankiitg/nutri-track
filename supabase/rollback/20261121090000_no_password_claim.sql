-- Rollback of 20261121090000_no_password_claim.sql.
--
-- Restores the version from 20261120200000, which claims `has_password` from
-- `encrypted_password`. That claim is wrong for magic-link accounts; restoring it restores the bug.
-- --------------------------------------------------------------------------- --
-- A link-only account that also has Google.
--
-- An account created by magic link, whose owner later signed in with Google, has two identities
-- and no password. The previous answer was `link_only`, so the screen offered only the link and
-- hid a door that works. `link_only_google` says both are available.
--
-- What it reveals: one more bit about an address that already answers "an account exists" and
-- whether a password is set, namely that a Google identity is attached to it. That is the same
-- class of fact `google_only` has disclosed since the beginning, it is behind the same throttle,
-- and it is what lets the screen offer the door the person actually used.
--
-- Nothing else changes: no account, no password (there is none) and no invited address can reach
-- this answer, because the branch only fires for an account with no password and a Google identity
-- beside its email one.
-- --------------------------------------------------------------------------- --

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
  v_has_password boolean;
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

  select u.id, coalesce(nullif(u.encrypted_password, ''), null) is not null
    into v_user_id, v_has_password
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

  if not v_has_password then
    -- No password means no password box, and a Google identity beside the email one means the
    -- Google door works as well as the link.
    return case when v_has_google then 'link_only_google' else 'link_only' end;
  end if;

  return 'has_password';
end $$;

revoke execute on function public.auth_entry_state(text) from public;
grant execute on function public.auth_entry_state(text) to anon, authenticated;
