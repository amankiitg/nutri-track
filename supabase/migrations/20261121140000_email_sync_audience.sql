-- --------------------------------------------------------------------------- --
-- The Resend mailing list, kept in step with the people who can use NutriTrack.
--
-- The list used to be maintained by exporting a CSV and importing it into Resend by
-- hand, which meant it was right on the day of the export and wrong for as long as
-- nobody remembered. This migration adds the read the sync needs, a place to record
-- what the last run did, and one switch per profile.
--
-- Three rules decide who is on the list.
--
--   1. An address with an account, or an address on the invite list, is eligible.
--      Those are the two ways somebody reaches this app, and both end in the same
--      mailbox. Two spellings of one Gmail inbox are one contact: the comparison is
--      public.email_canonical(), the same function the invite gate uses, so the list
--      cannot disagree with the door.
--   2. An address in app_settings.email_sync_exclude is never returned. The five
--      entries seeded below are the accounts that should not receive product email,
--      and the list stays in the database so it can be changed without a deploy.
--   3. Any address at example.com is never returned. Test accounts are created by
--      several flows, and a pattern covers the ones nobody has thought of yet.
--      The rule is a pattern rather than five more stored rows for the same reason.
--
-- Nothing here sends an email. This is a read, a state row, and one column. Resend's
-- Contacts API is the only thing that leaves, and server/src/resend-contacts.ts can
-- create a contact or set it unsubscribed. It has no delete path and it never writes
-- unsubscribed: false, so a person who left the list cannot be put back on it by a
-- later sync.
--
-- The functions are gated the way the trial functions are: a secret passed as an
-- argument and compared against Supabase Vault, with a plain inequality because the
-- caller is our server and a stranger gets one uniform error either way. The secret's
-- Vault name is 'email_sync_server_secret'; the matching value is EMAIL_SYNC_SECRET
-- in the Render environment. Until that row exists every function refuses.
--
-- Rollback: supabase/rollback/20261121140000_email_sync_audience.sql
-- --------------------------------------------------------------------------- --

-- --------------------------------------------------------------------------- --
-- 1. One switch per person.
--
-- On by default: the app has always intended to tell the people using it when
-- something changes, and the Settings switch is the way out. A default of false
-- would mean nobody hears anything unless they go looking for a setting.
-- --------------------------------------------------------------------------- --
alter table public.profiles
  add column if not exists product_emails boolean not null default true;

-- --------------------------------------------------------------------------- --
-- 2. The exclusion list, and the five addresses seeded into it.
--
-- The column is text[] rather than a table because it is a short list read as one
-- value by one function, and a second table would need RLS and grants to answer a
-- question no caller role may ask directly.
--
-- Entries are compared with email_canonical(), so a stored spelling with dots or a
-- plus tag excludes every spelling of that inbox.
-- --------------------------------------------------------------------------- --
alter table public.app_settings
  add column if not exists email_sync_exclude text[] not null default '{}'::text[];

update public.app_settings
   set email_sync_exclude = array[
     'test@gmail.com',
     'amanbrilliant@gmail.com',
     'aman_kesarwani@mfe.berkeley.edu',
     'amankesarwani@berkeley.edu',
     'samudra.jayada@gmail.com'
   ]::text[]
 where id = true
   and cardinality(email_sync_exclude) = 0;

