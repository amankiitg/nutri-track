-- Rollback of 20261120180000_open_signups_post_login.sql.
--
-- Puts the two gates back to the invite list alone and removes the trigger, so a request is
-- recorded again. The bodies below are the ones from 20260910234510.

drop trigger if exists invite_requests_skip_when_open on public.invite_requests;
drop function if exists public.invite_requests_skip_when_open();

create or replace function public.is_email_allowed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (not exists (select 1 from public.allowed_emails))
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
  select (not exists (select 1 from public.allowed_emails))
      or exists (select 1 from public.allowed_emails where lower(email) = lower(trim(_email)))
$$;
