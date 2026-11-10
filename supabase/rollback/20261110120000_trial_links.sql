-- Rollback for 20261110120000_trial_links.sql
--
-- Drops the link functions, puts trial_scan_start back to its three-argument form from
-- 20261109170000 (body and grants copied from that file), and drops the two columns.
-- Tokens issued with a version keep verifying afterwards: the service ignores a version
-- the database no longer checks.

drop function if exists public.admin_trial_links(text[]);
drop function if exists public.admin_trial_link_revoke(text);
drop function if exists public.admin_trial_link_mark_sent(text);
drop function if exists public.admin_trial_link_issue(text, text);
drop function if exists public.trial_link_status(text, text, integer);
drop function if exists public.trial_scan_start(text, text, text, integer);

create function public.trial_scan_start(
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

alter table public.trial_users drop column if exists link_sent_at;
alter table public.trial_users drop column if exists token_version;
