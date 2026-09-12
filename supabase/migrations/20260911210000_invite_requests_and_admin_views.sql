-- The admin page: invite management, spend, and the invite requests that make the
-- "Not on the list yet" screen useful.
--
-- `allowed_emails`, `admins`, `is_admin()`, `check_email_allowed()`, the admin policies
-- and the first-admin bootstrap trigger all already exist (20260910234510,
-- 20260911130000, 20260911130100). This migration adds only what was missing: the
-- requests table, the joins the page needs, and the spend view.

-- ---------------------------------------------------------------------------
-- One normalisation rule, enforced by the database rather than remembered by each
-- caller.
--
-- 20260911130100 established `lower(trim(email))` as the matching rule and put a unique
-- index on it, but nothing stopped a writer inserting `" Aman@Example.com "`: the index
-- would see it as distinct from `aman@example.com`, and `check_email_allowed()` would
-- then never match it. An address that is on the list and cannot be found is worse than
-- one that was never added, because it looks like a working invite.
--
-- So the rule is applied on the way in, for every writer, present and future — the admin
-- UI, a repair script, someone in the SQL editor. The CHECK is kept as well: it is the
-- statement of the invariant, and it is what still holds if this trigger is ever dropped.
-- ---------------------------------------------------------------------------
create or replace function public.normalize_allowed_email()
returns trigger language plpgsql set search_path = public as $$
begin
  new.email := lower(trim(new.email));
  return new;
end $$;

drop trigger if exists allowed_emails_normalize on public.allowed_emails;
create trigger allowed_emails_normalize before insert or update on public.allowed_emails
  for each row execute function public.normalize_allowed_email();

alter table public.allowed_emails
  drop constraint if exists allowed_emails_normalized;
alter table public.allowed_emails
  add constraint allowed_emails_normalized check (email = lower(trim(email)));

-- ---------------------------------------------------------------------------
-- The one thing an uninvited person can write.
--
-- Someone who signs in with Google and is not on the list holds a valid JWT but has no
-- `profiles` row — that is the whole situation. So the row is keyed on the address from
-- that JWT, which is signed by Supabase and therefore not forgeable, and `requested_by`
-- records `auth.uid()` so the "policy is user_id = auth.uid()" rule still holds.
--
-- The columns for emailing are here from the start (`notified_at`, `notify_attempts`) so
-- that adding a notification later is code and not a migration.
-- ---------------------------------------------------------------------------
create table public.invite_requests (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  requested_by uuid not null default auth.uid(),
  requested_at timestamptz not null default now(),
  status text not null default 'pending',
  handled_at timestamptz,
  handled_by uuid,
  notified_at timestamptz,
  notify_attempts integer not null default 0,
  constraint invite_requests_status
    check (status in ('pending', 'approved', 'declined')),
  -- Belt and braces with the trigger below: the table cannot hold an address that the
  -- lookup would fail to match.
  constraint invite_requests_email_normalized check (email = lower(trim(email)))
);

-- One row per address, ever. This is the primary defence, and it is stronger than a rate
-- limit: an uninvited person may write exactly one row, about themselves, and then never
-- write again. There is nothing to fill the database with.
create unique index invite_requests_email_uniq on public.invite_requests (email);
create index invite_requests_status_idx on public.invite_requests (status, requested_at desc);

alter table public.invite_requests enable row level security;

-- `security definer` because the caller cannot read this table — the guard has to count
-- rows the caller is not allowed to see, so an invoker-rights count would always be 0 and
-- the limit would silently never fire. That is the trap in this particular trigger.
create or replace function public.invite_requests_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  recent integer;
  already_asked boolean;
begin
  new.email := lower(trim(new.email));

  -- Already asked. Skipped rather than raised so the caller can insert unconditionally
  -- and getting in touch twice is not an error for them to see. The unique index is the
  -- backstop if this ever stops working.
  select exists (select 1 from public.invite_requests r where r.email = new.email)
    into already_asked;
  if already_asked then
    return null;
  end if;

  -- A burst guard, not a per-person limit: the per-person limit is the unique index.
  -- This bounds what a script with many Google accounts can do in an hour, and it bounds
  -- how fast this table can grow even if that happens. Generous enough that it only trips
  -- on abuse; a request lost to it can be repeated later.
  select count(*) into recent
    from public.invite_requests r
   where r.requested_at > now() - interval '1 hour';
  if recent >= 25 then
    return null;
  end if;

  return new;
end $$;

revoke execute on function public.invite_requests_guard() from public, anon, authenticated;

create trigger invite_requests_guard before insert on public.invite_requests
  for each row execute function public.invite_requests_guard();

grant select, insert, update on public.invite_requests to authenticated;
grant all on public.invite_requests to service_role;

-- The caller's own address, from their signed JWT. This is what makes the table safe:
-- a request can only ever be about the person making it.
create policy "invite_requests_insert_self" on public.invite_requests for insert to authenticated
  with check (
    requested_by = auth.uid()
    and coalesce(auth.jwt() ->> 'email', '') <> ''
    and email = lower(trim(auth.jwt() ->> 'email'))
  );

