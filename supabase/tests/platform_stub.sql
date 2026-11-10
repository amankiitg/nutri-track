-- What the Supabase platform provides before the first migration runs, and nothing else.
--
-- all_migrations_test.sh replays every file in supabase/migrations on top of this, so the
-- public schema here is empty: every table and function in it comes from the migrations
-- themselves, in order. That is the point. trial_migration_test.sh stubs the public
-- tables directly, which meant the trial migration met a database that had never had an
-- admin_spend(), and a `create or replace` that changes a return type passed there and
-- failed against production.
--
-- The shapes follow the platform where a migration can tell the difference:
-- auth.users.email is varchar(255) as it is in Supabase (20260911211000 exists because of
-- it), and auth.uid() / auth.jwt() read the same request.jwt.* settings PostgREST sets.
-- Test scaffolding only: nothing here ships.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key,
  email character varying(255),
  raw_user_meta_data jsonb,
  raw_app_meta_data jsonb,
  created_at timestamptz not null default now()
);

create table auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null
);

create function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

create function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  created_at timestamptz default now()
);
alter table storage.objects enable row level security;

create function storage.foldername(name text) returns text[]
language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;

-- Vault, as the one view the trial reads. In Supabase this is a view over the encrypted
-- vault.secrets; here it is a plain table a test can plant a secret in.
create schema if not exists vault;
create table vault.decrypted_secrets (
  name text primary key,
  decrypted_secret text
);
