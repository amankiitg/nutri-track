-- The admin trials list (20261112120000), after every migration. Synthetic rows only.
--
-- Runs on the state after_links.sql left: an admin (b1), a member (b2), and trial rows
-- from the link tests. The rows this file asserts on are its own, with known timestamps.

\set ON_ERROR_STOP on

-- Shapes and grants.
DO $$
BEGIN
  IF to_regprocedure('public.admin_trial_list(text,integer)') IS NULL THEN
    RAISE EXCEPTION 'not ok - admin_trial_list(text, integer) does not exist';
  END IF;
  IF has_function_privilege('anon', 'public.admin_trial_list(text,integer)', 'execute') THEN
    RAISE EXCEPTION 'not ok - anon may execute admin_trial_list';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.admin_trial_list(text,integer)', 'execute') THEN
    RAISE EXCEPTION 'not ok - authenticated cannot execute admin_trial_list';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = 'public.admin_trial_list(text,integer)'::regprocedure AND a.grantee = 0
  ) THEN
    RAISE EXCEPTION 'not ok - PUBLIC may execute admin_trial_list';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.trial_users'::regclass
       AND attname = 'source' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'not ok - trial_users has no source column';
  END IF;
END $$;
\echo 'ok - admin_trial_list exists, anon is refused, authenticated is granted, trial_users has source'

-- Three rows with known order, one invited through a Gmail spelling, one request after
-- the trial. Everything is example.com or a synthetic Gmail address.
insert into public.trial_users (email, first_name, scans_used, created_at, last_used_at, source)
values
  ('listnewest@example.com', 'Newest', 7, '2026-11-12T09:00:00Z', '2026-11-12T10:00:00Z', 'link'),
  ('listmiddle@example.com', 'Middle', 3, '2026-11-11T09:00:00Z', '2026-11-11T10:00:00Z', 'code'),
  ('listfriend@gmail.com', 'Friend', 10, '2026-11-10T09:00:00Z', null, 'code');

insert into public.allowed_emails (email)
values ('List.Friend@Gmail.com') on conflict do nothing;

insert into public.invite_requests (email, requested_by, requested_at, status, from_trial)
values (
  'listnewest@example.com',
  '00000000-0000-0000-0000-0000000000b1',
  '2026-11-12T11:00:00Z',
  'pending',
  true
);

begin;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b1","email":"links-admin@example.com","role":"authenticated"}';
DO $$
DECLARE
  v_rows integer;
  v_newest record;
  v_middle record;
  v_friend record;
BEGIN
  SELECT count(*) INTO v_rows FROM public.admin_trial_list('list');
  IF v_rows <> 3 THEN
    RAISE EXCEPTION 'not ok - the search for list returned % rows, expected 3', v_rows;
  END IF;

  SELECT * INTO v_newest FROM public.admin_trial_list('list') l LIMIT 1;
  IF v_newest.email <> 'listnewest@example.com' THEN
    RAISE EXCEPTION 'not ok - newest first is broken: first row is %', v_newest.email;
  END IF;
  IF v_newest.source <> 'link' OR v_newest.invited IS DISTINCT FROM false
     OR v_newest.scans_used <> 7 OR v_newest.scans_limit <> 10
     OR v_newest.first_seen <> '2026-11-12T09:00:00Z'::timestamptz
     OR v_newest.last_active <> '2026-11-12T10:00:00Z'::timestamptz
     OR v_newest.requested_after IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'not ok - the newest row answered %', v_newest;
  END IF;

  SELECT * INTO v_middle FROM public.admin_trial_list('list') l OFFSET 1 LIMIT 1;
  IF v_middle.email <> 'listmiddle@example.com' OR v_middle.source <> 'code'
     OR v_middle.requested_after IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'not ok - the middle row answered %', v_middle;
  END IF;

  SELECT * INTO v_friend FROM public.admin_trial_list('list') l OFFSET 2 LIMIT 1;
  IF v_friend.email <> 'listfriend@gmail.com' OR v_friend.invited IS DISTINCT FROM true
     OR v_friend.last_active IS NOT NULL THEN
    RAISE EXCEPTION 'not ok - the Gmail row answered %', v_friend;
  END IF;

  -- Typed the way Gmail shows it: dots and case fold to the stored canonical form.
  SELECT count(*) INTO v_rows FROM public.admin_trial_list('List.Friend@Gmail.com');
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'not ok - a dotted Gmail search returned % rows, expected 1', v_rows;
  END IF;

  SELECT count(*) INTO v_rows FROM public.admin_trial_list('nobody@example.com');
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'not ok - a search with no match returned % rows', v_rows;
  END IF;
END $$;
commit;
\echo 'ok - the admin sees one row per trial, newest first, with source, invited, scans, dates and the later request'

-- The limit is clamped in the database, not trusted from the caller.
insert into public.trial_users (email, first_name, scans_used, created_at, source)
select 'bulk' || lpad(i::text, 3, '0') || '@example.com', 'Bulk', i,
       '2026-10-01T00:00:00Z'::timestamptz + (i || ' minutes')::interval, 'code'
  from generate_series(1, 51) as i;

begin;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b1","email":"links-admin@example.com","role":"authenticated"}';
DO $$
DECLARE
  v_rows integer;
BEGIN
  SELECT count(*) INTO v_rows FROM public.admin_trial_list('bulk', 1000);
  IF v_rows <> 50 THEN
    RAISE EXCEPTION 'not ok - p_limit 1000 returned % rows, expected the 50 ceiling', v_rows;
  END IF;
  SELECT count(*) INTO v_rows FROM public.admin_trial_list('bulk', 0);
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'not ok - p_limit 0 returned % rows, expected the 1 floor', v_rows;
  END IF;
END $$;
commit;
\echo 'ok - p_limit is clamped to 1..50 by the function'

-- A signed-in member who is not the admin is refused.
begin;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b2","email":"links-member@example.com","role":"authenticated"}';
DO $$
DECLARE
  raised boolean := false;
BEGIN
  BEGIN PERFORM * FROM public.admin_trial_list();
  EXCEPTION WHEN insufficient_privilege THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'not ok - a non-admin could read admin_trial_list'; END IF;
END $$;
commit;
\echo 'ok - a non-admin is refused admin_trial_list'
