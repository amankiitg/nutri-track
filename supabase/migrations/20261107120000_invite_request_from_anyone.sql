-- Invites: asking for one without an account, deciding which form an address deserves, and keeping a
-- request honest when its invite goes away.
--
-- Until now the only row an uninvited person could cause came from the Google path, where a signed
-- JWT supplies the address (`invite_requests_insert_self`). The email form had no session, so it
-- offered a mailto and recorded nothing: the request lived in somebody's inbox instead of in the
-- list the admin page reads.
--
-- Two functions fix that, and neither is a table grant in disguise:
--
--   request_invite      records the ask, and answers with a word rather than an error
--   auth_entry_state    decides which form an address deserves before it gets that far
--
-- Both are `security definer` with a pinned `search_path`, both answer with a value instead of
-- raising, so a stranger cannot tell a refusal from a rate limit by the shape of the failure, and
-- both are rate limited because a public, unauthenticated write is the only thing here that an
-- attacker with a loop could use.
--
-- Rollback: supabase/rollback/20261107120000_invite_request_from_anyone.sql

-- ---------------------------------------------------------------------------
-- 1. The columns the functions need.
--
-- `requested_by` was `not null default auth.uid()`, which is right for the Google path (the person
-- is signed in) and impossible for the email one. Null now records *how* the request arrived.
--
-- `first_name` is nullable and stays empty when nobody gave one: the approval email greets with
-- "Hi there," rather than an empty space. Fifty characters is plenty for a first name and short
-- enough that the column cannot be used as a message field.
-- ---------------------------------------------------------------------------
alter table public.invite_requests alter column requested_by drop not null;

alter table public.invite_requests add column first_name text;
alter table public.invite_requests
  drop constraint if exists invite_requests_first_name_length;
alter table public.invite_requests
  add constraint invite_requests_first_name_length
  check (first_name is null or length(first_name) <= 50);

-- The column the per-address write limit counts. Null for a signed-in request, and null when the
-- caller's address could not be read: neither is a bucket, and neither is counted.
alter table public.invite_requests add column request_ip_hash text;

-- ---------------------------------------------------------------------------
-- 2. A fourth status.
--
-- Removing an address from `allowed_emails` used to leave its request saying "approved", which is
-- no longer true: that person cannot sign in. 'revoked' is the record of an invite that was taken
-- away, as opposed to one that was never granted ('declined').
-- ---------------------------------------------------------------------------
alter table public.invite_requests drop constraint if exists invite_requests_status;
alter table public.invite_requests
  add constraint invite_requests_status
  check (status in ('pending', 'approved', 'declined', 'revoked'));

