-- Runs after every migration before 20261109170000 has been applied, and before it.
-- It proves the precondition the test exists for: the database already holds the
-- previous admin_spend(), with its ten columns and its grants, so the trial migration
-- is applied over a real predecessor rather than into an empty schema.

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_cols integer;
BEGIN
  IF to_regprocedure('public.admin_spend()') IS NULL THEN
    RAISE EXCEPTION 'not ok - precondition: admin_spend() does not exist before the trial migration';
  END IF;

  SELECT count(*) INTO v_cols
    FROM pg_proc p, unnest(p.proargmodes) m
   WHERE p.oid = 'public.admin_spend()'::regprocedure AND m = 't';
  IF v_cols <> 10 THEN
    RAISE EXCEPTION 'not ok - precondition: admin_spend() has % result columns, expected 10', v_cols;
  END IF;

  IF to_regprocedure('public.request_invite(text,text,boolean,text)') IS NULL THEN
    RAISE EXCEPTION 'not ok - precondition: the four-argument request_invite does not exist';
  END IF;
END $$;
\echo 'ok - the previous admin_spend (10 columns) and request_invite (4 args) exist before the trial migration'
