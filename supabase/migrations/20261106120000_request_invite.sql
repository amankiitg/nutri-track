-- Requesting access from the sign-up form, before there is an account to ask with.
--
-- The `invite_requests` table was built for the Google path: someone signs in, the guard finds
-- them off the list, and their own signed token supplies the address. Every part of that is
-- authenticated, which is why the insert policy can say `requested_by = auth.uid()` and
-- `email = auth.jwt() ->> 'email'` and cannot be pointed at anybody else.
--
-- The email sign-up form has none of that. Supabase will not sign someone in until they confirm
-- the address, and an uninvited person has no profile anyway, so the insert the form needs is
-- made by `anon`, which the table deliberately grants nothing to. This function is that missing
-- path: one definer-rights insert, narrow enough to be worth having.
--
-- Why this is not a hole, since it is a definer function anon can call:
--
--   * it writes **one** row, about the address it was given, and the table's existing unique
--     index means that address can only ever have one. There is nothing here to fill a table
--     with;
--   * `invite_requests_guard` still runs, and its burst limit (25 rows an hour across the whole
--     table) still bounds what a script with many addresses can do;
--   * a **signed-in** caller does not get to name an address at all: the session's own `email`
--     claim replaces the argument, so the "a request can only be about the person making it"
--     rule survives for every authenticated caller;
--   * it writes only `email` and `requested_by`. Status, timestamps and handling are not
--     arguments, so nothing an outsider sends can be believed.
--
-- This reverses an earlier decision in `src/lib/admin.ts`, which said a definer function was
-- rejected because the RLS insert already covered the case. It did cover the case it was written
-- for, which was Google sign-in. It never covered this one.

-- A request made from the sign-up form has no account behind it. The column keeps its meaning
-- ("the account that asked, if there was one") rather than being filled with a placeholder that
-- would read like a real user in every query that joins it.
alter table public.invite_requests alter column requested_by drop not null;

comment on column public.invite_requests.requested_by is
  'The account that asked, when the address had one. Null for a request made from the email sign-up form, which happens before that address has a session.';

/**
 * Records a request for access and reports whether the address is now on record.
 *
 * Returns **true** when a row exists for the address afterwards, which is the only claim worth
 * making: it covers both "just recorded" and "asked before", and the person needs no different
 * answer for either. Returns **false** when the table's burst guard skipped the insert, so the
 * caller can show a real failure instead of thanking someone for a request that was not kept.
 *
 * Raises `22023` for something that is not an address, and `28000` for a signed-in session with
 * no `email` claim (which should be impossible, and stops the argument being trusted instead).
 */
create or replace function public.request_invite(_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $function$
declare
  _address text := lower(trim(coalesce(_email, '')));
  _uid uuid := auth.uid();
  _from_session text := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
  _recorded boolean;
begin
  -- Authenticated callers ask for themselves, whatever they sent.
  if _uid is not null then
    if _from_session = '' then
      raise exception 'request_invite: the session has no email' using errcode = '28000';
    end if;
    _address := _from_session;
  end if;

  -- The same shape the client checks, enforced here as well because this is the boundary an
  -- anonymous request crosses. Delivery is the real test and this app cannot run it, so this
  -- only has to stop the obvious rubbish.
  if _address = '' or position('@' in _address) = 0 or length(_address) > 254 then
    raise exception 'request_invite: not an email address' using errcode = '22023';
  end if;

  -- The trigger does the dedupe and the burst limit, and skips the row by returning null rather
  -- than raising, so this is not an error path for the caller. `on conflict` is the backstop if
  -- that ever stops being true.
  insert into public.invite_requests (email, requested_by)
  values (_address, _uid)
  on conflict (email) do nothing;

  select exists (select 1 from public.invite_requests r where r.email = _address)
    into _recorded;
  return _recorded;
end $function$;

-- `anon` is the point of the function. `public` is revoked first because a function is
-- executable by PUBLIC until someone says otherwise, and this one must not be reachable by a
-- role that has not been thought about.
revoke execute on function public.request_invite(text) from public;
grant execute on function public.request_invite(text) to anon, authenticated;

-- The properties this file claims, asserted rather than assumed. Each failure is invisible from
-- the outside: the function would exist and answer, and be missing the thing that makes it safe.
do $guard$
declare
  _body text;
  _prosecdef boolean;
  _nullable text;
begin
  -- 1. A request from the sign-up form has no requesting account, so the column has to allow it.
  select is_nullable into _nullable
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'invite_requests'
     and column_name = 'requested_by';
  if _nullable is distinct from 'YES' then
    raise exception 'invite_requests.requested_by is still NOT NULL, so the anon path cannot insert';
  end if;

  -- 2. Definer rights are the whole mechanism: an invoker-rights version would be refused by
  --    the table's own grants, which is what the function exists to get past.
  select prosrc, prosecdef into _body, _prosecdef
    from pg_proc
   where proname = 'request_invite' and pronamespace = 'public'::regnamespace;

  if _body is null then
    raise exception 'request_invite was not created';
  end if;
  if not _prosecdef then
    raise exception 'request_invite is not security definer, so anon cannot use it';
  end if;

  -- 3. The two roles that need it can call it, and the one that must not cannot.
  if not has_function_privilege('anon', 'public.request_invite(text)', 'EXECUTE') then
    raise exception 'anon may not execute request_invite, which is its only caller';
  end if;
  if not has_function_privilege('authenticated', 'public.request_invite(text)', 'EXECUTE') then
    raise exception 'authenticated may not execute request_invite';
  end if;

  -- 4. The self-only rule for signed-in callers. Textual, because the behaviour needs a JWT to
  --    exercise; a request argument that overrode the session would be an address-aiming hole.
  if strpos(lower(_body), 'auth.jwt()') = 0 then
    raise exception 'request_invite no longer reads the address from the session';
  end if;

  -- 5. It writes a request and nothing else: no status, no timestamps, no handling.
  if strpos(lower(_body), 'insert into public.invite_requests') = 0 then
    raise exception 'request_invite no longer writes an invite request';
  end if;
end $guard$;
