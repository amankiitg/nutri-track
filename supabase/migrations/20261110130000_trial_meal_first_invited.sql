-- Meal-first /try, and invited addresses get the trial too.
--
-- Two behaviour changes, neither of which adds a column or a table:
--
--   1. The code flow (trial_send_code) no longer refuses an address that is on the
--      invite list or that already has an account. The trial is a preview for everyone;
--      the only thing "invited" changes is what the page says during and after it, so
--      trial_send_code answers with an `invited` flag instead of a refusal.
--
--   2. trial_scan_start and trial_link_status no longer refuse a mailbox that has an
--      account. The "already have access" wall is gone: an invited address that already
--      signed up can still preview, and a visitor who signs up mid-trial keeps the trial
--      they were already in. The version check (revoke) is untouched, so Revoke still
--      kills the link only.
--
-- The shared scan counter needs no change: trial_send_code and admin_trial_link_issue
-- already key on the same canonical email, so the code trial and the /t/ link spend
-- from one trial_users row.

-- ---------------------------------------------------------------------------
-- 1. trial_send_code: send a code to everyone, and say whether the address is invited.
-- ---------------------------------------------------------------------------
create or replace function public.trial_send_code(
  p_server_secret text,
  p_email text,
  p_first_name text default null,
  p_ip text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name text := nullif(left(trim(coalesce(p_first_name, '')), 50), '');
  v_canonical text;
  v_invited boolean := false;
  v_ip_hash text := public.trial_ip_hash(p_ip);
  v_recent integer := 0;
  v_code text;
  v_code_hash text;
begin
  perform public.trial_check_secret(p_server_secret);

  if length(v_email) = 0
     or length(v_email) > 254
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return jsonb_build_object('status', 'invalid');
  end if;

  v_canonical := public.email_canonical(v_email);

  -- An address on the invite list still gets a code and a trial; the flag only changes
  -- the sign-in line the page shows during and after the trial.
  select exists (
    select 1 from public.allowed_emails a
     where public.email_canonical(a.email) = v_canonical
  ) into v_invited;

  -- Per-IP ceiling on new trial emails: three distinct mailboxes a day.
  if v_ip_hash is not null then
    select count(*) into v_recent
      from public.trial_users t
     where t.ip_hash = v_ip_hash
       and t.created_at >= date_trunc('day', now());
    if v_recent >= 3 then
      return jsonb_build_object('status', 'rate_limited');
    end if;
  end if;

  v_code := (100000 + floor(random() * 900000)::int)::text;
  v_code_hash := encode(sha256(convert_to(v_code, 'UTF8')), 'hex');

  -- The row is created on first code, so "new trial emails per day" counts these rows.
  insert into public.trial_users (email, first_name, ip_hash)
  values (v_canonical, v_name, v_ip_hash)
  on conflict (email) do update
    set first_name = coalesce(excluded.first_name, public.trial_users.first_name),
        ip_hash = excluded.ip_hash;

  insert into public.trial_codes (email, code_hash, expires_at, attempts)
  values (v_canonical, v_code_hash, now() + interval '10 minutes', 0)
  on conflict (email) do update
    set code_hash = excluded.code_hash,
        expires_at = excluded.expires_at,
        attempts = 0;

  return jsonb_build_object(
    'status', 'sent',
    'code', v_code,
    'email', v_canonical,
    'invited', v_invited
  );
end $$;

-- ---------------------------------------------------------------------------
-- 2. trial_scan_start: drop the "already has an account" refusal. The version
--    check, the limits and the throttle are unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.trial_scan_start(
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

-- ---------------------------------------------------------------------------
-- 3. trial_link_status: drop the "already has an account" refusal, and answer
--    whether the address is invited, so the page knows which end screen to show.
-- ---------------------------------------------------------------------------
create or replace function public.trial_link_status(
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
  v_invited boolean := false;
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

  if p_version is not null and p_version <> v_row.token_version then
    return jsonb_build_object('status', 'revoked');
  end if;

  select exists (
    select 1 from public.allowed_emails a
     where public.email_canonical(a.email) = v_canonical
  ) into v_invited;

  select s.scans_limit into v_limit from public.trial_settings s where s.id = true;

  return jsonb_build_object(
    'status', 'ok',
    'email', v_canonical,
    'first_name', v_row.first_name,
    'token_version', v_row.token_version,
    'scans_left', greatest(coalesce(v_limit, 0) - v_row.scans_used, 0),
    'scans_total', v_limit,
    'invited', v_invited
  );
end $$;
