-- Rollback of 20261120150000_no_food_result.sql.
--
-- Puts the eight-event allowlist back, restores the funnel reader the previous migration
-- defined, drops the refund and the per-row refund counters. The columns go last: the refund
-- function reads them.

-- The rows go before the constraint: a narrowed check cannot be added while a row still names
-- the event it would refuse.
delete from public.trial_funnel_daily where event = 'analysis_no_food';
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

alter table public.trial_funnel_daily
  drop constraint trial_funnel_daily_event;

alter table public.trial_funnel_daily
  add constraint trial_funnel_daily_event check (event in (
    'try_page_view',
    'analyse_tapped',
    'turnstile_failed',
    'token_issued',
    'analysis_ok',
    'analysis_error',
    'limit_reached',
    'request_invite_submitted'
  ));

drop function if exists public.trial_scan_refund(text, text, uuid);

alter table public.trial_devices drop column if exists no_food_refunds;
alter table public.trial_users drop column if exists no_food_refunds;
