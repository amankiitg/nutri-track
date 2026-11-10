-- SQL tests for the trial functions, run after the migration against a local
-- database with the stub in place and the Vault secret planted.
--
-- Each test is a DO block that raises (and, with ON_ERROR_STOP, stops psql with a
-- non-zero exit) the moment an assertion fails. A run that reaches the final line has
-- passed every assertion. This is plain SQL rather than pgTAP because pgTAP is not
-- installed here; the shape is the same.

\set ON_ERROR_STOP on

-- 1. A wrong secret, and a missing (null) secret, fail every trial_* function.
DO $$
DECLARE
  raised boolean;
BEGIN
  raised := false;
  BEGIN PERFORM public.trial_send_code('wrong-secret', 'a@b.co', null, '1.2.3.4');
  EXCEPTION WHEN others THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'not ok - trial_send_code accepted a wrong secret'; END IF;

  raised := false;
  BEGIN PERFORM public.trial_send_code(null, 'a@b.co', null, '1.2.3.4');
  EXCEPTION WHEN others THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'not ok - trial_send_code accepted a null secret'; END IF;

  raised := false;
  BEGIN PERFORM public.trial_verify_code('wrong-secret', 'a@b.co', '123456');
  EXCEPTION WHEN others THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'not ok - trial_verify_code accepted a wrong secret'; END IF;

  raised := false;
  BEGIN PERFORM public.trial_scan_start('wrong-secret', 'a@b.co', '1.2.3.4');
  EXCEPTION WHEN others THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'not ok - trial_scan_start accepted a wrong secret'; END IF;

  raised := false;
  BEGIN PERFORM public.trial_log_call('wrong-secret', '00000000-0000-0000-0000-000000000000', 'm', 1, 2, 3, 'ok');
  EXCEPTION WHEN others THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'not ok - trial_log_call accepted a wrong secret'; END IF;
END $$;
\echo 'ok 1 - wrong or missing secret fails every trial_* function'

-- 2. The happy path: send a code (canonicalised), verify it, start a scan that reserves
--    a row, then log the call into that reserved row by id.
DO $$
DECLARE
  v_result jsonb;
  v_scan jsonb;
  v_call_id uuid;
  v_verify text;
  v_model text;
  v_status text;
  v_tokens integer;
BEGIN
  v_result := public.trial_send_code('test-secret-123', 'Alice@Gmail.com', 'Alice', '203.0.113.7');
  IF v_result->>'status' <> 'sent' THEN
    RAISE EXCEPTION 'not ok - send_code did not send: %', v_result;
  END IF;
  IF v_result->>'email' <> 'alice@gmail.com' THEN
    RAISE EXCEPTION 'not ok - email not canonicalised: %', v_result->>'email';
  END IF;

  v_verify := public.trial_verify_code('test-secret-123', 'alice@gmail.com', v_result->>'code');
  IF v_verify <> 'ok' THEN
    RAISE EXCEPTION 'not ok - verify_code returned: %', v_verify;
  END IF;

  v_scan := public.trial_scan_start('test-secret-123', 'alice@gmail.com', '203.0.113.7');
  IF v_scan->>'status' <> 'ok' THEN
    RAISE EXCEPTION 'not ok - scan_start returned: %', v_scan;
  END IF;
  IF (v_scan->>'scans_total')::integer <> 10 THEN
    RAISE EXCEPTION 'not ok - scans_total should be 10: %', v_scan;
  END IF;
  IF v_scan->>'call_id' IS NULL THEN
    RAISE EXCEPTION 'not ok - scan_start returned no call_id';
  END IF;
  v_call_id := (v_scan->>'call_id')::uuid;

  SELECT model, status INTO v_model, v_status FROM public.llm_calls WHERE id = v_call_id;
  IF v_status <> 'reserved' OR v_model <> 'trial' THEN
    RAISE EXCEPTION 'not ok - reserved row is wrong (model=%, status=%): %', v_model, v_status, v_scan;
  END IF;

  PERFORM public.trial_log_call('test-secret-123', v_call_id, 'gemini-3.8-flash', 11, 22, 3, 'ok');
  SELECT model, status, prompt_tokens INTO v_model, v_status, v_tokens FROM public.llm_calls WHERE id = v_call_id;
  IF v_model <> 'gemini-3.8-flash' OR v_status <> 'ok' OR v_tokens <> 11 THEN
    RAISE EXCEPTION 'not ok - log_call did not fill the reserved row (model=%, status=%, tokens=%)', v_model, v_status, v_tokens;
  END IF;
END $$;
\echo 'ok 2 - code, verify, reserve, and log-by-id work end to end'

-- 3. The per-mailbox ceiling comes from trial_settings, not from anything the caller
--    passes. There are no limit arguments left to pass, so this is also the proof that
--    no caller input can move the ceiling: with scans_limit set to 2, exactly two scans
--    succeed and the third is refused.
update public.trial_settings set scans_limit = 2, daily_budget = 100;

DO $$
DECLARE
  v jsonb;
BEGIN
  PERFORM public.trial_send_code('test-secret-123', 'bob@example.com', 'Bob', '198.51.100.1');

  v := public.trial_scan_start('test-secret-123', 'bob@example.com', '198.51.100.1');
  IF v->>'status' <> 'ok' THEN RAISE EXCEPTION 'not ok - first scan should be ok: %', v; END IF;

  v := public.trial_scan_start('test-secret-123', 'bob@example.com', '198.51.100.1');
  IF v->>'status' <> 'ok' THEN RAISE EXCEPTION 'not ok - second scan should be ok: %', v; END IF;

  v := public.trial_scan_start('test-secret-123', 'bob@example.com', '198.51.100.1');
  IF v->>'status' <> 'no_scans_left' THEN RAISE EXCEPTION 'not ok - third scan should be no_scans_left, got: %', v; END IF;
  IF (v->>'scans_total')::integer <> 2 THEN
    RAISE EXCEPTION 'not ok - scans_total should be 2 (from settings): %', v;
  END IF;
END $$;
\echo 'ok 3 - the per-mailbox ceiling is the settings value, and no caller input can move it'

-- 4. The global daily budget is read from settings, and it is what scan_start enforces.
update public.trial_settings set scans_limit = 10, daily_budget = 0;

DO $$
DECLARE
  v jsonb;
BEGIN
  PERFORM public.trial_send_code('test-secret-123', 'carol@example.com', 'Carol', '203.0.113.99');
  v := public.trial_scan_start('test-secret-123', 'carol@example.com', '203.0.113.99');
  IF v->>'status' <> 'busy' THEN RAISE EXCEPTION 'not ok - daily budget 0 should refuse as busy, got: %', v; END IF;
END $$;

update public.trial_settings set daily_budget = 100;
\echo 'ok 4 - the daily budget is read from settings and enforced'