-- ---------------------------------------------------------------------------
-- 3. One address, one identity.
--
-- Gmail treats `amank.iitg+nt@gmail.com` and `amankiitg@gmail.com` as the same mailbox, and so does
-- Google sign-in. An invite list that does not would let the same person request twice, be invited
-- twice, and be refused at the door under one spelling while the list holds the other. So the
-- comparison everywhere is against a canonical form.
--
-- The *stored* address is never rewritten: the invite names the mailbox the person typed, and the
-- approval email has to be addressed to something they will recognise. Only comparisons are
-- canonical. `googlemail.com` is the same inbox as `gmail.com` and is folded in for the same reason.
--
-- Other domains get lowercase and trim only. A dot in somebody's local part is their business.
-- ---------------------------------------------------------------------------
create or replace function public.email_canonical(p_email text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
           when v.domain in ('gmail.com', 'googlemail.com')
             then replace(split_part(v.local, '+', 1), '.', '') || '@gmail.com'
           else v.full
         end
  from (
    select lower(trim(coalesce(p_email, ''))) as full,
           split_part(lower(trim(coalesce(p_email, ''))), '@', 1) as local,
           split_part(lower(trim(coalesce(p_email, ''))), '@', 2) as domain
  ) v
$$;

revoke execute on function public.email_canonical(text) from public;
grant execute on function public.email_canonical(text) to anon, authenticated;

-- The two checks the app already had, re-stated against the canonical form. These are what the
-- sign-in gate and the sign-in screen read, so this is the difference between a Gmail invite working
-- under either spelling and only working under one.
create or replace function public.is_email_allowed()
returns boolean language sql stable security definer set search_path = public as $$
  select (not exists (select 1 from public.allowed_emails))
      or exists (
        select 1 from public.allowed_emails a
        where public.email_canonical(a.email)
            = public.email_canonical(coalesce(auth.jwt() ->> 'email', ''))
      )
$$;

create or replace function public.check_email_allowed(_email text)
returns boolean language sql stable security definer set search_path = public as $$
  select (not exists (select 1 from public.allowed_emails))
      or exists (
        select 1 from public.allowed_emails a
        where public.email_canonical(a.email) = public.email_canonical(_email)
      )
$$;

-- ---------------------------------------------------------------------------
-- 4. The caller's address, for the per-IP limits below.
--
-- PostgREST puts the request headers in `request.headers` for the duration of the call, so this is
-- the only place a database function can see who is asking. `cf-connecting-ip` first because the
-- app is served from Cloudflare, then the first hop of `x-forwarded-for`.
--
-- **An unknown address returns null, not a bucket.** Putting every caller whose address could not be
-- read into one shared bucket would turn a 3-per-hour per-address limit into a 3-per-hour cap for
-- the whole site, which is a far worse failure than not applying the limit. The global burst limits
-- in the two functions still apply when this is null.
-- ---------------------------------------------------------------------------
create or replace function public.request_ip()
returns text
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_headers json;
  v_ip text;
begin
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::json;
  exception
    when others then
      -- A context without request headers (the SQL editor, a test) is not an error.
      v_headers := null;
  end;

  if v_headers is null then
    return null;
  end if;

  v_ip := nullif(trim(coalesce(v_headers ->> 'cf-connecting-ip', '')), '');
  if v_ip is null then
    v_ip := nullif(trim(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1)), '');
  end if;

  return v_ip;
end $$;

revoke execute on function public.request_ip() from public, anon, authenticated;

