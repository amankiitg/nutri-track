-- --------------------------------------------------------------------------- --
-- The other half of opening sign-ups: the checks after the account exists.
--
-- `auth_entry_state` decided what the sign-in screen offered, and that shipped. But everything
-- downstream still asked the invite list, so a brand new account landed on "NutriTrack is
-- invite-only right now" and an invite request was recorded on its behalf.
--
-- Every one of those gates reads one of two functions, which is why this migration is short:
--
--   `is_email_allowed()`      the route guard, and the INSERT policy on profiles, targets,
--                             meals and weights (four policies, all `with check
--                             (user_id = auth.uid() and public.is_email_allowed())`)
--   `check_email_allowed()`   the sign-in screen's "is this address invited?"
--
-- Adding `public.open_signups()` to both means the switch turns all of them together, and with
-- it off each answers exactly what it answered before.
-- --------------------------------------------------------------------------- --

create or replace function public.is_email_allowed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.open_signups()
      or (not exists (select 1 from public.allowed_emails))
      or exists (
        select 1 from public.allowed_emails
        where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      )
$$;

create or replace function public.check_email_allowed(_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.open_signups()
      or (not exists (select 1 from public.allowed_emails))
      or exists (select 1 from public.allowed_emails where lower(email) = lower(trim(_email)))
$$;

-- --------------------------------------------------------------------------- --
-- No invite requests while sign-ups are open.
--
-- The request screen and the trial's end both stop offering a request when the switch is on, but
-- a tab opened before the switch (or a retry from one) would still reach `request_invite`. The
-- trigger sits under that function rather than beside it: returning null skips the insert, which
-- is the same instrument the existing guard uses to refuse a request it will not record.
-- --------------------------------------------------------------------------- --
create or replace function public.invite_requests_skip_when_open()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.open_signups() then
    return null;
  end if;
  return new;
end $$;

revoke execute on function public.invite_requests_skip_when_open() from public, anon, authenticated;

drop trigger if exists invite_requests_skip_when_open on public.invite_requests;
create trigger invite_requests_skip_when_open
  before insert on public.invite_requests
  for each row execute function public.invite_requests_skip_when_open();
