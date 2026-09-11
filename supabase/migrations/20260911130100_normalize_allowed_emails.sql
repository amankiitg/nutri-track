-- Allow-list matching was exact-string on both sides, so a stored address and a
-- looked-up address that differ only by case or surrounding whitespace silently
-- failed to match. Normalise to lower(trim(email)) everywhere and enforce it with
-- a unique index.
--
-- Dots are deliberately NOT stripped: that is a Gmail-specific quirk and this list
-- may hold non-Gmail addresses.

-- 1. Collapse rows that differ only by case/whitespace, keeping the earliest.
delete from public.allowed_emails a
 using public.allowed_emails b
 where lower(trim(a.email)) = lower(trim(b.email))
   and (a.created_at, a.email) > (b.created_at, b.email);

-- 2. Lower-case and trim what is left. Safe now that no two rows share a
--    normalised value, so this cannot collide with the email primary key.
update public.allowed_emails
   set email = lower(trim(email))
 where email <> lower(trim(email));

-- 3. Enforce the normalised form for anything inserted later.
create unique index if not exists allowed_emails_email_normalized_uniq
  on public.allowed_emails (lower(trim(email)));

-- 4. Compare normalised on both sides.
create or replace function public.is_email_allowed()
returns boolean language sql stable security definer set search_path = public as $$
  select (not exists (select 1 from public.allowed_emails))
      or exists (
        select 1 from public.allowed_emails
        where lower(trim(email)) = lower(trim(coalesce(auth.jwt() ->> 'email', '')))
      )
$$;

create or replace function public.check_email_allowed(_email text)
returns boolean language sql stable security definer set search_path = public as $$
  select (not exists (select 1 from public.allowed_emails))
      or exists (
        select 1 from public.allowed_emails
        where lower(trim(email)) = lower(trim(_email))
      )
$$;

-- Re-assert the ACLs after the replace (see 20260910234535 and 20260911130000).
revoke execute on function public.is_email_allowed() from public, anon;
grant execute on function public.is_email_allowed() to authenticated;

revoke execute on function public.check_email_allowed(text) from public;
grant execute on function public.check_email_allowed(text) to anon, authenticated;
