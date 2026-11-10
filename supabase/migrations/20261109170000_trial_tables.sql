-- The free trial: a 10-scan funnel with no Supabase auth account.
--
-- A trial visitor proves they are a person (Turnstile, checked by the server), gets a
-- 6-digit code by email, and receives a signed trial token (HMAC, issued by the server).
-- The server analyses their meal with the same parse-meal pipeline, in memory, and never
-- stores the photo. Trial calls land in the existing llm_calls table with a trial flag,
-- so the admin "Model spend" panel shows them as one line.
--
-- Access rule: both tables are server-only, and now so is the whole funnel. Every
-- trial_* function takes a p_server_secret and raises unless it matches the secret held
-- in Supabase Vault. anon keeps EXECUTE (the service calls through PostgREST with the
-- publishable key), but the functions are inert without the secret: a stranger who
-- reaches them gets an error, never a code or a scan.
--
-- p_ip is an argument on trial_send_code and trial_scan_start rather than a value the
-- function derives from request.headers, and that is only trustworthy *because* of the
-- secret gate. The parse-meal service reads the end user's address from its own request
-- headers (cf-connecting-ip / x-forwarded-for) and passes it in; were the function to
-- call public.request_ip() it would see the address of the server making the PostgREST
-- call, i.e. its own, and every trial caller would share one bucket. p_ip is trusted
-- only because the secret gate already proves the caller is our server and not the
-- visitor.
--
-- The limits the service used to configure (TRIAL_SCANS, TRIAL_DAILY_BUDGET) are no
-- longer passed in as arguments; they live in the single-row trial_settings table,
-- which only service_role may write. The per-IP ceilings (3 new emails, 30 scans a day)
-- stay fixed here, as they were.
--
-- Rollback: supabase/rollback/20261109170000_trial_tables.sql
--
-- Deploy note: the operator must create the Vault secret before the trial can run:
--
--   select vault.create_secret('trial_server_secret', '<the same value set as
--     TRIAL_SERVER_SECRET in the parse-meal service env>');
--
-- Until that row exists the gate reads null and every trial_* function refuses.

-- ---------------------------------------------------------------------------
-- 1. The server-only tables.
-- ---------------------------------------------------------------------------

-- One row per trial mailbox. The email is the canonical form (same Gmail rule as
-- invites: dots and +suffixes folded, googlemail.com folded into gmail.com), so the
-- same inbox cannot get a second trial under a different spelling.
create table public.trial_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  first_name text,
  scans_used integer not null default 0,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  ip_hash text
);
create index trial_users_ip_created_idx on public.trial_users (ip_hash, created_at desc);
alter table public.trial_users enable row level security;
revoke all on public.trial_users from anon, authenticated;
grant all on public.trial_users to service_role;

-- The current code for one mailbox, at most one at a time. The code is stored as a
-- sha256 hash, so a database read cannot hand back a working code.
create table public.trial_codes (
  email text primary key,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0
);
alter table public.trial_codes enable row level security;
revoke all on public.trial_codes from anon, authenticated;
grant all on public.trial_codes to service_role;

-- The limits the enforcing function reads, one row. service_role writes it (the
-- deploy step, or a future admin control); anon and authenticated get nothing, and
-- there is no policy because no caller but service_role may touch it and service_role
-- bypasses RLS. This is the same shape as auth_entry_state_throttle: an empty grant
-- list is easier to audit than a policy that happens to deny everything.
create table public.trial_settings (
  id boolean primary key default true check (id),
  scans_limit integer not null,
  daily_budget integer not null
);
alter table public.trial_settings enable row level security;
revoke all on public.trial_settings from anon, authenticated;
grant all on public.trial_settings to service_role;

-- The seed. The numbers match what the service used to default to, so a deploy that
-- does nothing else behaves exactly as before.
insert into public.trial_settings (id, scans_limit, daily_budget)
values (true, 10, 200);