-- --------------------------------------------------------------------------- --
-- 3. What the last run did.
--
-- One row, enforced by the primary key being a constant. The page reads it to show
-- a time and three counts; nothing reads it to decide who is on the list. That
-- decision is made from the data every run, so a stale state row is a stale number
-- on a screen, never a wrong audience.
-- --------------------------------------------------------------------------- --
create table public.email_sync_state (
  id boolean primary key default true check (id),
  last_sync_at timestamptz,
  contacts integer not null default 0,
  excluded integer not null default 0,
  unsubscribed integer not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.email_sync_state (id) values (true);

alter table public.email_sync_state enable row level security;

-- Admins only, and read only. The row is written by the secret-gated function below,
-- which runs as its owner, so no caller role needs an insert or update grant.
create policy email_sync_state_admin_read on public.email_sync_state
  for select to authenticated using (public.is_admin());

revoke all on public.email_sync_state from anon, authenticated;
grant select on public.email_sync_state to authenticated;
grant all on public.email_sync_state to service_role;

-- --------------------------------------------------------------------------- --
-- 4. The secret, read from Supabase Vault.
--
-- Granted to no caller role: it exists only for the functions below. A missing row
-- returns null and the gate treats null as a mismatch, so the sync refuses to run
-- rather than running ungated.
-- --------------------------------------------------------------------------- --
create or replace function public.email_sync_server_secret()
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_secret text;
begin
  select d.decrypted_secret into v_secret
    from vault.decrypted_secrets d
   where d.name = 'email_sync_server_secret';
  return v_secret;
end $$;

revoke execute on function public.email_sync_server_secret() from public, anon, authenticated;

create or replace function public.email_sync_check_secret(p_server_secret text)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $$
declare
  v_secret text := public.email_sync_server_secret();
begin
  -- A null argument and a null Vault row both fail. A plain inequality is enough:
  -- the server holds the secret and an attacker gets one uniform error.
  if v_secret is null or p_server_secret is null or p_server_secret <> v_secret then
    raise exception 'invalid server secret' using errcode = '42501';
  end if;
end $$;

revoke execute on function public.email_sync_check_secret(text) from public, anon, authenticated;

-- --------------------------------------------------------------------------- --
-- 5. Every eligible write, before the exclusion rules are applied.
--
-- Two sources, one row per canonical address. An account row is preferred over an
-- invite row because the account is the mailbox the person actually signed in with;
-- the invite row is the fallback for somebody who was invited and has not signed up
-- yet. The same inbox cannot appear twice: `distinct on` folds the Gmail spellings
-- through email_canonical() before anything else looks at the row.
--
-- The first name is a greeting for an email, not an identity. It prefers the given
-- name Google supplies, then the first word of a full name, then the first word of
-- the profile's display name. Never longer than sixty characters.
-- --------------------------------------------------------------------------- --
create or replace function public.email_sync_addresses()
returns table (canonical text, email text, first_name text, product_emails boolean)
language sql
stable
security definer
set search_path = public, pg_catalog, pg_temp
as $$
  with addresses as (
    select u.id as user_id,
           u.email::text as email,
           u.raw_user_meta_data as meta,
           true as is_account
      from auth.users u
     where u.email is not null
       and trim(u.email) <> ''
    union all
    select null::uuid as user_id,
           a.email as email,
           null::jsonb as meta,
           false as is_account
      from public.allowed_emails a
     where trim(a.email) <> ''
  ),
  deduped as (
    select distinct on (public.email_canonical(ad.email))
           public.email_canonical(ad.email) as canonical,
           ad.email,
           ad.user_id,
           ad.meta
      from addresses ad
     order by public.email_canonical(ad.email),
              ad.is_account desc,
              lower(trim(ad.email))
  )
  select d.canonical,
         lower(trim(d.email)) as email,
         nullif(
           left(
             coalesce(
               nullif(trim(coalesce(d.meta ->> 'given_name', '')), ''),
               nullif(split_part(trim(coalesce(d.meta ->> 'full_name', d.meta ->> 'name', '')), ' ', 1), ''),
               nullif(split_part(trim(coalesce(p.display_name, '')), ' ', 1), '')
             ),
             60
           ),
           ''
         ) as first_name,
         coalesce(p.product_emails, true) as product_emails
    from deduped d
    left join public.profiles p on p.user_id = d.user_id
   order by d.canonical
$$;

revoke execute on function public.email_sync_addresses() from public, anon, authenticated;

-- The same list with the two exclusion rules applied. Kept apart from the function
-- above so the counts can say how many were left out without restating the rules.
create or replace function public.email_sync_candidates()
returns table (canonical text, email text, first_name text, product_emails boolean)
language sql
stable
security definer
set search_path = public, pg_catalog, pg_temp
as $$
  select a.canonical, a.email, a.first_name, a.product_emails
    from public.email_sync_addresses() a
   where a.canonical not like '%@example.com'
     and not exists (
       select 1
         from public.app_settings s,
              unnest(s.email_sync_exclude) as e(address)
        where s.id = true
          and public.email_canonical(e.address) = a.canonical
     )
   order by a.canonical
$$;

revoke execute on function public.email_sync_candidates() from public, anon, authenticated;

-- --------------------------------------------------------------------------- --
-- 6. One page of the list.
--
-- Ordered by canonical and paged on p_after, so a run that dies halfway can resume
-- and no address is skipped or repeated. The page cap is 1000 because that is the
-- most PostgREST will return in one response; a caller asking for more is given the
-- most it can actually use.
-- --------------------------------------------------------------------------- --
create or replace function public.email_sync_page(
  p_secret text,
  p_after text default null,
  p_limit integer default 500
)
returns table (email text, canonical text, first_name text, product_emails boolean)
language plpgsql
stable
security definer
set search_path = public, pg_catalog, pg_temp
as $$
begin
  perform public.email_sync_check_secret(p_secret);

  return query
    select c.email, c.canonical, c.first_name, c.product_emails
      from public.email_sync_candidates() c
     where c.canonical > coalesce(p_after, '')
     order by c.canonical
     limit least(greatest(coalesce(p_limit, 500), 1), 1000);
end $$;

revoke execute on function public.email_sync_page(text, text, integer) from public;
grant execute on function public.email_sync_page(text, text, integer) to anon;

-- --------------------------------------------------------------------------- --
-- 7. The counts the admin card and the state row need.
--
-- eligible is what a run will try to upsert. unsubscribed is how many of those
-- people turned product mail off in Settings. excluded is every distinct canonical
-- address that rules 2 and 3 above kept out. Three numbers, no addresses.
-- --------------------------------------------------------------------------- --
create or replace function public.email_sync_counts(p_secret text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog, pg_temp
as $$
declare
  v_eligible integer;
  v_unsubscribed integer;
  v_total integer;
begin
  perform public.email_sync_check_secret(p_secret);

  select count(*)::integer,
         (count(*) filter (where not c.product_emails))::integer
    into v_eligible, v_unsubscribed
    from public.email_sync_candidates() c;

  select count(*)::integer into v_total
    from public.email_sync_addresses();

  return jsonb_build_object(
    'eligible', v_eligible,
    'excluded', greatest(v_total - v_eligible, 0),
    'unsubscribed', v_unsubscribed
  );
end $$;

revoke execute on function public.email_sync_counts(text) from public;
grant execute on function public.email_sync_counts(text) to anon;

-- --------------------------------------------------------------------------- --
-- 8. Recording what a run did.
--
-- Called once, after the last page. The row is an observation about the last run,
-- not an input to the next one: if it is never written, the next run still syncs
-- from the data.
-- --------------------------------------------------------------------------- --
create or replace function public.email_sync_record(
  p_secret text,
  p_contacts integer,
  p_excluded integer,
  p_unsubscribed integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $$
begin
  perform public.email_sync_check_secret(p_secret);

  insert into public.email_sync_state
    (id, last_sync_at, contacts, excluded, unsubscribed, updated_at)
  values (
    true,
    now(),
    greatest(coalesce(p_contacts, 0), 0),
    greatest(coalesce(p_excluded, 0), 0),
    greatest(coalesce(p_unsubscribed, 0), 0),
    now()
  )
  on conflict (id) do update
    set last_sync_at = excluded.last_sync_at,
        contacts = excluded.contacts,
        excluded = excluded.excluded,
        unsubscribed = excluded.unsubscribed,
        updated_at = excluded.updated_at;
end $$;

revoke execute on function public.email_sync_record(text, integer, integer, integer) from public;
grant execute on function public.email_sync_record(text, integer, integer, integer) to anon;

-- --------------------------------------------------------------------------- --
-- 9. The admin card's one read.
--
-- Admin only, security definer because the state table is not readable by an
-- ordinary account. Returns one object rather than a table so the client does not
-- have to unwrap a one row array.
-- --------------------------------------------------------------------------- --
create or replace function public.admin_email_sync_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog, pg_temp
as $$
declare
  v_row public.email_sync_state%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  select * into v_row from public.email_sync_state s where s.id = true;

  return jsonb_build_object(
    'last_sync_at', v_row.last_sync_at,
    'contacts', coalesce(v_row.contacts, 0),
    'excluded', coalesce(v_row.excluded, 0),
    'unsubscribed', coalesce(v_row.unsubscribed, 0)
  );
end $$;

revoke execute on function public.admin_email_sync_summary() from public, anon;
grant execute on function public.admin_email_sync_summary() to authenticated;
