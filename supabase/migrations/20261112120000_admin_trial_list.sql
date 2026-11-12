-- The admin's recent trials list: one row per trial mailbox, newest first.
--
-- The Trial card could already say how many mailboxes started and how many scans ran
-- today. It could not say *who* they were, which is the question an admin actually has
-- when a trial turns into a request to join. This function is that read path, and it is
-- the only one: trial_users is service-role only, and the admin page never touches it
-- directly.
--
-- Deliberately absent from the result: meal text, photos, and anything from llm_calls.
-- A trial visitor's meals are analysed in memory and never stored (see
-- 20261109170000_trial_tables.sql), so there is nothing of theirs to leak here. What
-- this returns is the funnel: address, how they arrived, scans spent, when they were
-- first and last seen, and whether they asked to join afterwards.
--
-- `source` is a column rather than a derivation from link_sent_at. A mailbox can be
-- sent a link and then use the code form, and the two are different funnels: the link
-- says the admin chose this person, the code says they found /try. The column records
-- which happened first, which is the useful thing to know.
--
-- Rollback: supabase/rollback/20261112120000_admin_trial_list.sql
--
-- Deploy note: this migration creates no table and needs no vault secret. The address
-- column is read by the RPC only; it is not exposed through PostgREST to any caller but
-- an admin, because the table's grants are unchanged.

-- ---------------------------------------------------------------------------
-- 1. How a trial started.
--
-- 'code' is the default, so every existing row and every trial_send_code insert keeps
-- working without being touched. admin_trial_link_issue names 'link' explicitly below.
-- ---------------------------------------------------------------------------
alter table public.trial_users
  add column source text not null default 'code'
  check (source in ('code', 'link'));

-- Best effort, not a measurement: before this column existed, the only trace of a
-- link was link_sent_at. A row created by a link and never marked sent reads as 'code',
-- and a row created by a code and later sent a link reads as 'link'. New rows are
-- recorded accurately; this one statement cannot recover what was never written down.
update public.trial_users
   set source = 'link'
 where link_sent_at is not null
   and source = 'code';

-- ---------------------------------------------------------------------------
-- 2. admin_trial_link_issue learns the source.
--
-- Re-created because the insert now names the column. The body and grants are the ones
-- 20261110120000 gave it; the only change is `source = 'link'` on the insert, and the
-- conflict branch leaves an existing row's source alone, because the first way in is
-- what the column records.
-- ---------------------------------------------------------------------------
create or replace function public.admin_trial_link_issue(p_email text, p_first_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name text := nullif(left(trim(coalesce(p_first_name, '')), 50), '');
  v_canonical text;
  v_row public.trial_users%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  if length(v_email) = 0
     or length(v_email) > 254
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'not an email address' using errcode = '22023';
  end if;
  v_canonical := public.email_canonical(v_email);

  insert into public.trial_users (email, first_name, source)
  values (v_canonical, v_name, 'link')
  on conflict (email) do update
    set first_name = coalesce(excluded.first_name, public.trial_users.first_name)
  returning * into v_row;

  return jsonb_build_object(
    'email', v_row.email,
    'first_name', v_row.first_name,
    'token_version', v_row.token_version
  );
end $$;

revoke execute on function public.admin_trial_link_issue(text, text) from public, anon;
grant execute on function public.admin_trial_link_issue(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The list.
--
-- Newest first, at most 50 rows. p_limit is clamped here rather than trusted: the
-- browser sends 50, and a hand-written request cannot ask for more.
--
-- p_search is folded with email_canonical first, so typing an address the way Gmail
-- shows it (dots, a +tag) still finds the canonical row that was stored. The match is a
-- plain substring, not LIKE: no wildcard in the search text can change what it means.
-- ---------------------------------------------------------------------------
create function public.admin_trial_list(p_search text default null, p_limit integer default 50)
returns table (
  email text,
  source text,
  invited boolean,
  scans_used integer,
  scans_limit integer,
  first_seen timestamptz,
  last_active timestamptz,
  requested_after boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_search text := public.email_canonical(coalesce(p_search, ''));
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 50);
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  return query
    select
      t.email,
      t.source,
      exists (
        select 1 from public.allowed_emails a
         where public.email_canonical(a.email) = t.email
      ) as invited,
      t.scans_used,
      coalesce(s.scans_limit, 0) as scans_limit,
      t.created_at as first_seen,
      t.last_used_at as last_active,
      exists (
        select 1 from public.invite_requests r
         where public.email_canonical(r.email) = t.email
           and r.from_trial = true
           and r.requested_at >= t.created_at
      ) as requested_after
    from public.trial_users t
    left join public.trial_settings s on s.id = true
    where v_search = '' or position(v_search in t.email) > 0
    order by t.created_at desc, t.email
    limit v_limit;
end $$;

revoke execute on function public.admin_trial_list(text, integer) from public, anon;
grant execute on function public.admin_trial_list(text, integer) to authenticated;
