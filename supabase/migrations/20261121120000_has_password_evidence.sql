-- ---------------------------------------------------------------------------
-- A password door, only where a password is known to exist.
--
-- Two earlier revisions of this function guessed. The first read `encrypted_password`, and GoTrue
-- writes a random 60 character bcrypt hash for an account created by an emailed link, so every
-- link account claimed a password it did not have. The second read `auth.mfa_amr_claims` for
-- authentication_method = 'password', on the theory that GoTrue only records that when a password
-- was actually used. Measured on the local stack (GoTrue v2.198), a session established by an
-- emailed link writes both claims:
--
--   email                          | profiles.has_password | amr claims   | auth_entry_state
--   new.suite.mwqkst39@example.com | false                 | password,otp | has_password
--
-- So that record says nothing about whether a password exists either, and there is no reason to
-- expect the production GoTrue to differ, since the claims describe how the session was proved
-- rather than what the account holds.
--
-- What is left is the honest answer: a flag the app sets when it knows a password exists. Three
-- places set it, and all three are moments the app itself saw a password work or be set:
--
--   1. Settings, after supabase.auth.updateUser({ password }) succeeds.
--   2. The reset screen, after the same call succeeds with a new password.
--   3. Any successful password sign-in, so an account that already had a password from before this
--      migration becomes `has_password` the first time it uses one. Nothing is backfilled: there is
--      no record to backfill from, and guessing one is what this migration is undoing.
--
-- The column is written through mark_has_password(), a security definer function that can only set
-- it true on the caller's own row, and a trigger refuses a direct write of it from the client. An
-- account without the flag is shown the link only. It can still sign in, so nobody is locked out.
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists has_password boolean not null default false;

-- No backfill. The only records that could feed one are the amr claims, and the measurement above
-- is the reason they cannot be trusted for this question.

-- The client may edit its own profile, and this column is not its to edit: an address that never
-- had a password must not be able to hand itself a password box by writing true. Inside the
-- function below the current user is the owner, which is how the app writes it.
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
 * Called after a password is set in Settings, after a reset, and after a password sign-in. No
 * arguments on purpose: the row is the caller's own, one way, and there is no way to say "false" or
 * to name somebody else.
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

  -- The only evidence, and the note at the top is the reason there is no second one.
  v_has_password := coalesce((
    select p.has_password from public.profiles p where p.user_id = v_user_id
  ), false);

  if v_has_password then
    return case when v_has_google then 'has_password_google' else 'has_password' end;
  end if;

  return case when v_has_google then 'link_only_google' else 'link_only' end;
end $$;

revoke execute on function public.auth_entry_state(text) from public;
grant execute on function public.auth_entry_state(text) to anon, authenticated;