-- ---------------------------------------------------------------------------
-- 2. llm_calls grows a trial flag and the columns trial calls need.
--
-- user_id becomes nullable because a trial caller has no auth account. The ip_hash is
-- only ever set for trial rows, where it is what the per-IP scan ceiling counts.
-- ---------------------------------------------------------------------------
alter table public.llm_calls alter column user_id drop not null;
alter table public.llm_calls add column trial boolean not null default false;
alter table public.llm_calls add column ip_hash text;

-- ---------------------------------------------------------------------------
-- 3. The server secret, read from Supabase Vault.
--
-- The secret itself lives in Vault, not in this file, so it is never committed. The
-- function is security definer and owned by the role that applies migrations (postgres),
-- which is what Vault requires to read vault.decrypted_secrets. It is granted to no
-- caller role: it exists only for the trial_* functions below.
--
-- A missing secret row returns null, and the gate treats null as a mismatch, so until
-- the operator runs vault.create_secret the trial refuses every caller rather than
-- running with the gate disabled.
-- ---------------------------------------------------------------------------
create or replace function public.trial_server_secret()
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
   where d.name = 'trial_server_secret';
  return v_secret;
end $$;

revoke execute on function public.trial_server_secret() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The salted IP hash.
--
-- Same idea as public.ip_hash (which the invite flow uses), but with a salt so the
-- stored value cannot be reversed against a list of addresses. The salt is a fixed
-- string in this migration rather than a server secret: its job is to stop a rainbow
-- lookup, and the hash is only ever compared, never reversed.
-- ---------------------------------------------------------------------------
create or replace function public.trial_ip_hash(p_ip text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
           when p_ip is null or p_ip = '' then null
           else encode(sha256(convert_to(p_ip || ':nutritrack-trial-ip-v1', 'UTF8')), 'hex')
         end
$$;

revoke execute on function public.trial_ip_hash(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The secret gate, stated once as a helper each function calls.
-- ---------------------------------------------------------------------------
create or replace function public.trial_check_secret(p_server_secret text)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $$
declare
  v_secret text := public.trial_server_secret();
begin
  -- A null p_server_secret (the caller passed nothing) and a null Vault secret (the
  -- operator never created it) both fail. The comparison is a plain inequality: the
  -- server holds the secret, and an attacker who does not gets the same uniform error,
  -- so there is no side channel worth defending with a constant-time compare here.
  if v_secret is null or p_server_secret is null or p_server_secret <> v_secret then
    raise exception 'invalid server secret' using errcode = '42501';
  end if;
end $$;

revoke execute on function public.trial_check_secret(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Sending the code.
--
-- Five answers, as a jsonb so the server can carry the plaintext code on the one path
-- that needs it (and only that path):
--
--   invalid         not an address worth a code
--   already_access  already invited or already has an account; the caller is sent to sign in
--   rate_limited    the per-IP ceiling of 3 new trial emails a day was reached
--   sent            a code was generated, stored hashed, and returned for the email
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

  -- Already on the list, or already has an account: no trial to run.
  if exists (
    select 1 from public.allowed_emails a
     where public.email_canonical(a.email) = v_canonical
  ) or exists (
    select 1 from auth.users u
     where public.email_canonical(u.email) = v_canonical
  ) then
    return jsonb_build_object('status', 'already_access');
  end if;

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

  return jsonb_build_object('status', 'sent', 'code', v_code, 'email', v_canonical);
end $$;

revoke execute on function public.trial_send_code(text, text, text, text) from public;
grant execute on function public.trial_send_code(text, text, text, text) to anon;

-- ---------------------------------------------------------------------------
-- 7. Verifying the code.
--
--   invalid            nothing to check
--   no_code            no code was sent for this mailbox
--   expired            the ten-minute window passed
--   attempts_exceeded  five wrong guesses already
--   wrong_code         the code did not match (and the attempt is counted)
--   ok                 matched; the code is deleted so it cannot be replayed
-- ---------------------------------------------------------------------------
create or replace function public.trial_verify_code(p_server_secret text, p_email text, p_code text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_canonical text;
  v_row public.trial_codes%rowtype;
  v_hash text;
begin
  perform public.trial_check_secret(p_server_secret);

  if lower(trim(coalesce(p_email, ''))) = '' or trim(coalesce(p_code, '')) = '' then
    return 'invalid';
  end if;

  v_canonical := public.email_canonical(lower(trim(p_email)));

  select * into v_row from public.trial_codes t where t.email = v_canonical;
  if not found then
    return 'no_code';
  end if;

  if v_row.expires_at < now() then
    return 'expired';
  end if;

  if v_row.attempts >= 5 then
    return 'attempts_exceeded';
  end if;

  v_hash := encode(sha256(convert_to(trim(p_code), 'UTF8')), 'hex');
  if v_hash <> v_row.code_hash then
    update public.trial_codes set attempts = attempts + 1 where email = v_canonical;
    return 'wrong_code';
  end if;

  delete from public.trial_codes where email = v_canonical;
  return 'ok';
end $$;

revoke execute on function public.trial_verify_code(text, text, text) from public;
grant execute on function public.trial_verify_code(text, text, text) to anon;

-- ---------------------------------------------------------------------------
-- 8. Starting a scan.
--
-- The three ceilings, checked together and atomically: the per-email total
-- (trial_settings.scans_limit), the per-IP daily ceiling (30), and the global daily
-- budget (trial_settings.daily_budget). Both advisory locks are transaction-scoped, so
-- the count-then-reserve below cannot overshoot: a second caller waits on the global
-- lock until the first has committed its reserved row, then re-reads the counters.
--
-- On success the scan is consumed immediately and a reserved llm_calls row is inserted
-- in the same transaction; trial_log_call later fills that row in by id. The reserved
-- row is what the daily ceilings count, which is why the counter and the row that
-- increments it must be written together.
--
--   invalid        not a trial mailbox this server started
--   no_scans_left  the per-email total is used up
--   busy           the global daily budget is spent
--   rate_limited   this IP has used its 30 scans today
--   ok             consumed, with the scans left and the reserved call id
-- ---------------------------------------------------------------------------
create or replace function public.trial_scan_start(
  p_server_secret text,
  p_email text,
  p_ip text default null
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

  -- The mailbox must exist (trial_send_code created it). A miss is 'invalid', not an
  -- error: this caller is not a trial our server started.
  if not exists (select 1 from public.trial_users t where t.email = v_canonical) then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- Serialise. The global lock makes every scan_start wait for the previous one; the
  -- per-IP lock keys on today's date and the salted hash of the address. Both are
  -- xact locks, held until this transaction commits or rolls back, so the reserved row
  -- and the counters stay together.
  perform pg_advisory_xact_lock(hashtext('trial_global'));
  perform pg_advisory_xact_lock(hashtext(current_date::text || coalesce(v_ip_hash, '')));

  -- Re-read the per-mailbox counter under the lock: a concurrent caller for the same
  -- mailbox may have committed between the existence check above and now.
  select t.scans_used into v_scans_used
    from public.trial_users t where t.email = v_canonical;

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

  -- Reserve the llm_calls row now, so the daily ceilings above (which count trial
  -- rows) see the scan the moment it is consumed. 'reserved' is the placeholder until
  -- trial_log_call fills in the model's answer; a scan whose model call never
  -- completes stays reserved and still counts, which is correct — the slot was spent.
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

revoke execute on function public.trial_scan_start(text, text, text) from public;
grant execute on function public.trial_scan_start(text, text, text) to anon;

-- ---------------------------------------------------------------------------
-- 9. Recording a trial call.
--
-- Written after the model answers, best-effort from the caller's side, exactly like
-- the authenticated path's recordCall. It updates the reserved row trial_scan_start
-- created rather than inserting a second row, so the daily ceilings stay accurate: the
-- row that counts already exists, and this only fills in what the model reported.
--
-- The update is scoped to trial = true and user_id is null, so a call id that names an
-- authenticated user's row can never be rewritten through this function.
-- ---------------------------------------------------------------------------
create or replace function public.trial_log_call(
  p_server_secret text,
  p_call_id uuid,
  p_model text,
  p_prompt_tokens integer,
  p_completion_tokens integer,
  p_latency_ms integer,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.trial_check_secret(p_server_secret);

  update public.llm_calls
     set model = p_model,
         prompt_tokens = p_prompt_tokens,
         completion_tokens = p_completion_tokens,
         latency_ms = p_latency_ms,
         status = p_status
   where id = p_call_id
     and trial = true
     and user_id is null;
end $$;

revoke execute on function public.trial_log_call(text, uuid, text, integer, integer, integer, text) from public;
grant execute on function public.trial_log_call(text, uuid, text, integer, integer, integer, text) to anon;

-- ---------------------------------------------------------------------------
-- 10. The admin Trial card.
--
-- Today's trial scans (UTC day, the same boundary the ceilings use), the configured
-- budget read from trial_settings (not from a constant the browser holds), and the
-- number of trial mailboxes. Admin-only, security definer because it reads tables no
-- caller role may touch.
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
      (select count(*)::integer from public.trial_users) as user_count;
end $$;

revoke execute on function public.admin_trial_stats() from public, anon;
grant execute on function public.admin_trial_stats() to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Model spend gains one trial line.
--
-- admin_spend is re-created so it appends a synthetic "Trial" row aggregating every
-- trial call. is_trial marks it; the browser renders it apart from the per-user rows.
-- ---------------------------------------------------------------------------
create or replace function public.admin_spend()
returns table (
  user_id uuid,
  email text,
  timezone text,
  calls_today integer,
  resets_today timestamptz,
  calls_month integer,
  tokens_month bigint,
  calls_total integer,
  tokens_total bigint,
  last_call_at timestamptz,
  is_trial boolean
)
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
    with users as (
      select u.id, u.email,
             coalesce(p.timezone, 'UTC') as tz
        from auth.users u
        left join public.profiles p on p.user_id = u.id
    ),
    spend as (
      select c.user_id,
             count(*) filter (
               where c.created_at >= public.local_day_start(now(), us.tz)
             )::integer as calls_today,
             count(*) filter (
               where c.created_at >= date_trunc('month', now() at time zone us.tz)
                                     at time zone us.tz
             )::integer as calls_month,
             coalesce(sum(coalesce(c.prompt_tokens, 0) + coalesce(c.completion_tokens, 0))
               filter (
                 where c.created_at >= date_trunc('month', now() at time zone us.tz)
                                       at time zone us.tz
               ), 0)::bigint as tokens_month,
             count(*)::integer as calls_total,
             coalesce(sum(coalesce(c.prompt_tokens, 0) + coalesce(c.completion_tokens, 0)), 0)::bigint
               as tokens_total,
             max(c.created_at) as last_call_at
        from public.llm_calls c
        join users us on us.id = c.user_id
       where c.trial = false
       group by c.user_id
    )
    select
      us.id,
      us.email,
      us.tz,
      coalesce(s.calls_today, 0),
      public.local_day_start_offset(now(), us.tz, 1),
      coalesce(s.calls_month, 0),
      coalesce(s.tokens_month, 0),
      coalesce(s.calls_total, 0),
      coalesce(s.tokens_total, 0),
      s.last_call_at,
      false as is_trial
    from users us
    left join spend s on s.user_id = us.id

    union all

    select
      null::uuid as user_id,
      'Trial' as email,
      'UTC' as timezone,
      count(*) filter (where c.created_at >= date_trunc('day', now()))::integer as calls_today,
      date_trunc('day', now()) + interval '1 day' as resets_today,
      count(*) filter (where c.created_at >= date_trunc('month', now()))::integer as calls_month,
      coalesce(sum(coalesce(c.prompt_tokens, 0) + coalesce(c.completion_tokens, 0))
        filter (where c.created_at >= date_trunc('month', now())), 0)::bigint as tokens_month,
      count(*)::integer as calls_total,
      coalesce(sum(coalesce(c.prompt_tokens, 0) + coalesce(c.completion_tokens, 0)), 0)::bigint
        as tokens_total,
      max(c.created_at) as last_call_at,
      true as is_trial
    from public.llm_calls c
    where c.trial = true

    order by calls_total desc, email;
end $$;

revoke execute on function public.admin_spend() from public, anon;
grant execute on function public.admin_spend() to authenticated;

-- ---------------------------------------------------------------------------
-- 12. Trial requests are marked.
--
-- The 0-scans wall calls request_invite with p_from_trial, so the admin's pending
-- list can say "Trial: 10/10 used" rather than mistaking a trial exhaust for an
-- ordinary ask. The old four-argument overload is dropped and replaced, so there is
-- one function and one way to record a request.
-- ---------------------------------------------------------------------------
alter table public.invite_requests add column from_trial boolean not null default false;

drop function if exists public.request_invite(text, text, boolean, text);

create or replace function public.request_invite(
  p_email text,
  p_first_name text default null,
  p_auto boolean default false,
  p_honeypot text default null,
  p_from_trial boolean default false
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name text := nullif(left(trim(coalesce(p_first_name, '')), 50), '');
  v_status text;
  v_recent integer := 0;
  v_ip text;
  v_ip_hash text;
  v_ip_recent integer := 0;
begin
  if coalesce(trim(p_honeypot), '') <> '' then
    return 'requested';
  end if;

  if auth.uid() is not null then
    v_email := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
    if v_name is null then
      select nullif(
               trim(
                 coalesce(
                   u.raw_user_meta_data ->> 'given_name',
                   split_part(
                     coalesce(
                       u.raw_user_meta_data ->> 'full_name',
                       u.raw_user_meta_data ->> 'name',
                       ''
                     ),
                     ' ',
                     1
                   )
                 )
               ),
               ''
             )
        into v_name
        from auth.users u
       where u.id = auth.uid();
      v_name := nullif(left(coalesce(v_name, ''), 50), '');
    end if;
  end if;

  if length(v_email) = 0
     or length(v_email) > 254
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return 'invalid';
  end if;

  if exists (
    select 1 from public.allowed_emails a
     where public.email_canonical(a.email) = public.email_canonical(v_email)
  ) then
    return 'already_invited';
  end if;

  select r.status into v_status
    from public.invite_requests r
   where public.email_canonical(r.email) = public.email_canonical(v_email)
   limit 1;

  if v_status = 'pending' then
    if v_name is not null then
      update public.invite_requests
         set first_name = v_name
       where email = v_email
         and first_name is null;
    end if;
    return 'already_pending';
  end if;

  if v_status = 'declined' then
    return 'requested';
  end if;

  if v_status = 'revoked' and p_auto then
    return 'requested';
  end if;

  if auth.uid() is null then
    v_ip := public.request_ip();
    v_ip_hash := public.ip_hash(v_ip);

    if v_ip_hash is not null then
      select count(*) into v_ip_recent
        from public.invite_requests r
       where r.request_ip_hash = v_ip_hash
         and r.requested_at > now() - interval '1 hour';
      if v_ip_recent >= 3 then
        return 'rate_limited';
      end if;
    end if;

    select count(*) into v_recent
      from public.invite_requests r
     where r.requested_by is null
       and r.requested_at > now() - interval '10 minutes';
    if v_recent >= 20 then
      return 'rate_limited';
    end if;
  end if;

  if v_status = 'revoked' then
    update public.invite_requests
       set status = 'pending',
           requested_at = now(),
           handled_at = null,
           handled_by = null,
           first_name = coalesce(v_name, first_name),
           from_trial = p_from_trial
     where email = v_email
       and status = 'revoked';
    return 'requested';
  end if;

  insert into public.invite_requests (email, first_name, requested_by, status, request_ip_hash, from_trial)
  values (v_email, v_name, auth.uid(), 'pending', v_ip_hash, p_from_trial)
  on conflict (email) do nothing;

  if exists (
    select 1 from public.invite_requests r
     where public.email_canonical(r.email) = public.email_canonical(v_email)
  ) then
    return 'requested';
  end if;
  return 'rate_limited';
end $$;

revoke execute on function public.request_invite(text, text, boolean, text, boolean) from public;
grant execute on function public.request_invite(text, text, boolean, text, boolean) to anon, authenticated;
