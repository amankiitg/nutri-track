-- Personal trial links: a trial the admin hands to a named person, with no email entry,
-- no code and no Turnstile.
--
-- The link carries the same HMAC trial token the code flow issues (signed by the
-- parse-meal service, never here), now with a version. trial_users.token_version is the
-- revocation: bumping it makes every token for that mailbox stop working, whether it
-- came from a link, an invite email or the code flow. A token issued before versions
-- existed reads as version 0, which is the column's default, so nothing already in a
-- visitor's browser breaks.
--
-- A link works for an address on the invite list (that is the point of putting one in
-- the invite email); only an existing account blocks it. The code flow at /try keeps
-- refusing invited addresses, because trial_send_code is unchanged.
--
-- Rollback: supabase/rollback/20261110120000_trial_links.sql

alter table public.trial_users add column token_version integer not null default 0;
alter table public.trial_users add column link_sent_at timestamptz;

-- ---------------------------------------------------------------------------
-- 1. What a link is worth right now. Secret-gated like every trial_* function.
--
--   invalid         no trial for this mailbox (never issued, or the row is gone)
--   already_access  the mailbox has an account: sign in instead
--   revoked         the token's version is not the current one
--   ok              usable, with the name to greet and the scans left
--
-- p_version null skips the version check; the service always passes one.
-- ---------------------------------------------------------------------------
create function public.trial_link_status(
  p_server_secret text,
  p_email text,
  p_version integer default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_canonical text;
  v_row public.trial_users%rowtype;
  v_limit integer;
begin
  perform public.trial_check_secret(p_server_secret);

  if lower(trim(coalesce(p_email, ''))) = '' then
    return jsonb_build_object('status', 'invalid');
  end if;
  v_canonical := public.email_canonical(lower(trim(p_email)));

  select * into v_row from public.trial_users t where t.email = v_canonical;
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  if exists (
    select 1 from auth.users u where public.email_canonical(u.email) = v_canonical
  ) then
    return jsonb_build_object('status', 'already_access', 'email', v_canonical);
  end if;

  if p_version is not null and p_version <> v_row.token_version then
    return jsonb_build_object('status', 'revoked');
  end if;

  select s.scans_limit into v_limit from public.trial_settings s where s.id = true;

  return jsonb_build_object(
    'status', 'ok',
    'email', v_canonical,
    'first_name', v_row.first_name,
    'token_version', v_row.token_version,
    'scans_left', greatest(coalesce(v_limit, 0) - v_row.scans_used, 0),
    'scans_total', v_limit
  );
end $$;

revoke execute on function public.trial_link_status(text, text, integer) from public;
grant execute on function public.trial_link_status(text, text, integer) to anon;

-- ---------------------------------------------------------------------------
-- 2. trial_scan_start learns the version, and refuses a mailbox that has an account.
--
-- The argument list changes, so the old function is dropped and the new one created,
-- with the grants 20261109170000 gave it re-applied. p_version defaults to null so the
-- service still running the previous build (which sends three arguments) keeps working
-- for the minutes between this migration and its redeploy; null skips only the version
-- check, never the limits.
--
-- Both new refusals are read under the same locks as the counters, so a revoke or a
-- sign-up that commits first is seen by the next scan.
-- ---------------------------------------------------------------------------
drop function if exists public.trial_scan_start(text, text, text);

create function public.trial_scan_start(
  p_server_secret text,
  p_email text,
  p_ip text default null,
  p_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_canonical text;
  v_ip_hash text := public.trial_ip_hash(p_ip);
  v_scans_limit integer;
  v_daily_budget integer;
  v_scans_used integer;
  v_token_version integer;
  v_ip_scans integer := 0;
  v_global_scans integer := 0;
  v_call_id uuid;
begin
  perform public.trial_check_secret(p_server_secret);

  if lower(trim(coalesce(p_email, ''))) = '' then
    return jsonb_build_object('status', 'invalid');
  end if;
  v_canonical := public.email_canonical(lower(trim(p_email)));

  select s.scans_limit, s.daily_budget into v_scans_limit, v_daily_budget
    from public.trial_settings s where s.id = true;
  if v_scans_limit is null then
    raise exception 'trial settings not seeded' using errcode = '55000';
  end if;

  if not exists (select 1 from public.trial_users t where t.email = v_canonical) then
    return jsonb_build_object('status', 'invalid');
  end if;

  perform pg_advisory_xact_lock(hashtext('trial_global'));
  perform pg_advisory_xact_lock(hashtext(current_date::text || coalesce(v_ip_hash, '')));

  select t.scans_used, t.token_version into v_scans_used, v_token_version
    from public.trial_users t where t.email = v_canonical;

  if p_version is not null and p_version <> v_token_version then
    return jsonb_build_object('status', 'revoked');
  end if;

  if exists (
    select 1 from auth.users u where public.email_canonical(u.email) = v_canonical
  ) then
    return jsonb_build_object('status', 'already_access');
  end if;

  if v_scans_used >= v_scans_limit then
    return jsonb_build_object(
      'status', 'no_scans_left', 'scans_left', 0, 'scans_total', v_scans_limit
    );
  end if;

  if v_ip_hash is not null then
    select count(*) into v_ip_scans
      from public.llm_calls c
     where c.trial = true
       and c.ip_hash = v_ip_hash
       and c.created_at >= date_trunc('day', now());
    if v_ip_scans >= 30 then
      return jsonb_build_object(
        'status', 'rate_limited', 'scans_left', v_scans_limit - v_scans_used,
        'scans_total', v_scans_limit
      );
    end if;
  end if;

  select count(*) into v_global_scans
    from public.llm_calls c
   where c.trial = true
     and c.created_at >= date_trunc('day', now());
  if v_global_scans >= v_daily_budget then
    return jsonb_build_object(
      'status', 'busy', 'scans_left', v_scans_limit - v_scans_used,
      'scans_total', v_scans_limit
    );
  end if;

  update public.trial_users
     set scans_used = scans_used + 1,
         last_used_at = now(),
         ip_hash = v_ip_hash
   where email = v_canonical;

  insert into public.llm_calls (user_id, model, status, trial, ip_hash)
  values (null, 'trial', 'reserved', true, v_ip_hash)
  returning id into v_call_id;

  return jsonb_build_object(
    'status', 'ok',
    'scans_left', v_scans_limit - (v_scans_used + 1),
    'scans_total', v_scans_limit,
    'call_id', v_call_id
  );
end $$;

revoke execute on function public.trial_scan_start(text, text, text, integer) from public;
grant execute on function public.trial_scan_start(text, text, text, integer) to anon;

-- ---------------------------------------------------------------------------
-- 3. The admin's side: issue, mark sent, revoke, and read back.
--
-- Called by the parse-meal service with the admin's own JWT (issue, mark sent) or by
-- the admin page directly (revoke, read). security definer because trial_users is
-- service-role only; the is_admin() guard is therefore what stands between a signed-in
-- stranger and these rows, as in admin_spend.
-- ---------------------------------------------------------------------------

-- Ensures the mailbox has a trial row (so scans count against it) and returns the
-- version to sign. Does not mark the link sent: the invite path marks it only once
-- the Gmail draft exists.
create function public.admin_trial_link_issue(p_email text, p_first_name text default null)
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

  insert into public.trial_users (email, first_name)
  values (v_canonical, v_name)
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

create function public.admin_trial_link_mark_sent(p_email text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  update public.trial_users
     set link_sent_at = now()
   where email = public.email_canonical(lower(trim(coalesce(p_email, ''))));
end $$;

revoke execute on function public.admin_trial_link_mark_sent(text) from public, anon;
grant execute on function public.admin_trial_link_mark_sent(text) to authenticated;

-- Every token issued so far for this mailbox stops working. The next link issued
-- carries the new version, so revoking and then copying a fresh link is the reset.
create function public.admin_trial_link_revoke(p_email text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  update public.trial_users
     set token_version = token_version + 1,
         link_sent_at = null
   where email = public.email_canonical(lower(trim(coalesce(p_email, ''))));
end $$;

revoke execute on function public.admin_trial_link_revoke(text) from public, anon;
grant execute on function public.admin_trial_link_revoke(text) to authenticated;

-- The links sent to the addresses on the admin's screen. The page passes the emails it
-- shows, and the match is made here with email_canonical, so the Gmail folding rule
-- has one home and the page never needs a copy of it. Each row answers with the email
-- exactly as it was passed in, so the page can match it back to its own row.
create function public.admin_trial_links(p_emails text[])
returns table (
  email text,
  first_name text,
  link_sent_at timestamptz,
  scans_used integer,
  scans_limit integer
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  return query
    select e.address, t.first_name, t.link_sent_at, t.scans_used, s.scans_limit
      from unnest(coalesce(p_emails, '{}'::text[])) as e(address)
      join public.trial_users t
        on t.email = public.email_canonical(lower(trim(e.address)))
     cross join public.trial_settings s
     where t.link_sent_at is not null;
end $$;

revoke execute on function public.admin_trial_links(text[]) from public, anon;
grant execute on function public.admin_trial_links(text[]) to authenticated;
