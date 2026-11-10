-- Rollback for 20261109170000_trial_tables.sql
--
-- Drops the trial functions, tables and settings, deletes the trial rows, and undoes
-- the llm_calls and invite_requests column changes.
--
-- Order matters twice:
--   - drop the functions first (they reference the tables), then the tables.
--   - delete the trial rows (user_id is null, trial = true) *before* restoring
--     user_id NOT NULL, because those rows are exactly what would fail the constraint.

drop function if exists public.admin_spend();
drop function if exists public.admin_trial_stats();
drop function if exists public.trial_log_call(text, uuid, text, integer, integer, integer, text);
drop function if exists public.trial_scan_start(text, text, text);
drop function if exists public.trial_verify_code(text, text, text);
drop function if exists public.trial_send_code(text, text, text, text);
drop function if exists public.trial_check_secret(text);
drop function if exists public.trial_server_secret();
drop function if exists public.trial_ip_hash(text);

drop table if exists public.trial_settings;
drop table if exists public.trial_codes;
drop table if exists public.trial_users;

-- The admin_spend function is re-created to its pre-trial shape, so a rollback leaves
-- the admin page reading the same function it had before this migration.
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
  last_call_at timestamptz
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
      s.last_call_at
    from users us
    left join spend s on s.user_id = us.id
    order by coalesce(s.calls_total, 0) desc, us.email;
end $$;

revoke execute on function public.admin_spend() from public, anon;
grant execute on function public.admin_spend() to authenticated;

-- Delete the trial rows before restoring NOT NULL. Trial rows always have a null
-- user_id, so this is every row the trial wrote, and the constraint cannot be restored
-- while any of them remain. Deleting first also means the two column drops below start
-- from a table whose only remaining rows are authenticated ones.
delete from public.llm_calls where trial = true and user_id is null;

alter table public.llm_calls drop column if exists trial;
alter table public.llm_calls drop column if exists ip_hash;
alter table public.llm_calls alter column user_id set not null;

-- Undo the request_invite change: drop the five-argument overload and re-create the
-- original four-argument one, then drop the column it set.
drop function if exists public.request_invite(text, text, boolean, text, boolean);

create or replace function public.request_invite(
  p_email text,
  p_first_name text default null,
  p_auto boolean default false,
  p_honeypot text default null
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
           first_name = coalesce(v_name, first_name)
     where email = v_email
       and status = 'revoked';
    return 'requested';
  end if;

  insert into public.invite_requests (email, first_name, requested_by, status, request_ip_hash)
  values (v_email, v_name, auth.uid(), 'pending', v_ip_hash)
  on conflict (email) do nothing;

  if exists (
    select 1 from public.invite_requests r
     where public.email_canonical(r.email) = public.email_canonical(v_email)
  ) then
    return 'requested';
  end if;
  return 'rate_limited';
end $$;

revoke execute on function public.request_invite(text, text, boolean, text) from public;
grant execute on function public.request_invite(text, text, boolean, text) to anon, authenticated;

alter table public.invite_requests drop column if exists from_trial;
