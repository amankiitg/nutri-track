-- Trial funnel counters (20261120120000), after every migration. Synthetic rows only.
--
-- Runs after after_anonymous.sql, so the Vault secret is planted ('links-secret') and the
-- anonymous trial's own tables exist. Nothing here reads or writes a real row.

\set ON_ERROR_STOP on

update vault.decrypted_secrets
   set decrypted_secret = 'links-secret'
 where name = 'trial_server_secret';

-- Shapes, the allowlist, and who may touch what.
DO $$
BEGIN
  IF to_regclass('public.trial_funnel_daily') IS NULL OR to_regclass('public.trial_funnel_ip_daily') IS NULL THEN
    RAISE EXCEPTION 'not ok - a funnel table is missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.trial_funnel_daily'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.trial_funnel_ip_daily'::regclass) THEN
    RAISE EXCEPTION 'not ok - a funnel table has RLS off';
  END IF;
  IF has_table_privilege('anon', 'public.trial_funnel_daily', 'select')
     OR has_table_privilege('authenticated', 'public.trial_funnel_daily', 'select')
     OR has_table_privilege('anon', 'public.trial_funnel_ip_daily', 'select') THEN
    RAISE EXCEPTION 'not ok - a caller role can read the counters directly';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.trial_funnel_daily', 'select') THEN
    RAISE EXCEPTION 'not ok - service_role cannot read the counters';
  END IF;

  -- The allowlist, proved by the table refusing an event that is not on it.
  BEGIN
    INSERT INTO public.trial_funnel_daily (day, event, count) VALUES (current_date, 'not_an_event', 1);
    RAISE EXCEPTION 'not ok - the table accepted an event outside the allowlist';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  IF NOT has_function_privilege('anon', 'public.trial_funnel_log(text,text,text)', 'execute') THEN
    RAISE EXCEPTION 'not ok - anon cannot execute trial_funnel_log';
  END IF;
  IF has_function_privilege('anon', 'public.admin_trial_funnel(integer)', 'execute')
     OR has_function_privilege('public', 'public.trial_funnel_bump(text,text,integer)', 'execute') THEN
    RAISE EXCEPTION 'not ok - the admin read or the bump is reachable by a caller role';
  END IF;
  IF to_regclass('public.invite_requests') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'invite_requests_trial_funnel') THEN
    RAISE EXCEPTION 'not ok - the invite-request trigger is missing';
  END IF;
END $$;
\echo 'ok - the funnel tables are locked, the allowlist rejects an unknown event, and only anon may log'

-- The secret gate: the writer is refused without the server's secret.
DO $$
DECLARE
  raised boolean := false;
BEGIN
  BEGIN PERFORM public.trial_funnel_log('try_page_view', '203.0.113.1', null);
  EXCEPTION WHEN insufficient_privilege THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'not ok - trial_funnel_log accepted a call with no secret'; END IF;
END $$;

DO $$
DECLARE
  raised boolean := false;
BEGIN
  BEGIN PERFORM public.trial_funnel_log('try_page_view', '203.0.113.1', 'wrong-secret');
  EXCEPTION WHEN insufficient_privilege THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'not ok - trial_funnel_log accepted a wrong secret'; END IF;
END $$;
\echo 'ok - trial_funnel_log refuses a missing or wrong server secret'

-- Counting, and the allowlist again through the function's own check.
DELETE FROM public.trial_funnel_daily;
DELETE FROM public.trial_funnel_ip_daily;

DO $$
DECLARE
  v_status text;
  raised boolean;
BEGIN
  PERFORM public.trial_funnel_log('try_page_view', '203.0.113.1', 'links-secret');
  PERFORM public.trial_funnel_log('try_page_view', '203.0.113.2', 'links-secret');
  PERFORM public.trial_funnel_log('token_issued', null, 'links-secret');

  IF (SELECT count FROM public.trial_funnel_daily WHERE day = current_date AND event = 'try_page_view') <> 2 THEN
    RAISE EXCEPTION 'not ok - two page views did not count as two';
  END IF;
  IF (SELECT count FROM public.trial_funnel_daily WHERE day = current_date AND event = 'token_issued') <> 1 THEN
    RAISE EXCEPTION 'not ok - the server event did not count';
  END IF;

  -- A raw address never lands in the cap's table, only the salted hash.
  IF EXISTS (SELECT 1 FROM public.trial_funnel_ip_daily WHERE ip_hash LIKE '%203.0.113%') THEN
    RAISE EXCEPTION 'not ok - a raw address was stored';
  END IF;

  raised := false;
  BEGIN PERFORM public.trial_funnel_log('not_an_event', null, 'links-secret');
  EXCEPTION WHEN invalid_parameter_value THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'not ok - an unknown event was accepted'; END IF;
  v_status := 'ok';
