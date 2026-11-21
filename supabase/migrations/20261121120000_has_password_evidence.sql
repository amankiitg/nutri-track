-- ---------------------------------------------------------------------------
-- A password door, only where a password is known to exist.
--
-- The revision before this one stopped reading the stored hash, because GoTrue writes a random
-- 60 character bcrypt hash for an account created by a magic link, so presence there proves nothing.
-- That removed the false positive, and it also removed the password door from every account that
-- really has one: auth_entry_state had no evidence left to look at and answered link_only for
-- everybody.
--
-- There is evidence, and it is not the hash. Two facts, both recorded by something other than the
-- client's opinion:
--
--   1. auth.mfa_amr_claims with authentication_method = 'password'. GoTrue writes a row there every
--      time a session is established with a password, so it covers every account that has ever
--      signed in that way, including every account that existed before this migration.
--   2. profiles.has_password, added below, set by the app when somebody saves a password in
--      Settings. GoTrue does not write an amr claim for a password that was set and never used, and
--      without this an account that set one in Settings would still be sent to the link.
--
-- The column is written by one security definer function, mark_has_password(), which can only set
-- it true on the caller's own row, and a trigger refuses a direct write of it from the client. So it
-- says "the app recorded a password", not "the client says it has one".
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists has_password boolean not null default false;

-- The backfill: every account that has ever signed in with a password, from the record GoTrue
-- already keeps.
update public.profiles p
   set has_password = true
 where p.has_password = false
   and exists (
     select 1
       from auth.mfa_amr_claims c
       join auth.sessions s on s.id = c.session_id
      where s.user_id = p.user_id
        and c.authentication_method = 'password'
   );

-- The client may edit its own profile, and this column is not its to edit: an address that never
-- had a password must not be able to hand itself a password box by writing true, and one that does
-- must not be able to hide the door by writing false. Inside mark_has_password() the current user is
-- the owner, which is how the app writes it.
create or replace function public.profiles_has_password_guard()
returns trigger
language plpgsql
as $$
begin
  if new.has_password is distinct from old.has_password and current_user = 'authenticated' then
    raise exception 'has_password is recorded by the app, not written directly'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists profiles_has_password_guard on public.profiles;
create trigger profiles_has_password_guard
  before update on public.profiles
  for each row execute function public.profiles_has_password_guard();

/**
 * Records that the caller has a password.
 *
 * Called after supabase.auth.updateUser({ password }) succeeds. No arguments on purpose: the row is
 * the caller's own, one way, and there is no way to say "false" or to name somebody else.
 */
create or replace function public.mark_has_password()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.profiles
     set has_password = true
   where user_id = auth.uid()
     and has_password = false
$$;

revoke execute on function public.mark_has_password() from public;
grant execute on function public.mark_has_password() to authenticated;

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

  -- The two pieces of evidence, and neither of them is the stored hash: see the note at the top.
  v_has_password := exists (
    select 1
      from auth.mfa_amr_claims c
      join auth.sessions s on s.id = c.session_id
     where s.user_id = v_user_id
       and c.authentication_method = 'password'
  ) or exists (
    select 1 from public.profiles p
     where p.user_id = v_user_id
       and p.has_password
  );

  if v_has_password then
    return case when v_has_google then 'has_password_google' else 'has_password' end;
  end if;

  return case when v_has_google then 'link_only_google' else 'link_only' end;
end $$;

revoke execute on function public.auth_entry_state(text) from public;
grant execute on function public.auth_entry_state(text) to anon, authenticated;