-- So the "Not on the list yet" screen can say the request has been received.
create policy "invite_requests_select_own" on public.invite_requests for select to authenticated
  using (email = lower(trim(coalesce(auth.jwt() ->> 'email', ''))));

create policy "invite_requests_admin_select" on public.invite_requests for select to authenticated
  using (public.is_admin());

-- Approving is the only update that matters, and only an admin may do it. There is
-- deliberately no delete policy for anyone: a request that was declined is a record.
create policy "invite_requests_admin_update" on public.invite_requests for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- The day boundary, stated once.
--
-- `llm_call_budget()` (20260911200000) had this arithmetic inline. The spend panel needs
-- the same rule per user, and two copies of "a day starts at midnight in the profile's
-- zone" would eventually disagree. So it moves here and both call it.
-- ---------------------------------------------------------------------------
create or replace function public.local_day_start(p_at timestamptz, p_tz text)
returns timestamptz language sql stable set search_path = public as $$
  select (((p_at at time zone coalesce(p_tz, 'UTC'))::date)::timestamp)
           at time zone coalesce(p_tz, 'UTC')
$$;

/** The same, `p_days` local days later — DST-safe, which `+ interval '1 day'` is not. */
create or replace function public.local_day_start_offset(p_at timestamptz, p_tz text, p_days integer)
returns timestamptz language sql stable set search_path = public as $$
  select ((((p_at at time zone coalesce(p_tz, 'UTC'))::date) + p_days)::timestamp)
           at time zone coalesce(p_tz, 'UTC')
$$;

-- Re-created rather than edited in place: 20260911200000 is applied and never changed.
-- Same signature, same meaning, same result — now built on the shared helper.
create or replace function public.llm_call_budget()
returns table (used integer, resets_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  with zone as (
    select coalesce(
      (select p.timezone from public.profiles p where p.user_id = auth.uid()),
      'UTC'
    ) as tz
  )
  select
    (
      select count(*)::integer
        from public.llm_calls c
       where c.user_id = auth.uid()
         and c.created_at >= public.local_day_start(now(), (select tz from zone))
    ) as used,
    public.local_day_start_offset(now(), (select tz from zone), 1) as resets_at
  from zone;
$$;

-- ---------------------------------------------------------------------------
-- What the admin page reads.
--
-- Both are `security definer` because both need `auth.users`, which `authenticated`
-- cannot read. That makes the guard inside them load-bearing rather than decorative:
-- a definer function runs as the owner and RLS does not apply to it, so the admin check
-- is the only thing standing between a signed-in stranger and every user's email address.
-- ---------------------------------------------------------------------------

/** The invite list, joined to the accounts that have actually arrived. */
create or replace function public.admin_invites()
returns table (
  email text,
  added_by text,
  created_at timestamptz,
  signed_up_at timestamptz,
  user_id uuid,
  is_admin boolean
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
    select
      a.email,
      coalesce(nullif(trim(ad.display_name), ''), null) as added_by,
      a.created_at,
      u.created_at as signed_up_at,
      u.id as user_id,
      (m.user_id is not null) as is_admin
    from public.allowed_emails a
    left join auth.users u on lower(trim(u.email)) = a.email
    left join public.profiles ad on ad.user_id = a.added_by
    left join public.admins m on m.user_id = u.id
    order by (u.id is not null), a.email;
end $$;

/**
 * Per-user model spend.
 *
 * `calls_today` and `resets_at` are the same rule `llm_call_budget()` enforces, read per
 * user rather than per caller. Tokens are shown and no price is applied: a price in here
 * would be a currency and a vendor's rate card baked into a migration, wrong the first
 * time either changes.
 */
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

/**
 * Approve a request: put the address on the list and mark it handled, in one transaction.
 *
 * `security invoker`, so RLS authorises both writes as the admin rather than the function
 * stepping around it. The admin check is repeated here so a mistake elsewhere cannot turn
 * this into a privilege escalation; the policies would refuse anyway.
 */
create or replace function public.admin_approve_request(p_request uuid)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_email text;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  select lower(trim(r.email)) into v_email
    from public.invite_requests r
   where r.id = p_request;

  if v_email is null then
    raise exception 'no such invite request' using errcode = 'P0002';
  end if;

  insert into public.allowed_emails (email, added_by)
  values (v_email, auth.uid())
  on conflict (email) do nothing;

  update public.invite_requests
     set status = 'approved',
         handled_at = now(),
         handled_by = auth.uid()
   where id = p_request;

  return v_email;
end $$;

revoke execute on function public.admin_invites() from public, anon;
revoke execute on function public.admin_spend() from public, anon;
revoke execute on function public.admin_approve_request(uuid) from public, anon;
grant execute on function public.admin_invites() to authenticated;
grant execute on function public.admin_spend() to authenticated;
grant execute on function public.admin_approve_request(uuid) to authenticated;
grant execute on function public.local_day_start(timestamptz, text) to authenticated;
grant execute on function public.local_day_start_offset(timestamptz, text, integer) to authenticated;
