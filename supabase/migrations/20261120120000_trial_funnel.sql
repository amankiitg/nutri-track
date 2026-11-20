-- Trial funnel counters.
--
-- The trial is anonymous on purpose: a device row holds a salted IP hash and a scan
-- count, and nothing else. That is enough to run the trial and not enough to see where
-- people fall out of it — how many opened /try, how many tapped Analyse, how many got a
-- token, how many got a result, how many hit the limit, how many asked for an invite.
-- This migration adds counters for exactly those steps.
--
-- Counts only. No email, no raw address, no photo, no meal text: a row here is
-- (day, event, count). The single piece of state about a person is a salted hash of
-- their address in a separate table, kept only to cap the two browser-sent events at
-- 20 a day per network — the same hash `trial_ip_hash` already produces for
-- `trial_devices` and `llm_calls`, and never the address itself.
--
-- `day` is the UTC date. A trial visitor has no profile and therefore no time zone, so
-- there is no local day to use; the admin card says "today" meaning UTC today.
--
-- Rollback: supabase/rollback/20261120120000_trial_funnel.sql

-- --------------------------------------------------------------------------- --
-- 1. The counters.
-- --------------------------------------------------------------------------- --

create table public.trial_funnel_daily (
  day date not null,
  event text not null,
  count integer not null default 0,
  primary key (day, event),
  constraint trial_funnel_daily_event check (event in (
    'try_page_view',
    'analyse_tapped',
    'turnstile_failed',
    'token_issued',
    'analysis_ok',
    'analysis_error',
    'limit_reached',
    'request_invite_submitted'
  ))
);

alter table public.trial_funnel_daily enable row level security;
-- No policy and no caller grant: this table is written by the functions below and read
-- through `admin_trial_funnel`, both security definer. The admin read is a function so the
-- allowlist and the day spine live in one place rather than in a policy.
revoke all on public.trial_funnel_daily from anon, authenticated;
grant all on public.trial_funnel_daily to service_role;

-- --------------------------------------------------------------------------- --
-- 2. The rate limit's own store.
--
-- The aggregate above cannot answer "how many has this network sent today", so the cap
-- needs one row per (day, event, hash). It is not a report: it is pruned to a week on
-- every capped write, and nothing reads it but the cap check itself.
-- --------------------------------------------------------------------------- --

create table public.trial_funnel_ip_daily (
  day date not null,
  event text not null,
  ip_hash text not null,
  count integer not null default 0,
  primary key (day, event, ip_hash)
);

alter table public.trial_funnel_ip_daily enable row level security;
revoke all on public.trial_funnel_ip_daily from anon, authenticated;
grant all on public.trial_funnel_ip_daily to service_role;

-- --------------------------------------------------------------------------- --
-- 3. The bump, in one place.
--
-- Returns false when the cap was already reached, so the caller can answer "capped"
-- without deciding what a cap is. p_cap null means uncapped, which is right for the
-- server-sent events: the scan flow already bounds those (10 scans a device, 20 a
-- network, a global daily budget), and a second ceiling on a counter would only lose
-- events the flow had already counted.
-- --------------------------------------------------------------------------- --

