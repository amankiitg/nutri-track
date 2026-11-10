-- Test stubs for the trial migration's prerequisites.
--
-- Plain Postgres (not Supabase) has no auth schema, no Vault, and none of the tables
-- the trial migration assumes. This file creates the minimum of each so the migration,
-- its functions, and its rollback can be applied and exercised against a local
-- database. It is test scaffolding only: nothing here ships.

-- The three roles the grants and revokes name.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role;
  end if;
end $$;

-- Supabase's auth schema: the users table and the two functions the migrations read.
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb,
  created_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid
language sql stable set search_path = pg_catalog as $$ select null::uuid $$;

create or replace function auth.jwt() returns jsonb
language sql stable set search_path = pg_catalog as $$ select '{}'::jsonb $$;

-- Supabase's Vault, stubbed to the one column pair trial_server_secret() reads. In the
-- real project this is vault.decrypted_secrets backed by the encrypted vault.secrets;
-- here it is a plain table so a test can plant the secret.
create schema if not exists vault;

create table if not exists vault.decrypted_secrets (
  name text primary key,
  decrypted_secret text
);

-- The tables and functions the migration alters or calls.
create table if not exists public.allowed_emails (
  email text primary key,
  added_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.admins (
  user_id uuid primary key
);

create table if not exists public.profiles (
  user_id uuid primary key,
  timezone text
);

create table if not exists public.llm_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  model text not null,
  prompt_tokens integer,
  completion_tokens integer,
  latency_ms integer,
  status text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.invite_requests (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  first_name text,
  requested_by uuid,
  requested_at timestamptz not null default now(),
  status text not null default 'pending',
  handled_at timestamptz,
  handled_by uuid,
  request_ip_hash text
);

create or replace function public.email_canonical(p_email text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
           when v.domain in ('gmail.com', 'googlemail.com')
             then replace(split_part(v.local, '+', 1), '.', '') || '@gmail.com'
           else v.full
         end
  from (
    select lower(trim(coalesce(p_email, ''))) as full,
           split_part(lower(trim(coalesce(p_email, ''))), '@', 1) as local,
           split_part(lower(trim(coalesce(p_email, ''))), '@', 2) as domain
  ) v
$$;

create or replace function public.ip_hash(p_ip text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
           when p_ip is null or p_ip = '' then null
           else encode(sha256(convert_to(p_ip, 'UTF8')), 'hex')
         end
$$;

-- request_ip reads request.headers, which does not exist outside PostgREST; the trial
-- flow uses p_ip (an argument) rather than this, so returning null is correct here.
create or replace function public.request_ip()
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select null::text
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;

create or replace function public.local_day_start(p_at timestamptz, p_tz text)
returns timestamptz language sql stable set search_path = public as $$
  select (((p_at at time zone coalesce(p_tz, 'UTC'))::date)::timestamp)
           at time zone coalesce(p_tz, 'UTC')
$$;

create or replace function public.local_day_start_offset(p_at timestamptz, p_tz text, p_days integer)
returns timestamptz language sql stable set search_path = public as $$
  select ((((p_at at time zone coalesce(p_tz, 'UTC'))::date) + p_days)::timestamp)
           at time zone coalesce(p_tz, 'UTC')
$$;
