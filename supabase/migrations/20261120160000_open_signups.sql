-- --------------------------------------------------------------------------- --
-- Open sign-ups, as a switch rather than a rewrite.
--
-- The invite wall was never a trigger on auth.users: it was `auth_entry_state` answering
-- `not_invited` for an address that is not on `allowed_emails`, and the sign-in screen drawing
-- the request panel for that answer. So the switch is a row, and the function reads it. When it
-- is on, an address with no account is told `open_signup` instead of `not_invited`, which is the
-- whole difference between the two products.
--
-- The setting is a table rather than an environment variable because `auth_entry_state` runs
-- inside Postgres: the browser flag and the database answer have to agree, and one of them
-- living in a build and the other in a row is how they would drift. `public.open_signups()` is
-- the browser's copy, a security definer read so `anon` needs no grant on the table.
-- --------------------------------------------------------------------------- --

create table public.app_settings (
  -- One row, enforced by the primary key being a constant. A settings table that can hold two
  -- rows is a settings table with an ordering bug waiting in it.
  id boolean primary key default true check (id),
  open_signups boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (id, open_signups) values (true, true);

alter table public.app_settings enable row level security;

create policy app_settings_admin_read on public.app_settings
  for select to authenticated using (public.is_admin());

create policy app_settings_admin_write on public.app_settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.app_settings from anon, authenticated;
grant all on public.app_settings to service_role;

/** The switch, for the browser and for `auth_entry_state`. */
create or replace function public.open_signups()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select s.open_signups from public.app_settings s where s.id), false);
$$;

revoke execute on function public.open_signups() from public;
grant execute on function public.open_signups() to anon, authenticated;

-- --------------------------------------------------------------------------- --
-- The one function that decides what the sign-in screen offers.
--
-- The same body as 20261107120000, with one branch added: when sign-ups are open and the address
-- has no account, the answer is `open_signup` rather than `not_invited`. The throttle, the
-- canonical matching and the `google_only` answer are unchanged, and an invited address that has
-- no account still answers `invited_new`, because that account is coming either way.
-- --------------------------------------------------------------------------- --
create or replace function public.auth_entry_state(p_email text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_canonical text;
  v_hash text;
  v_ip_hash text;
  v_same integer;
  v_same_ip integer;
  v_all integer;
  v_user_id uuid;
  v_invited boolean;
begin
  if length(v_email) = 0
     or length(v_email) > 254
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return 'not_invited';
  end if;

  v_canonical := public.email_canonical(v_email);
  v_hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');
  v_ip_hash := public.ip_hash(public.request_ip());

  delete from public.auth_entry_state_throttle where checked_at < now() - interval '1 hour';

  select count(*) into v_same
    from public.auth_entry_state_throttle t
   where t.email_hash = v_hash
     and t.checked_at > now() - interval '10 minutes';
  select count(*) into v_same_ip
    from public.auth_entry_state_throttle t
   where t.ip_hash = v_ip_hash
     and t.checked_at > now() - interval '10 minutes';
  select count(*) into v_all
    from public.auth_entry_state_throttle t
   where t.checked_at > now() - interval '10 minutes';

  if v_same >= 10 or (v_ip_hash is not null and v_same_ip >= 30) or v_all >= 500 then
    return 'busy';
  end if;

  insert into public.auth_entry_state_throttle (email_hash, ip_hash) values (v_hash, v_ip_hash);

  v_invited := exists (
    select 1 from public.allowed_emails a
     where public.email_canonical(a.email) = v_canonical
  );

  select u.id into v_user_id
    from auth.users u
   where public.email_canonical(u.email) = v_canonical
   limit 1;

  if v_user_id is null then
    if v_invited then
      return 'invited_new';
    end if;
    if public.open_signups() then
      return 'open_signup';
    end if;
    return 'not_invited';
  end if;

  if exists (select 1 from auth.identities i where i.user_id = v_user_id and i.provider = 'google')
     and not exists (
       select 1 from auth.identities i where i.user_id = v_user_id and i.provider = 'email'
     ) then
    return 'google_only';
  end if;

  return 'has_account';
end $$;

revoke execute on function public.auth_entry_state(text) from public;
grant execute on function public.auth_entry_state(text) to anon, authenticated;

-- --------------------------------------------------------------------------- --
-- Who signed up, for the admin page.
--
-- Counts rows in auth.users, which only a security definer function may read. The day is
-- `current_date` in the database's zone, the same basis `daily_summaries` uses, so this card
-- agrees with the numbers beside it.
-- --------------------------------------------------------------------------- --
create or replace function public.admin_signup_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'today', (select count(*) from auth.users u where u.created_at::date = current_date),
    'week',  (select count(*) from auth.users u where u.created_at >= now() - interval '7 days'),
    'total', (select count(*) from auth.users u)
  );
end $$;

revoke execute on function public.admin_signup_counts() from public, anon;
grant execute on function public.admin_signup_counts() to authenticated;

-- --------------------------------------------------------------------------- --
-- Two more funnel steps: the sign-up screen appeared, and an account was created.
--
-- The event name is written down twice, in the table's constraint and in the writer's allowlist,
-- and both are extended here. Same twenty-a-day per network cap as the other browser-reported
-- steps, because these are reported by a page as well.
-- --------------------------------------------------------------------------- --
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
    'request_invite_submitted',
    'signup_started',
    'signup_completed'
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
    'request_invite_submitted', 'signup_started', 'signup_completed'
  ) then
    raise exception 'unknown funnel event' using errcode = '22023';
  end if;

  v_cap := case
    when v_event in ('try_page_view', 'analyse_tapped', 'signup_started', 'signup_completed') then 20
    else null
  end;

  if public.trial_funnel_bump(v_event, public.trial_ip_hash(p_ip), v_cap) then
    return jsonb_build_object('status', 'ok');
  end if;
  return jsonb_build_object('status', 'capped');
end $$;

revoke execute on function public.trial_funnel_log(text, text, text) from public;
grant execute on function public.trial_funnel_log(text, text, text) to anon;

create or replace function public.admin_trial_funnel(p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
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
                ('request_invite_submitted'), ('signup_started'), ('signup_completed')
             ) as e(event)
        left join public.trial_funnel_daily f on f.day = current_date and f.event = e.event
    ),
    'window', (
      select coalesce(jsonb_object_agg(e.event, coalesce(f.count, 0)), '{}'::jsonb)
        from (values
                ('try_page_view'), ('analyse_tapped'), ('turnstile_failed'), ('token_issued'),
                ('analysis_ok'), ('analysis_no_food'), ('analysis_error'), ('limit_reached'),
                ('request_invite_submitted'), ('signup_started'), ('signup_completed')
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
