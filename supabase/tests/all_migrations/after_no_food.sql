-- The no-food refund and its funnel step (20261120150000), after every migration.
--
-- Runs after after_funnel.sql, so the secret is planted and the counters exist. Every row here
-- is synthetic: a device with a scan spent, and a mailbox with one spent.

-- This file describes the invite-only product, so the switch is pinned closed for it;
-- with sign-ups open, `check_email_allowed` and the request trigger answer differently.
update public.app_settings set open_signups = false where id;

\set ON_ERROR_STOP on

update vault.decrypted_secrets
   set decrypted_secret = 'links-secret'
 where name = 'trial_server_secret';

update public.trial_settings set scans_limit = 10;

-- Shapes: the refund exists, is secret-gated, and only anon (the service) may call it.
DO $$
BEGIN
  IF to_regprocedure('public.trial_scan_refund(text,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'not ok - trial_scan_refund is missing';
  END IF;
  IF NOT has_function_privilege('anon', 'public.trial_scan_refund(text,text,uuid)', 'execute') THEN
    RAISE EXCEPTION 'not ok - anon cannot execute trial_scan_refund';
  END IF;
  IF has_function_privilege('public', 'public.trial_scan_refund(text,text,uuid)', 'execute') THEN
    RAISE EXCEPTION 'not ok - PUBLIC can execute trial_scan_refund';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trial_devices'
                    AND column_name = 'no_food_refunds')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'trial_users'
                       AND column_name = 'no_food_refunds') THEN
    RAISE EXCEPTION 'not ok - a refund counter column is missing';
  END IF;
END $$;
\echo 'ok - the refund exists, is gated by the server secret, and both rows carry a refund counter'

-- A device with one scan spent gives it back, and the count it reports is the new one.
DO $$
DECLARE
  v_device uuid;
  v_result jsonb;
  v_used integer;
BEGIN
  INSERT INTO public.trial_devices (scans_used) VALUES (5) RETURNING id INTO v_device;

  v_result := public.trial_scan_refund('links-secret', NULL, v_device);
  IF (v_result ->> 'status') <> 'ok' OR (v_result ->> 'refunded')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'not ok - the refund refused a spent scan: %', v_result;
  END IF;
  IF (v_result ->> 'scans_left')::integer <> 6 THEN
    RAISE EXCEPTION 'not ok - scans_left is % after a refund from 5 of 10', v_result ->> 'scans_left';
  END IF;

  SELECT scans_used INTO v_used FROM public.trial_devices WHERE id = v_device;
  IF v_used <> 4 THEN
    RAISE EXCEPTION 'not ok - scans_used is % after one refund', v_used;
  END IF;

  -- A mailbox with a spent scan, through the same function.
  INSERT INTO public.trial_users (email, scans_used) VALUES ('no-food@example.com', 2);
  v_result := public.trial_scan_refund('links-secret', 'no-food@example.com', NULL);
  IF (v_result ->> 'refunded')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'not ok - the mailbox refund refused: %', v_result;
  END IF;
  IF (v_result ->> 'scans_left')::integer <> 9 THEN
    RAISE EXCEPTION 'not ok - the mailbox scans_left is %', v_result ->> 'scans_left';
  END IF;

  DELETE FROM public.trial_users WHERE email = 'no-food@example.com';
  DELETE FROM public.trial_devices WHERE id = v_device;
END $$;
\echo 'ok - a refund gives a spent scan back, for a device and for a mailbox'

-- The cap: three refunds, then the fourth says no and leaves the counter alone.
DO $$
DECLARE
  v_device uuid;
  v_result jsonb;
  v_used integer;
  i integer;
