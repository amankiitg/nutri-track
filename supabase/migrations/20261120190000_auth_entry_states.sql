-- --------------------------------------------------------------------------- --
-- Three answers for an account, instead of two.
--
-- `has_account` told the sign-in screen that an address had an account but not whether that
-- account had a password, so an account created by magic link (which is now every open sign-up)
-- was shown a password box it could never satisfy. The screen now asks, and gets one of:
--
--   google_only    a Google identity and no email one: only Google can sign this in
--   link_only      an email account with no password set: a magic link is the way in
--   has_password   a password exists: the password box, the link and the reset all apply
--
-- What this reveals, stated plainly: the same call already answers "does this address have an
-- account" and "is it Google only" to anyone who can ask, behind the existing throttle. The new
-- distinction adds "does this account have a password", which is a weaker fact than the account's
-- existence and is required for the screen to offer the right door. It therefore adds one bit to
-- an answer that was already disclosing two, and adds nothing about who the person is.
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

  if exists (select 1 from auth.identities i where i.user_id = v_user_id and i.provider = 'google')
     and not exists (
       select 1 from auth.identities i where i.user_id = v_user_id and i.provider = 'email'
     ) then
    return 'google_only';
  end if;

  -- No password means no password box: a magic-link account (including every account created by
  -- the open sign-up flow) would be staring at a field it can never fill.
  if not v_has_password then
    return 'link_only';
  end if;

  return 'has_password';
end $$;

revoke execute on function public.auth_entry_state(text) from public;
grant execute on function public.auth_entry_state(text) to anon, authenticated;
