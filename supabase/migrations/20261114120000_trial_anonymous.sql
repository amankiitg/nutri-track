-- Anonymous free trials: a scan with no email, no code and no Resend.
--
-- The meal-first /try page issues its own trial token after Cloudflare Turnstile: one
-- token per browser, kept in localStorage, worth trial_settings.scans_limit scans. No
-- email address is asked for or stored on this path. The only identifier the database
-- keeps is a salted hash of the network address, which is what the per-IP daily ceiling
-- counts. The raw address is never written.
--
-- The email funnel is untouched: trial_users, trial_codes, trial_send_code and
-- trial_verify_code keep working exactly as before. A feature flag in the parse-meal
-- service (TRIAL_REQUIRE_EMAIL) chooses which flow the page offers; this migration only
-- adds the anonymous one beside it.
--
-- Limits for an anonymous trial:
--   * per device    trial_devices.scans_used < trial_settings.scans_limit (10)
--   * per network   20 scans a day, counted from llm_calls.ip_hash
--   * global        trial_settings.daily_budget (200), shared with email trials
--
-- Rollback: supabase/rollback/20261114120000_trial_anonymous.sql

-- ---------------------------------------------------------------------------
-- 1. One row per browser that started an anonymous trial.
--
-- The row is the device's scan counter, not a person: it holds no email, no name and
-- no raw address. Reissuing a token for a device id the browser already holds reuses
-- this row, so an expired token does not reset the 10 scans. Clearing localStorage is
-- what makes a new device, and the per-IP ceiling is what caps that.
-- ---------------------------------------------------------------------------
create table public.trial_devices (
  id uuid primary key default gen_random_uuid(),
  token_version integer not null default 0,
  scans_used integer not null default 0,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  ip_hash text
);
create index trial_devices_ip_created_idx on public.trial_devices (ip_hash, created_at desc);
alter table public.trial_devices enable row level security;
revoke all on public.trial_devices from anon, authenticated;
grant all on public.trial_devices to service_role;

-- ---------------------------------------------------------------------------
-- 2. Issuing the device row.
--
-- Called only by the parse-meal service, after it has verified Turnstile. The secret
-- gate is the same one every trial_* function uses. p_device_id is optional: when the
-- browser already has one, its row is reused rather than reset.
--
-- The token version is returned so the service can sign it into the HMAC token. It is
-- always 0 today; the column exists so a revoke can be added without changing the
-- token shape, exactly as trial_users.token_version works for personal links.
-- ---------------------------------------------------------------------------
create function public.trial_anon_start(
  p_server_secret text,
  p_ip text default null,
  p_device_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ip_hash text := public.trial_ip_hash(p_ip);
  v_limit integer;
  v_row public.trial_devices%rowtype;
begin
  perform public.trial_check_secret(p_server_secret);

  select s.scans_limit into v_limit from public.trial_settings s where s.id = true;
  if v_limit is null then
    raise exception 'trial settings not seeded' using errcode = '55000';
  end if;

  if p_device_id is not null then
    select * into v_row from public.trial_devices d where d.id = p_device_id;
  end if;

  if v_row.id is null then
    insert into public.trial_devices (ip_hash)
    values (v_ip_hash)
    returning * into v_row;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'device_id', v_row.id,
    'token_version', v_row.token_version,
    'scans_left', greatest(v_limit - v_row.scans_used, 0),
    'scans_total', v_limit
  );
end $$;

revoke execute on function public.trial_anon_start(text, text, uuid) from public;
grant execute on function public.trial_anon_start(text, text, uuid) to anon;