-- The address is hashed rather than stored: the limit asks "how many from here", which does not
-- require keeping where "here" was.
create or replace function public.ip_hash(p_ip text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
           when p_ip is null or p_ip = '' then null
           else encode(sha256(convert_to(p_ip, 'UTF8')), 'hex')
         end
$$;

revoke execute on function public.ip_hash(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The insert guard, re-created to agree with `request_invite`.
--
-- Unchanged in what it enforces: one row per address, a normalised address, and a burst bound. What
-- is new is the name, and one rule worth stating because it is easy to get wrong later: **a repeat
-- insert never moves a decided request.** A declined request stays declined and a revoked one stays
-- revoked, because this trigger returning null skips the insert entirely. Only `request_invite` below
-- can put a request back in the queue, and only when it is told the person asked explicitly.
--
-- The duplicate check is canonical, so the same Gmail mailbox cannot ask twice under two spellings.
--
-- `security definer` because `auth.users` is not readable by the caller and the burst count reads
-- rows the caller may not see; an invoker-rights count would always be 0 and the limit would
-- silently never fire.
-- ---------------------------------------------------------------------------
create or replace function public.invite_requests_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  recent integer;
  google_name text;
begin
  new.email := lower(trim(new.email));
  new.first_name := nullif(left(trim(coalesce(new.first_name, '')), 50), '');

  -- From the Google profile, when this row is about the caller and nobody typed a name. `given_name`
  -- is the field Google fills in for a first name; `full_name` and `name` are the fallbacks, and the
  -- first word of either is the best this can do. `split_part` rather than a regex: an empty name
  -- gives an empty string, which the `nullif` turns back into null.
  if new.first_name is null and auth.uid() is not null then
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
      into google_name
      from auth.users u
     where u.id = auth.uid();
    new.first_name := nullif(left(coalesce(google_name, ''), 50), '');
  end if;

  -- Already asked, in any status. Skipped rather than raised, so the caller can insert
  -- unconditionally and getting in touch twice is not an error for them to see. The unique index is
  -- the backstop if this ever stops working.
  if exists (
    select 1 from public.invite_requests r
     where public.email_canonical(r.email) = public.email_canonical(new.email)
  ) then
    return null;
  end if;

  -- A burst guard, not a per-person limit: the per-person limit is the unique index. This bounds
  -- what a script with many Google accounts can do in an hour. Generous enough that it only trips on
  -- abuse; a request lost to it can be repeated later.
  select count(*) into recent
    from public.invite_requests r
   where r.requested_at > now() - interval '1 hour';
  if recent >= 25 then
    return null;
  end if;

  return new;
end $$;

revoke execute on function public.invite_requests_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Asking for an invite, from a screen where nobody is signed in.
--
-- Five answers, and each one is a different sentence on the screen:
--
--   requested        the request is recorded (or was already waiting, or was put back in the queue)
--   already_pending  a request from this address is already waiting
--   already_invited  the address is on the list, so there is nothing to ask for
--   invalid          not an address this function will store
--   rate_limited     nothing was written, and the screen offers the mailbox instead
--
-- `p_auto` is the difference between the two callers. The sign-in gate calls this automatically for
-- somebody who just signed in with Google and is not on the list; a screen that did that must never
-- undo a decision the admin made, so with `p_auto` a revoked or declined request is left exactly as
-- it is. The request page is somebody typing their address and pressing a button, and that is an
-- explicit ask: a revoked invitation goes back in the queue. Declined stays declined either way.
--
-- Both of those answer 'requested', which is deliberate: "you were declined" is a sentence that
-- invites an argument with a mailbox that cannot answer one, and the decision is already recorded
-- where the admin can see it.
--
-- One row per address, ever, is still the invariant - now compared canonically, so the same Gmail
-- mailbox cannot have two.
-- ---------------------------------------------------------------------------
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
  -- A hidden field no person can fill in. A bot that submits every input it finds gets the success
  -- sentence and no row, which is the only answer that tells it nothing.
  if coalesce(trim(p_honeypot), '') <> '' then
    return 'requested';
  end if;

  -- A signed-in caller speaks only for themselves. The address comes from their signed JWT, not
  -- from the body, so this call cannot be used to put somebody else's address in the queue.
  if auth.uid() is not null then
    v_email := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
    -- The name, when the form did not collect one. Same fields as the insert guard: `given_name`
    -- first, then the first word of the full name.
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

  -- The same shape the browser checks and the table's own constraint states: anything refused here
  -- could not have been stored anyway.
  if length(v_email) = 0
     or length(v_email) > 254
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return 'invalid';
  end if;

  -- Already on the list, under any spelling of the same mailbox. Nothing to ask for.
  if exists (
    select 1 from public.allowed_emails a
     where public.email_canonical(a.email) = public.email_canonical(v_email)
  ) then
    return 'already_invited';
  end if;

  -- The existing request, if there is one. One row per address, so "latest" is "the".
  select r.status into v_status
    from public.invite_requests r
   where public.email_canonical(r.email) = public.email_canonical(v_email)
   limit 1;

  if v_status = 'pending' then
    -- Already waiting. The one thing worth writing: a name this attempt has and the row does not.
    -- What somebody typed last time is not overwritten by a guess from this time.
    if v_name is not null then
      update public.invite_requests
         set first_name = v_name
       where email = v_email
         and first_name is null;
    end if;
    return 'already_pending';
  end if;

  if v_status = 'declined' then
    -- Declined stays declined, and nothing is written.
    return 'requested';
  end if;

  if v_status = 'revoked' and p_auto then
    -- The sign-in gate asking on somebody's behalf must not undo a removal. No write.
    return 'requested';
  end if;

  -- A burst guard over anonymous writes, in the same shape as the guard above: a global ceiling,
  -- not a per-person one. Counted here rather than at the top because the branches above write
  -- nothing, and a request that changes nothing is not what this limit is protecting.
  --
  -- Two limits, because they stop different things. The global one bounds how fast the table can
  -- grow when many addresses ask at once. The per-address one bounds one machine making accounts:
  -- twenty anonymous requests in ten minutes is already more than a person asking on behalf of
  -- friends. Both are skipped for a signed-in caller, whose requests are already bounded by having a
  -- verified session.
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
    -- Back to the queue: this is the same person asking again, in their own words this time. The
    -- invitation was taken away; that is not the same as being refused.
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

  -- Nothing on record: record it. `on conflict` is belt and braces with the guard above, which
  -- skips a repeat insert and returns null.
  insert into public.invite_requests (email, first_name, requested_by, status, request_ip_hash)
  values (v_email, v_name, auth.uid(), 'pending', v_ip_hash)
  on conflict (email) do nothing;

  -- A skipped insert must not come back as success. The only thing that skips it now is the burst
  -- guard in section 5, and that is a rate limit by another name.
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

-- ---------------------------------------------------------------------------
-- 7. One decision, recorded once.
--
-- Putting an address on the list is the decision the whole flow is about, and it can arrive from
-- three places: `admin_approve_request`, the service's invite form, and a hand-written insert in the
-- SQL editor. Every one of them should settle a request that was still waiting. Doing it in a
-- trigger is what makes that true of all three rather than of the one that was remembered.
--
-- 'pending' and 'declined' both become 'approved': a declined person who is then invited by hand has
-- been approved, whatever an earlier admin click said.
-- ---------------------------------------------------------------------------
create or replace function public.allowed_emails_approve_request()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.invite_requests
     set status = 'approved',
         handled_at = now()
   where public.email_canonical(email) = public.email_canonical(new.email)
     and status in ('pending', 'declined');
  return new;
end $$;

revoke execute on function public.allowed_emails_approve_request() from public, anon, authenticated;

drop trigger if exists allowed_emails_approve_request on public.allowed_emails;
create trigger allowed_emails_approve_request
  after insert on public.allowed_emails
  for each row execute function public.allowed_emails_approve_request();

-- ---------------------------------------------------------------------------
-- 8. The same rule in the other direction, in the database rather than in one client.
--
-- `security definer` because the delete can arrive from anywhere: the admin page, the service role,
-- the SQL editor. Those callers do not all have an update policy on `invite_requests`, and a
-- revocation that silently failed to record itself is worse than none. A trigger is also the only
-- place that covers every route to a deletion at once.
-- ---------------------------------------------------------------------------
create or replace function public.allowed_emails_revoke_request()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.invite_requests
     set status = 'revoked',
         handled_at = now()
   where public.email_canonical(email) = public.email_canonical(old.email)
     and status = 'approved';
  return old;
end $$;

revoke execute on function public.allowed_emails_revoke_request() from public, anon, authenticated;

drop trigger if exists allowed_emails_revoke_request on public.allowed_emails;
create trigger allowed_emails_revoke_request
  after delete on public.allowed_emails
  for each row execute function public.allowed_emails_revoke_request();

-- ---------------------------------------------------------------------------
-- 9. The backfill this write made necessary.
--
-- Any request still saying 'approved' whose address has since left `allowed_emails` is wrong now,
-- and was already wrong before this migration: the admin page has been showing the opposite of the
-- truth for every address removed by hand. One statement, run once, so the list is truthful from the
-- moment this deploys.
--
-- The count is raised as a notice rather than stored: the number is a report for the person running
-- the migration, not a fact the schema needs afterwards.
-- ---------------------------------------------------------------------------
do $$
declare
  v_changed integer;
begin
  update public.invite_requests r
     set status = 'revoked',
         handled_at = now()
   where r.status = 'approved'
     and not exists (
       select 1 from public.allowed_emails a
        where public.email_canonical(a.email) = public.email_canonical(r.email)
     );

  get diagnostics v_changed = row_count;
  raise notice 'invite_requests backfill: % approved request(s) marked revoked', v_changed;
end $$;

-- ---------------------------------------------------------------------------
-- 10. The counters the throttles read.
--
-- Unreachable through the Data API on purpose: no policies, and the grants this platform hands new
-- tables in `public` are taken back explicitly below, because a table whose only purpose is to be
-- counted by one `security definer` function should not also be a table anyone can write. An empty
-- grant list is easier to audit than a policy that happens to deny everything.
--
-- The address is not stored, only a sha256 of it: the table answers "how many times has this address
-- been looked up", which does not require keeping the address.
-- ---------------------------------------------------------------------------
create table public.auth_entry_state_throttle (
  id bigint generated always as identity primary key,
  email_hash text not null,
  ip_hash text,
  checked_at timestamptz not null default now()
);

create index auth_entry_state_throttle_email_idx
  on public.auth_entry_state_throttle (email_hash, checked_at desc);
create index auth_entry_state_throttle_ip_idx
  on public.auth_entry_state_throttle (ip_hash, checked_at desc);
create index auth_entry_state_throttle_time_idx
  on public.auth_entry_state_throttle (checked_at desc);

alter table public.auth_entry_state_throttle enable row level security;

-- Supabase's default privileges grant `all` on a new table in `public` to these two roles. Nothing on
-- this table is meant for either of them.
revoke all on public.auth_entry_state_throttle from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 11. Which form the email address deserves.
--
-- Five answers, and one rule: **account existence is only ever revealed for an address that is
-- invited.** An address that is not on the list gets 'not_invited' whether it has an account or not,
-- so this cannot be used to ask "does this person use NutriTrack". That is also why it is a function
-- rather than a view: the answer is the same for every stranger, and the caller cannot see which
-- branch produced it.
--
--   not_invited  ask for an invite, or write to the mailbox
--   invited_new  on the list, no account yet: email them a link to set it up
--   has_account  on the list with an account: sign in, or reset the password
--   google_only  on the list with an account that has never had a password: send them to Google
--   busy         the throttle refused to answer; try again in a minute
--
-- 'busy' is never folded into 'not_invited'. The invite panel tells somebody to ask for something
-- they may already have, which is a worse thing to say than "come back in a minute", and the two look
-- identical to a person while being opposites.
--
-- 'google_only' exists because a password box in front of an account that has never had a password is
-- a dead end: the sentence to say is "this one signs in with Google". An account that has a password
-- *and* Google is 'has_account', because either door works.
--
-- `auth.users` is readable only by `service_role`, which is why this needs `security definer`.
--
-- Three limits, and they answer different questions. Ten lookups per address per ten minutes stops
-- one address being hammered. Thirty per IP per ten minutes stops one machine walking a list of
-- addresses, which is the attack this function would otherwise permit. Five hundred overall per ten
-- minutes bounds what a distributed version of that costs the database. All three answer 'busy'
-- rather than 'not_invited'.
-- ---------------------------------------------------------------------------
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
begin
  -- A malformed address is not worth a lookup, and not worth a throttle slot either.
  if length(v_email) = 0
     or length(v_email) > 254
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return 'not_invited';
  end if;

  v_canonical := public.email_canonical(v_email);
  v_hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');
  v_ip_hash := public.ip_hash(public.request_ip());

  -- Pruned here rather than by a job: the table only ever needs to answer "how many in the last ten
  -- minutes", and this is its one writer.
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

  if not exists (
    select 1 from public.allowed_emails a
     where public.email_canonical(a.email) = v_canonical
  ) then
    return 'not_invited';
  end if;

  -- Matched on the canonical form, because the account's address and the invited address can be two
  -- spellings of one mailbox.
  select u.id into v_user_id
    from auth.users u
   where public.email_canonical(u.email) = v_canonical
   limit 1;

  if v_user_id is null then
    return 'invited_new';
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