create function public.trial_funnel_bump(
  p_event text,
  p_ip_hash text default null,
  p_cap integer default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $$
declare
  v_seen integer;
begin
  if p_ip_hash is not null and p_cap is not null then
    insert into public.trial_funnel_ip_daily as f (day, event, ip_hash, count)
    values (current_date, p_event, p_ip_hash, 1)
    on conflict (day, event, ip_hash) do update set count = f.count + 1
    returning f.count into v_seen;

    -- Old days are not deleted from the totals, only from here: the cap needs a week of
    -- history at most, and this table is the only thing in the schema keyed by a hash.
    delete from public.trial_funnel_ip_daily where day < current_date - 7;

    if v_seen > p_cap then
      return false;
    end if;
  end if;

  insert into public.trial_funnel_daily as f (day, event, count)
  values (current_date, p_event, 1)
  on conflict (day, event) do update set count = f.count + 1;

  return true;
end $$;

revoke execute on function public.trial_funnel_bump(text, text, integer) from public, anon, authenticated;

-- --------------------------------------------------------------------------- --
-- 4. The writer, for the parse-meal service.
--
-- Granted to anon because that is the role the service's client carries, and gated by the
-- same server secret every other trial function uses: no secret, no write. The browser
-- never calls this — it posts to the service, which is the only place the real address is
-- known, and that is what makes the per-network cap meaningful.
--
-- The event is checked twice on purpose: the constraint on the table is the last word, and
-- the check here answers a mistake with a clear error instead of a constraint violation.
-- --------------------------------------------------------------------------- --

create function public.trial_funnel_log(
  p_event text,
  p_ip text default null,
  p_server_secret text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $$
declare
  v_event text := lower(trim(coalesce(p_event, '')));
  v_cap integer;
begin
  perform public.trial_check_secret(p_server_secret);

  if v_event not in (
    'try_page_view', 'analyse_tapped', 'turnstile_failed', 'token_issued',
    'analysis_ok', 'analysis_error', 'limit_reached', 'request_invite_submitted'
  ) then
    raise exception 'unknown funnel event' using errcode = '22023';
  end if;

  -- Only the two events a browser can send repeatedly are capped. Twenty a day per
  -- network is the number agreed for them; a person opening /try twenty times in a day is
  -- not a visitor any more.
  v_cap := case when v_event in ('try_page_view', 'analyse_tapped') then 20 else null end;

  if public.trial_funnel_bump(v_event, public.trial_ip_hash(p_ip), v_cap) then
    return jsonb_build_object('status', 'ok');
  end if;
  return jsonb_build_object('status', 'capped');
end $$;

revoke execute on function public.trial_funnel_log(text, text, text) from public;
grant execute on function public.trial_funnel_log(text, text, text) to anon;

-- --------------------------------------------------------------------------- --
-- 5. The admin read: today and the last n days, with every allowlisted event present.
--
-- A jsonb object rather than rows, so a day with no views answers 0 instead of being
-- absent, and the page does not have to know which events exist. Admin-only, checked
-- with the caller's own token like every other admin function.
-- --------------------------------------------------------------------------- --

create function public.admin_trial_funnel(p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog, pg_temp
as $$
declare
  v_days integer := least(greatest(coalesce(p_days, 7), 1), 30);
  v_start date := current_date - (least(greatest(coalesce(p_days, 7), 1), 30) - 1);
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'day', current_date,
    'days', v_days,
    'window_start', v_start,
    'today', (
      select coalesce(jsonb_object_agg(e.event, coalesce(f.count, 0)), '{}'::jsonb)
        from (values
                ('try_page_view'), ('analyse_tapped'), ('turnstile_failed'), ('token_issued'),
                ('analysis_ok'), ('analysis_error'), ('limit_reached'), ('request_invite_submitted')
             ) as e(event)
        left join public.trial_funnel_daily f on f.day = current_date and f.event = e.event
    ),
    'window', (
      select coalesce(jsonb_object_agg(e.event, coalesce(f.count, 0)), '{}'::jsonb)
        from (values
                ('try_page_view'), ('analyse_tapped'), ('turnstile_failed'), ('token_issued'),
                ('analysis_ok'), ('analysis_error'), ('limit_reached'), ('request_invite_submitted')
             ) as e(event)
        left join (
          select d.event, sum(d.count)::integer as count
            from public.trial_funnel_daily d
           where d.day >= v_start and d.day <= current_date
           group by d.event
        ) f on f.event = e.event
    )
  );
end $$;

revoke execute on function public.admin_trial_funnel(integer) from public, anon;
grant execute on function public.admin_trial_funnel(integer) to authenticated;

-- --------------------------------------------------------------------------- --
-- 6. "Asked for an invite", counted where the request lands.
--
-- The brief put this at request_invite itself. A trigger on the table that function
-- inserts into is the same event with one advantage: no copy of a 120-line function that
-- would then have to be kept in step with it. The `when (new.from_trial)` clause keeps
-- signed-in visitors' requests out of the trial funnel, which is what the event means.
-- --------------------------------------------------------------------------- --

create function public.trial_funnel_from_invite_request()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $$
begin
  perform public.trial_funnel_bump('request_invite_submitted', null, null);
  return null;
end $$;

revoke execute on function public.trial_funnel_from_invite_request() from public, anon, authenticated;

create trigger invite_requests_trial_funnel
  after insert on public.invite_requests
  for each row
  when (new.from_trial)
  execute function public.trial_funnel_from_invite_request();