END $$;
\echo 'ok - the counters add up, only the hash is stored, and an unknown event is refused'

-- The cap: twenty a day per hash for the two browser events, and the aggregate stops at
-- twenty too (a capped event is not counted, so the funnel never overstates a visitor).
DO $$
DECLARE
  i integer;
  v_result jsonb;
  v_count integer;
BEGIN
  FOR i IN 1..21 LOOP
    v_result := public.trial_funnel_log('analyse_tapped', '203.0.113.9', 'links-secret');
  END LOOP;
  IF v_result ->> 'status' <> 'capped' THEN
    RAISE EXCEPTION 'not ok - the 21st analyse_tapped was not capped: %', v_result;
  END IF;
  SELECT count INTO v_count FROM public.trial_funnel_daily WHERE day = current_date AND event = 'analyse_tapped';
  IF v_count <> 20 THEN
    RAISE EXCEPTION 'not ok - the capped event was counted % times, expected 20', v_count;
  END IF;

  -- A server-sent event is not capped by that counter at all.
  FOR i IN 1..3 LOOP
    PERFORM public.trial_funnel_log('analysis_ok', '203.0.113.9', 'links-secret');
  END LOOP;
  SELECT count INTO v_count FROM public.trial_funnel_daily WHERE day = current_date AND event = 'analysis_ok';
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'not ok - server events were capped: %', v_count;
  END IF;
END $$;
\echo 'ok - twenty browser events a hash a day, the 21st capped and not counted, server events uncapped'

-- "Asked for an invite": the trigger counts a trial request and ignores a signed-in one.
DELETE FROM public.trial_funnel_daily WHERE event = 'request_invite_submitted';
INSERT INTO public.invite_requests (email, requested_by, status, from_trial)
VALUES ('funnel-probe@example.com', '00000000-0000-0000-0000-0000000000b1', 'pending', true);
INSERT INTO public.invite_requests (email, requested_by, status, from_trial)
VALUES ('funnel-probe-two@example.com', '00000000-0000-0000-0000-0000000000b1', 'pending', false);
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count INTO v_count FROM public.trial_funnel_daily
   WHERE day = current_date AND event = 'request_invite_submitted';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'not ok - request_invite_submitted counted %, expected 1 (the trial one)', v_count;
  END IF;
END $$;
\echo 'ok - a trial invite request counts once, a signed-in one does not count'

-- The admin read: refused to a non-admin, and every allowlisted event present for the admin.
begin;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b2","email":"links-member@example.com","role":"authenticated"}';
DO $$
DECLARE
  raised boolean := false;
BEGIN
  BEGIN PERFORM public.admin_trial_funnel(7);
  EXCEPTION WHEN insufficient_privilege THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'not ok - a non-admin could read the funnel'; END IF;
END $$;
commit;

begin;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b1","email":"links-admin@example.com","role":"authenticated"}';
DO $$
DECLARE
  v jsonb;
  v_missing text;
BEGIN
  v := public.admin_trial_funnel(7);
  IF (v ->> 'days')::integer <> 7 THEN
    RAISE EXCEPTION 'not ok - the admin read answered days=%', v ->> 'days';
  END IF;
  IF (v -> 'today' ->> 'try_page_view')::integer <> 2 THEN
    RAISE EXCEPTION 'not ok - today try_page_view is %', v -> 'today' ->> 'try_page_view';
  END IF;
  IF (v -> 'today' ->> 'limit_reached')::integer <> 0 THEN
    RAISE EXCEPTION 'not ok - an unseen event did not answer 0';
  END IF;

  SELECT string_agg(k, ',') INTO v_missing
    FROM (VALUES
            ('try_page_view'), ('analyse_tapped'), ('turnstile_failed'), ('token_issued'),
            ('analysis_ok'), ('analysis_error'), ('limit_reached'), ('request_invite_submitted')
         ) AS e(k)
   WHERE NOT (v -> 'today') ? k;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'not ok - the admin read omitted %', v_missing;
  END IF;
END $$;
commit;
\echo 'ok - the funnel read is admin-only and answers all eight events, zero included'