BEGIN
  INSERT INTO public.trial_devices (scans_used) VALUES (9) RETURNING id INTO v_device;

  FOR i IN 1..3 LOOP
    v_result := public.trial_scan_refund('links-secret', NULL, v_device);
    IF (v_result ->> 'refunded')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'not ok - refund % of 3 was refused: %', i, v_result;
    END IF;
  END LOOP;

  v_result := public.trial_scan_refund('links-secret', NULL, v_device);
  IF (v_result ->> 'refunded')::boolean IS TRUE THEN
    RAISE EXCEPTION 'not ok - a fourth refund was granted';
  END IF;
  SELECT scans_used INTO v_used FROM public.trial_devices WHERE id = v_device;
  IF v_used <> 6 THEN
    RAISE EXCEPTION 'not ok - scans_used is % after three refunds from 9', v_used;
  END IF;
  IF (v_result ->> 'scans_left')::integer <> 4 THEN
    RAISE EXCEPTION 'not ok - the refused refund reported scans_left=%', v_result ->> 'scans_left';
  END IF;

  DELETE FROM public.trial_devices WHERE id = v_device;
END $$;
\echo 'ok - three refunds a device, and the fourth is refused without moving the counter'

-- Nothing to refund is not a refund, and neither target is a caller bug.
DO $$
DECLARE
  v_device uuid;
  v_result jsonb;
BEGIN
  INSERT INTO public.trial_devices (scans_used) VALUES (0) RETURNING id INTO v_device;
  v_result := public.trial_scan_refund('links-secret', NULL, v_device);
  IF (v_result ->> 'refunded')::boolean IS TRUE THEN
    RAISE EXCEPTION 'not ok - a device with no scans spent got a refund';
  END IF;
  DELETE FROM public.trial_devices WHERE id = v_device;

  v_result := public.trial_scan_refund('links-secret', NULL, NULL);
  IF (v_result ->> 'status') <> 'invalid' THEN
    RAISE EXCEPTION 'not ok - a refund with no target answered %', v_result;
  END IF;
  v_result := public.trial_scan_refund('links-secret', 'a@example.com', gen_random_uuid());
  IF (v_result ->> 'status') <> 'invalid' THEN
    RAISE EXCEPTION 'not ok - a refund with two targets answered %', v_result;
  END IF;
END $$;
\echo 'ok - no scan to give back, and no target or two targets, are all answered'

-- The secret gate.
DO $$
DECLARE
  raised boolean := false;
BEGIN
  BEGIN PERFORM public.trial_scan_refund('wrong-secret', NULL, gen_random_uuid());
  EXCEPTION WHEN insufficient_privilege THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'not ok - the refund accepted a wrong secret'; END IF;
END $$;
\echo 'ok - the refund refuses a wrong server secret'

-- The new event: loggable, outside no earlier allowlist, and reported by the admin read.
DO $$
DECLARE
  v jsonb;
BEGIN
  v := public.trial_funnel_log('analysis_no_food', '203.0.113.9', 'links-secret');
  IF (v ->> 'status') <> 'ok' THEN
    RAISE EXCEPTION 'not ok - analysis_no_food was not logged: %', v;
  END IF;

  BEGIN
    PERFORM public.trial_funnel_log('analysis_no_food ', '203.0.113.9', 'links-secret');
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'not ok - the event with trailing space was refused';
  END;
END $$;
\echo 'ok - analysis_no_food is on the allowlist and is logged'

begin;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b1","email":"links-admin@example.com","role":"authenticated"}';
DO $$
DECLARE
  v jsonb;
BEGIN
  v := public.admin_trial_funnel(7);
  IF NOT (v -> 'today') ? 'analysis_no_food' THEN
    RAISE EXCEPTION 'not ok - the admin read does not list analysis_no_food';
  END IF;
  IF (v -> 'today' ->> 'analysis_no_food')::integer < 1 THEN
    RAISE EXCEPTION 'not ok - the admin read counted no analysis_no_food';
  END IF;
END $$;
commit;
\echo 'ok - the admin funnel read lists analysis_no_food and counts it'

update public.app_settings set open_signups = true where id;
