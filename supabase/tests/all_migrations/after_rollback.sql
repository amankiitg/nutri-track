-- Runs after both trial rollbacks. The previous definitions must be back with their
-- grants, and admin_spend must still be callable: a rollback that restores a function
-- which fails at call time is not a rollback.

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_cols integer;
BEGIN
  SELECT count(*) INTO v_cols
    FROM pg_proc p, unnest(p.proargmodes) m
   WHERE p.oid = 'public.admin_spend()'::regprocedure AND m = 't';
  IF v_cols <> 10 THEN
    RAISE EXCEPTION 'not ok - after rollback admin_spend() has % result columns, expected 10', v_cols;
  END IF;
  IF has_function_privilege('anon', 'public.admin_spend()', 'execute')
     OR NOT has_function_privilege('authenticated', 'public.admin_spend()', 'execute') THEN
    RAISE EXCEPTION 'not ok - after rollback admin_spend() grants differ from the original';
  END IF;

  IF to_regprocedure('public.request_invite(text,text,boolean,text,boolean)') IS NOT NULL THEN
    RAISE EXCEPTION 'not ok - after rollback the five-argument request_invite remains';
  END IF;
  IF NOT has_function_privilege('anon', 'public.request_invite(text,text,boolean,text)', 'execute')
     OR NOT has_function_privilege('authenticated', 'public.request_invite(text,text,boolean,text)', 'execute') THEN
    RAISE EXCEPTION 'not ok - after rollback request_invite (4 args) lacks its grants';
  END IF;

  IF to_regprocedure('public.trial_scans_limit(text)') IS NOT NULL
     OR to_regclass('public.trial_users') IS NOT NULL THEN
    RAISE EXCEPTION 'not ok - after rollback trial objects remain';
  END IF;
END $$;

-- Counted as the owner: the authenticated role cannot read auth.users.
select set_config('test.n_users', count(*)::text, false) from auth.users \g /dev/null
begin;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-00000000a001","email":"admin@example.com","role":"authenticated"}';
DO $$
DECLARE
  v_rows integer;
BEGIN
  SELECT count(*) INTO v_rows FROM public.admin_spend();
  -- One row per user, and the trial line is gone with the trial.
  IF v_rows <> current_setting('test.n_users')::integer THEN
    RAISE EXCEPTION 'not ok - after rollback admin_spend returned % rows, expected one per user', v_rows;
  END IF;
END $$;
commit;
\echo 'ok - the rollbacks restore admin_spend (callable, 10 columns) and request_invite (4 args) with their grants'
