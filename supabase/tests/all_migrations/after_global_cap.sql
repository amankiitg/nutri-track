-- Global analysis cap and the verification guard (20261120170000).
--
-- Counts a synthetic row, never a real one: the insert below belongs to a made up user id.

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_before integer;
  v_after integer;
  v_verified boolean;
BEGIN
  IF to_regprocedure('public.global_analyses_today()') IS NULL THEN
    RAISE EXCEPTION 'not ok - global_analyses_today is missing';
  END IF;
  IF to_regprocedure('public.caller_email_verified()') IS NULL THEN
    RAISE EXCEPTION 'not ok - caller_email_verified is missing';
  END IF;

  -- Counting is a number, and it moves when a call is recorded.
  v_before := public.global_analyses_today();

  INSERT INTO public.llm_calls (user_id, model, status)
  VALUES ('00000000-0000-4000-8000-0000000000c1', 'test-model', 'ok');

  v_after := public.global_analyses_today();
  IF v_after <> v_before + 1 THEN
    RAISE EXCEPTION 'not ok - the count went from % to %', v_before, v_after;
  END IF;

  DELETE FROM public.llm_calls WHERE user_id = '00000000-0000-4000-8000-0000000000c1';

  -- No session, no verified address.
  v_verified := public.caller_email_verified();
  IF v_verified THEN
    RAISE EXCEPTION 'not ok - an anonymous caller counted as verified';
  END IF;

  -- A caller role may run the count and may not read the table behind it.
  IF NOT has_function_privilege('authenticated', 'public.global_analyses_today()', 'execute') THEN
    RAISE EXCEPTION 'not ok - a signed-in caller cannot ask for the count';
  END IF;
  IF has_function_privilege('anon', 'public.global_analyses_today()', 'execute') THEN
    RAISE EXCEPTION 'not ok - anon can ask for the global count';
  END IF;
END $$;

\echo 'ok - the global count moves with a recorded call, and verification fails closed'
