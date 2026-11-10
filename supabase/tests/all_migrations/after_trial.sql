-- Runs after every migration has been applied. Checks the shapes and grants the trial
-- migration re-created, then calls the functions the way the app does, as the role the
-- app uses, because two of this migration's defects were invisible until call time
-- (a varchar column under RETURN QUERY, and an ORDER BY over a UNION).

\set ON_ERROR_STOP on

-- Shapes and grants.
DO $$
DECLARE
  v_cols integer;
BEGIN
  SELECT count(*) INTO v_cols
    FROM pg_proc p, unnest(p.proargmodes) m
   WHERE p.oid = 'public.admin_spend()'::regprocedure AND m = 't';
  IF v_cols <> 11 THEN
    RAISE EXCEPTION 'not ok - admin_spend() has % result columns, expected 11', v_cols;
  END IF;

  IF has_function_privilege('anon', 'public.admin_spend()', 'execute') THEN
    RAISE EXCEPTION 'not ok - anon may execute admin_spend()';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.admin_spend()', 'execute') THEN
    RAISE EXCEPTION 'not ok - authenticated lost execute on admin_spend()';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = 'public.admin_spend()'::regprocedure AND a.grantee = 0
  ) THEN
    RAISE EXCEPTION 'not ok - PUBLIC may execute admin_spend()';
  END IF;

  IF to_regprocedure('public.request_invite(text,text,boolean,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'not ok - the four-argument request_invite is still there';
  END IF;
  IF NOT has_function_privilege('anon', 'public.request_invite(text,text,boolean,text,boolean)', 'execute')
     OR NOT has_function_privilege('authenticated', 'public.request_invite(text,text,boolean,text,boolean)', 'execute') THEN
    RAISE EXCEPTION 'not ok - request_invite (5 args) is not executable by anon and authenticated';
  END IF;

  IF has_function_privilege('anon', 'public.admin_trial_stats()', 'execute') THEN
    RAISE EXCEPTION 'not ok - anon may execute admin_trial_stats()';
  END IF;
  IF has_function_privilege('anon', 'public.trial_server_secret()', 'execute')
     OR has_function_privilege('authenticated', 'public.trial_server_secret()', 'execute') THEN
    RAISE EXCEPTION 'not ok - a caller role may read the trial server secret';
  END IF;
END $$;
\echo 'ok - admin_spend has 11 columns and its original grants; request_invite is the 5-argument one'

-- Synthetic fixtures, written as the migration owner. Nobody real.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000a001', 'admin@example.com'),
  ('00000000-0000-0000-0000-00000000a002', 'member@example.com');
insert into public.admins (user_id) values ('00000000-0000-0000-0000-00000000a001')
  on conflict do nothing;
insert into public.llm_calls (user_id, model, status, prompt_tokens, completion_tokens)
values ('00000000-0000-0000-0000-00000000a002', 'm', 'ok', 10, 5);
insert into public.llm_calls (user_id, model, status, trial, prompt_tokens, completion_tokens)
values (null, 'm', 'ok', true, 7, 3);

-- An anonymous visitor asks for an invite from the trial wall: the call the landing page
-- and /try make, which answered PGRST202 in production while this migration was unapplied.
begin;
set local role anon;
DO $$
DECLARE
  v text;
BEGIN
  v := public.request_invite(p_email => 'wall@example.com', p_auto => false, p_from_trial => true);
  IF v <> 'requested' THEN
    RAISE EXCEPTION 'not ok - request_invite with p_from_trial answered %', v;
  END IF;
  v := public.request_invite(p_email => 'plain@example.com', p_auto => false, p_from_trial => false);
  IF v <> 'requested' THEN
    RAISE EXCEPTION 'not ok - request_invite without the trial flag answered %', v;
  END IF;
END $$;
commit;
\echo 'ok - anon request_invite with p_from_trial answers requested'

-- The admin, signed in: the spend panel, the trial card and the pending list.
begin;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-00000000a001","email":"admin@example.com","role":"authenticated"}';
DO $$
DECLARE
  v_rows integer;
  v_trial record;
  v_first text;
  v_flag boolean;
BEGIN
  SELECT count(*) INTO v_rows FROM public.admin_spend();
  IF v_rows <> 3 THEN
    RAISE EXCEPTION 'not ok - admin_spend returned % rows, expected 2 users and 1 trial line', v_rows;
  END IF;

  SELECT * INTO v_trial FROM public.admin_spend() s WHERE s.is_trial;
  IF v_trial.email <> 'Trial' OR v_trial.calls_total <> 1 OR v_trial.tokens_total <> 10 THEN
    RAISE EXCEPTION 'not ok - the trial line is wrong: %', v_trial;
  END IF;

  SELECT s.email INTO v_first FROM public.admin_spend() s LIMIT 1;
  IF v_first <> 'member@example.com' THEN
    RAISE EXCEPTION 'not ok - admin_spend is not sorted by calls_total desc: first row is %', v_first;
  END IF;

  PERFORM * FROM public.admin_trial_stats();

  SELECT r.from_trial INTO v_flag FROM public.invite_requests r WHERE r.email = 'wall@example.com';
  IF v_flag IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'not ok - the admin pending list does not show from_trial for the wall request';
  END IF;
  SELECT r.from_trial INTO v_flag FROM public.invite_requests r WHERE r.email = 'plain@example.com';
  IF v_flag IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'not ok - an ordinary request was marked from_trial';
  END IF;
END $$;
commit;
\echo 'ok - admin_spend, admin_trial_stats and the pending list (with from_trial) work for the admin'

-- A signed-in member who is not the admin is refused.
begin;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-00000000a002","email":"member@example.com","role":"authenticated"}';
DO $$
DECLARE
  raised boolean := false;
BEGIN
  BEGIN PERFORM * FROM public.admin_spend();
  EXCEPTION WHEN insufficient_privilege THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'not ok - a non-admin could read admin_spend'; END IF;
END $$;
commit;
\echo 'ok - a non-admin is refused admin_spend'

-- Normal meal analysis after the trial migration: the member writes the row recordCall
-- writes, under RLS, and neither their count nor the admin's includes trial calls.
begin;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-00000000a002","email":"member@example.com","role":"authenticated"}';
DO $$
DECLARE
  v_used integer;
  v_seen integer;
BEGIN
  INSERT INTO public.llm_calls (user_id, model, prompt_tokens, completion_tokens, latency_ms, status)
  VALUES ('00000000-0000-0000-0000-00000000a002', 'gemini', 100, 50, 900, 'ok');

  SELECT count(*) INTO v_seen FROM public.llm_calls WHERE trial;
  IF v_seen <> 0 THEN
    RAISE EXCEPTION 'not ok - a member can see % trial rows', v_seen;
  END IF;
  SELECT b.used INTO v_used FROM public.llm_call_budget() b;
  IF v_used <> 2 THEN
    RAISE EXCEPTION 'not ok - the member''s budget reads %, expected their own 2 calls', v_used;
  END IF;
END $$;
commit;

begin;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-00000000a001","email":"admin@example.com","role":"authenticated"}';
DO $$
DECLARE
  v_used integer;
  v_count integer;
BEGIN
  INSERT INTO public.llm_calls (user_id, model, status) VALUES ('00000000-0000-0000-0000-00000000a001', 'gemini', 'ok');
  -- The server's count, as caller-store.ts now sends it: own rows only.
  SELECT count(*) INTO v_count FROM public.llm_calls
   WHERE user_id = '00000000-0000-0000-0000-00000000a001' AND created_at >= now() - interval '1 day';
  SELECT b.used INTO v_used FROM public.llm_call_budget() b;
  IF v_count <> 1 OR v_used <> 1 THEN
    RAISE EXCEPTION 'not ok - the admin''s count is % and budget %, expected 1 (no trial or member calls)', v_count, v_used;
  END IF;
END $$;
commit;
\echo 'ok - a member still logs an analysis under RLS, and no one''s count includes trial calls'
