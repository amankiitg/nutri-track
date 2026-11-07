-- Undo 20261107120000_invite_request_from_anyone.
--
-- Run this only if that migration has to come out of a database that is still being used: it takes
-- away the ability to request an invite without an account, which is the only thing the request page
-- can do, so the page has to be rolled back with it.
--
-- The order is the reverse of the migration, and each section undoes one decision rather than one
-- statement.

-- ---------------------------------------------------------------------------
-- 1. The triggers, and the two functions they call.
-- ---------------------------------------------------------------------------
drop trigger if exists allowed_emails_approve_request on public.allowed_emails;
drop trigger if exists allowed_emails_revoke_request on public.allowed_emails;

drop function if exists public.allowed_emails_approve_request();
drop function if exists public.allowed_emails_revoke_request();

-- ---------------------------------------------------------------------------
-- 2. The functions the app calls, with their arguments.
--
-- Named with the full argument list on purpose: `drop function request_invite` would fail, and an
-- earlier `request_invite(text)` overload from a half-applied attempt would be left behind.
-- ---------------------------------------------------------------------------
drop function if exists public.request_invite(text, text, boolean, text);
drop function if exists public.auth_entry_state(text);

drop table if exists public.auth_entry_state_throttle;

-- ---------------------------------------------------------------------------
-- 3. The canonical-address helpers, and the two allow-list checks that were re-stated in terms of
-- them. Restored to what they said before, so a rolled-back database behaves as it did.
-- ---------------------------------------------------------------------------
create or replace function public.is_email_allowed()
returns boolean language sql stable security definer set search_path = public as $$
  select (not exists (select 1 from public.allowed_emails))
      or exists (
        select 1 from public.allowed_emails
        where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      )
$$;

create or replace function public.check_email_allowed(_email text)
returns boolean language sql stable security definer set search_path = public as $$
  select (not exists (select 1 from public.allowed_emails))
      or exists (select 1 from public.allowed_emails where lower(email) = lower(trim(_email)))
$$;

drop function if exists public.email_canonical(text);
drop function if exists public.request_ip();
drop function if exists public.ip_hash(text);

-- ---------------------------------------------------------------------------
-- 4. The insert guard, back to the version that knew nothing about names.
-- ---------------------------------------------------------------------------
create or replace function public.invite_requests_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  recent integer;
  already_asked boolean;
begin
  new.email := lower(trim(new.email));

  select exists (select 1 from public.invite_requests r where r.email = new.email)
    into already_asked;
  if already_asked then
    return null;
  end if;

  select count(*) into recent
    from public.invite_requests r
   where r.requested_at > now() - interval '1 hour';
  if recent >= 25 then
    return null;
  end if;

  return new;
end $$;

revoke execute on function public.invite_requests_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The data.
--
-- 'revoked' has to go before the constraint can, and the honest way back is the state it was in
-- before this migration: those rows said 'approved' and the admin page showed them as approved.
-- Restoring that re-introduces exactly the untruth this migration came to fix, which is what a
-- rollback is.
--
-- A request with no `requested_by` could not exist under the old schema at all - it comes from the
-- email form, which is what this migration added - so those rows are deleted rather than dressed up
-- with a user id that never made one.
-- ---------------------------------------------------------------------------
update public.invite_requests set status = 'approved' where status = 'revoked';

delete from public.invite_requests where requested_by is null;

alter table public.invite_requests drop constraint if exists invite_requests_status;
alter table public.invite_requests
  add constraint invite_requests_status
  check (status in ('pending', 'approved', 'declined'));

alter table public.invite_requests alter column requested_by set not null;

alter table public.invite_requests drop column if exists request_ip_hash;

alter table public.invite_requests
  drop constraint if exists invite_requests_first_name_length;
alter table public.invite_requests drop column if exists first_name;