-- ---------------------------------------------------------------------------
-- 3. Starting an anonymous scan.
--
-- The same shape as trial_scan_start, with the device row in place of the mailbox and
-- a 20-a-day per-IP ceiling instead of the email flow's 30. The two advisory locks are
-- the same ones trial_scan_start takes, so an email scan and an anonymous scan from one
-- network serialise against each other and neither ceiling can be overshot.
--
-- The reserved llm_calls row is what both the per-IP and the global ceilings count, and
-- it is written in the same transaction as the counter. trial_log_call fills it in
-- afterwards, by id, so one scan is one row.
--
--   invalid        no such device (never issued, or the row is gone)
--   revoked        the token's version is not the current one
--   no_scans_left  the device's 10 scans are used up
--   rate_limited   this network has used its 20 scans today
--   busy           the global daily budget is spent
--   ok             consumed, with the scans left and the reserved call id
-- ---------------------------------------------------------------------------
create function public.trial_anon_scan_start(
  p_server_secret text,
  p_device_id uuid,
  p_ip text default null,
  p_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ip_hash text := public.trial_ip_hash(p_ip);
  v_scans_limit integer;
  v_daily_budget integer;
  v_device public.trial_devices%rowtype;
  v_ip_scans integer := 0;
  v_global_scans integer := 0;
  v_call_id uuid;
begin
  perform public.trial_check_secret(p_server_secret);

  if p_device_id is null then
    return jsonb_build_object('status', 'invalid');
  end if;

  select s.scans_limit, s.daily_budget into v_scans_limit, v_daily_budget
    from public.trial_settings s where s.id = true;
  if v_scans_limit is null then
    raise exception 'trial settings not seeded' using errcode = '55000';
  end if;

  select * into v_device from public.trial_devices d where d.id = p_device_id;
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  perform pg_advisory_xact_lock(hashtext('trial_global'));
  perform pg_advisory_xact_lock(hashtext(current_date::text || coalesce(v_ip_hash, '')));

  -- Re-read under the lock: a concurrent scan for the same device may have committed.
  select * into v_device from public.trial_devices d where d.id = p_device_id;
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  if p_version is not null and p_version <> v_device.token_version then
    return jsonb_build_object('status', 'revoked');
  end if;

  if v_device.scans_used >= v_scans_limit then
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
    if v_ip_scans >= 20 then
      return jsonb_build_object(
        'status', 'rate_limited',
        'scans_left', v_scans_limit - v_device.scans_used,
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
      'status', 'busy',
      'scans_left', v_scans_limit - v_device.scans_used,
      'scans_total', v_scans_limit
    );
  end if;

  update public.trial_devices
     set scans_used = scans_used + 1,
         last_used_at = now(),
         ip_hash = v_ip_hash
   where id = p_device_id;

  insert into public.llm_calls (user_id, model, status, trial, ip_hash)
  values (null, 'trial', 'reserved', true, v_ip_hash)
  returning id into v_call_id;

  return jsonb_build_object(
    'status', 'ok',
    'scans_left', v_scans_limit - (v_device.scans_used + 1),
    'scans_total', v_scans_limit,
    'call_id', v_call_id
  );
end $$;

revoke execute on function public.trial_anon_scan_start(text, uuid, text, integer) from public;
grant execute on function public.trial_anon_scan_start(text, uuid, text, integer) to anon;

-- ---------------------------------------------------------------------------
-- 4. The admin Trial card counts anonymous devices as trials started.
--
-- Return type is unchanged, so create or replace is enough. user_count is now the two
-- funnels together; scans_today already counted every trial call, anonymous included.
-- ---------------------------------------------------------------------------
create or replace function public.admin_trial_stats()
returns table (scans_today integer, budget integer, user_count integer)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  return query
    select
      (select count(*)::integer from public.llm_calls c
        where c.trial = true and c.created_at >= date_trunc('day', now())) as scans_today,
      (select s.daily_budget from public.trial_settings s where s.id = true) as budget,
      ((select count(*) from public.trial_users)
        + (select count(*) from public.trial_devices))::integer as user_count;
end $$;

revoke execute on function public.admin_trial_stats() from public, anon;
grant execute on function public.admin_trial_stats() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The admin Trials list gains anonymous rows.
--
-- Same columns and the same 1..50 ceiling. An anonymous device has no address, so its
-- email is null and its source is 'anonymous'; the page renders that as "Anonymous".
-- Searching "anonymous" finds them; searching an address still matches only email rows.
-- Required_after is false because an anonymous visitor who asks for an invite leaves an
-- address in invite_requests with no way to tie it back to a device — and joining that
-- up would need exactly the identifier this design does not keep.
-- ---------------------------------------------------------------------------
create or replace function public.admin_trial_list(p_search text default null, p_limit integer default 50)
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
    with rows as (
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

      union all

      select
        null::text as email,
        'anonymous'::text as source,
        false as invited,
        d.scans_used,
        coalesce(s.scans_limit, 0) as scans_limit,
        d.created_at as first_seen,
        d.last_used_at as last_active,
        false as requested_after
      from public.trial_devices d
      left join public.trial_settings s on s.id = true
    )
    select *
      from rows
     where v_search = '' or position(v_search in coalesce(rows.email, 'anonymous')) > 0
     order by rows.first_seen desc, rows.email
     limit v_limit;
end $$;

revoke execute on function public.admin_trial_list(text, integer) from public, anon;
grant execute on function public.admin_trial_list(text, integer) to authenticated;
