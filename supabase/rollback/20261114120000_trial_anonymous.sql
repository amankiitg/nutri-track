-- Rollback for 20261114120000_trial_anonymous.sql.
--
-- Restores the two admin functions to the definitions 20261109170000 and
-- 20261112120000 left, then removes the anonymous table and its functions. Order
-- matters: the restored functions must not name trial_devices when the table goes.
--
-- Rollback: this file.

-- admin_trial_stats, before anonymous devices were counted.
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

-- admin_trial_list, before anonymous rows.
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

drop function if exists public.trial_anon_scan_start(text, uuid, text, integer);
drop function if exists public.trial_anon_start(text, text, uuid);
drop table if exists public.trial_devices;
