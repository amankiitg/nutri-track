-- Admin bootstrap was gated on `allowed_emails` being empty. Pre-populating the
-- allow list therefore disabled it permanently: no user could ever become an
-- admin, and `public.is_admin()` — which the Step 5 admin page depends on — would
-- always return false.
--
-- Gate it on `admins` being empty instead, and seed the existing account owner in
-- the same migration so the table is not left empty.

create or replace function public.bootstrap_first_admin()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  jwt_email text := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
begin
  if jwt_email = '' then
    return new;
  end if;

  -- Only the very first administrator is seeded automatically.
  if exists (select 1 from public.admins) then
    return new;
  end if;

  -- `on conflict do nothing` so this is a no-op when the allow list is already
  -- populated with this address.
  insert into public.allowed_emails (email, added_by)
  values (jwt_email, new.user_id)
  on conflict do nothing;

  insert into public.admins (user_id)
  values (new.user_id)
  on conflict do nothing;

  return new;
end $$;

-- Trigger functions do not need EXECUTE granted; re-assert the revoke after the
-- replace so the ACL cannot drift back to the PUBLIC default.
revoke execute on function public.bootstrap_first_admin() from public, anon, authenticated;

-- Promote the account owner: the earliest auth user who is on the allow list.
insert into public.admins (user_id)
select u.id
  from auth.users u
 where lower(trim(u.email)) in (select lower(trim(a.email)) from public.allowed_emails a)
   and not exists (select 1 from public.admins)
 order by u.created_at
 limit 1;
