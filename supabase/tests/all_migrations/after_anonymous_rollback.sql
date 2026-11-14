-- After rolling back 20261114120000_trial_anonymous.sql alone: the anonymous table and
-- functions are gone, and the admin list and stats are back to their email-only shape
-- while still working for the admin.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF to_regclass('public.trial_devices') IS NOT NULL THEN
    RAISE EXCEPTION 'not ok - trial_devices remains after rollback';
  END IF;
  IF to_regprocedure('public.trial_anon_start(text,text,uuid)') IS NOT NULL
     OR to_regprocedure('public.trial_anon_scan_start(text,uuid,text,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'not ok - an anonymous trial function remains after rollback';
  END IF;
  IF to_regprocedure('public.admin_trial_list(text,integer)') IS NULL THEN
    RAISE EXCEPTION 'not ok - admin_trial_list is missing after rollback';
  END IF;
  IF to_regprocedure('public.admin_trial_stats()') IS NULL THEN
    RAISE EXCEPTION 'not ok - admin_trial_stats is missing after rollback';
  END IF;
END $$;
\echo 'ok - the rollback removes trial_devices and the anonymous functions, and restores the admin functions'

-- Computed as the owner: the authenticated role may not read trial_users directly.
select set_config(
  'test.expected_user_count',
  ((select count(*) from public.trial_users)::integer)::text,
  false
);

begin;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b1","email":"links-admin@example.com","role":"authenticated"}';
DO $$
DECLARE
  v_rows integer;
  v_expected integer;
  v_stats record;
BEGIN
  SELECT count(*) INTO v_rows FROM public.admin_trial_list('list');
  IF v_rows <> 3 THEN
    RAISE EXCEPTION 'not ok - the restored admin_trial_list returned % email rows, expected 3', v_rows;
  END IF;

  SELECT count(*) INTO v_rows FROM public.admin_trial_list('anonymous');
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'not ok - the restored admin_trial_list still returns anonymous rows';
  END IF;

  v_expected := current_setting('test.expected_user_count')::integer;
  SELECT * INTO v_stats FROM public.admin_trial_stats();
  IF v_stats.user_count <> v_expected THEN
    RAISE EXCEPTION 'not ok - restored admin_trial_stats counts %, expected %', v_stats.user_count, v_expected;
  END IF;
END $$;
commit;
\echo 'ok - the restored admin list and stats answer for the admin without the anonymous table'
