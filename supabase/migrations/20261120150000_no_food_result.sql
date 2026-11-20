-- A result with no food in it: the trial refunds the scan, and the funnel gets a step for it.
--
-- The trial promises ten meal analyses. A photo of a cat is not one of them, so the model's
-- empty answer gives the scan back — but only up to a cap per device or mailbox, because a
-- refund that always fired would be an unlimited supply of free model calls: photograph a wall,
-- get the scan back, repeat.
--
-- The cap is 3. Chosen, not measured: enough that a person who photographs the wrong thing twice
-- is not punished, few enough that a loop of blank photos spends the trial's own scans within a
-- minute. The model call itself is still recorded in llm_calls, so the per-network 20 a day and
-- the global daily budget keep counting it even when the device's own counter is refunded.
--
-- The signed-in daily analysis limit is deliberately NOT refunded: see the note in the PR.
--
-- Rollback: supabase/rollback/20261120150000_no_food_result.sql

-- ---------------------------------------------------------------------------
-- 1. Where the refunds are counted, per row.
-- ---------------------------------------------------------------------------
alter table public.trial_users
  add column no_food_refunds integer not null default 0;

alter table public.trial_devices
  add column no_food_refunds integer not null default 0;

-- ---------------------------------------------------------------------------
-- 2. The refund.
--
-- One statement does the whole thing: the guard (there is a scan to give back, and this row
-- has refunds left) and the decrement are in the same UPDATE, so two refunds racing cannot
-- both push scans_used below zero or slip past the cap.
--
-- 'refunded' false is not an error: the cap being reached is a normal answer, and the page
-- still needs scans_left so its count stays right.
-- ---------------------------------------------------------------------------
create function public.trial_scan_refund(
  p_server_secret text,
  p_email text default null,
  p_device_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_scans_limit integer;
  v_scans_used integer;
  v_scans_left integer;
begin
  perform public.trial_check_secret(p_server_secret);

  -- Exactly one target. Both or neither is a bug in the caller, not a refusal to explain.
  if (p_email is null) = (p_device_id is null) then
    return jsonb_build_object('status', 'invalid');
  end if;

  select s.scans_limit into v_scans_limit
    from public.trial_settings s where s.id = true;
  if v_scans_limit is null then
    raise exception 'trial settings not seeded' using errcode = '55000';
  end if;

  if p_device_id is not null then
    update public.trial_devices d
       set scans_used = d.scans_used - 1,
           no_food_refunds = d.no_food_refunds + 1
     where d.id = p_device_id
       and d.scans_used > 0
       and d.no_food_refunds < 3
    returning d.scans_used into v_scans_used;
  else
    update public.trial_users t
       set scans_used = t.scans_used - 1,
           no_food_refunds = t.no_food_refunds + 1
     where t.email = public.email_canonical(lower(trim(p_email)))
       and t.scans_used > 0
       and t.no_food_refunds < 3
    returning t.scans_used into v_scans_used;
  end if;

  if found then
    return jsonb_build_object(
      'status', 'ok', 'refunded', true, 'scans_left', v_scans_limit - v_scans_used
    );
  end if;

  -- Nothing given back: read what is left rather than guessing, so the page's number is the
  -- database's number even on the refusal.
  if p_device_id is not null then
    select v_scans_limit - d.scans_used into v_scans_left
      from public.trial_devices d where d.id = p_device_id;
  else
    select v_scans_limit - t.scans_used into v_scans_left
      from public.trial_users t
     where t.email = public.email_canonical(lower(trim(p_email)));
  end if;

  return jsonb_build_object(
    'status', 'ok', 'refunded', false, 'scans_left', coalesce(v_scans_left, v_scans_limit)
  );
end $$;

revoke execute on function public.trial_scan_refund(text, text, uuid) from public;
grant execute on function public.trial_scan_refund(text, text, uuid) to anon;

-- ---------------------------------------------------------------------------
-- 3. The funnel learns the new step.
--
-- A no-food result is neither a success nor a failure: the model answered, and the answer was
-- 'nothing here'. Counting it as analysis_ok would make the chain read as though the app found a
-- meal, and as analysis_error would blame the model for being right.
-- ---------------------------------------------------------------------------
alter table public.trial_funnel_daily
  drop constraint trial_funnel_daily_event;

alter table public.trial_funnel_daily
  add constraint trial_funnel_daily_event check (event in (
    'try_page_view',
    'analyse_tapped',
    'turnstile_failed',
    'token_issued',
    'analysis_ok',
    'analysis_no_food',
    'analysis_error',
    'limit_reached',
    'request_invite_submitted'
  ));

create or replace function public.trial_funnel_log(
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
    'analysis_ok', 'analysis_no_food', 'analysis_error', 'limit_reached',
    'request_invite_submitted'
  ) then
    raise exception 'unknown funnel event' using errcode = '22023';
  end if;

  v_cap := case when v_event in ('try_page_view', 'analyse_tapped') then 20 else null end;

  if public.trial_funnel_bump(v_event, public.trial_ip_hash(p_ip), v_cap) then
    return jsonb_build_object('status', 'ok');
  end if;
  return jsonb_build_object('status', 'capped');
end $$;

-- The admin read lists every event so a quiet one answers 0 instead of vanishing.
create or replace function public.admin_trial_funnel(p_days integer default 7)
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
                ('analysis_ok'), ('analysis_no_food'), ('analysis_error'), ('limit_reached'),
                ('request_invite_submitted')
             ) as e(event)
        left join public.trial_funnel_daily f on f.day = current_date and f.event = e.event
    ),
    'window', (
      select coalesce(jsonb_object_agg(e.event, coalesce(f.count, 0)), '{}'::jsonb)
        from (values
                ('try_page_view'), ('analyse_tapped'), ('turnstile_failed'), ('token_issued'),
                ('analysis_ok'), ('analysis_no_food'), ('analysis_error'), ('limit_reached'),
                ('request_invite_submitted')
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
