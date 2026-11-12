-- After rolling back 20261112120000 alone: the list is gone, the source column is
-- gone, and admin_trial_link_issue is the version that predates both.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF to_regprocedure('public.admin_trial_list(text,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'not ok - after rollback admin_trial_list remains';
  END IF;
  IF to_regprocedure('public.admin_trial_link_issue(text,text)') IS NULL THEN
    RAISE EXCEPTION 'not ok - after rollback admin_trial_link_issue is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.trial_users'::regclass
       AND attname = 'source' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'not ok - after rollback trial_users keeps the source column';
  END IF;
END $$;

-- And the restored function still works for the admin: a rollback that leaves a
-- function failing at call time is not a rollback.
begin;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b1","email":"links-admin@example.com","role":"authenticated"}';
DO $$
DECLARE
  v jsonb;
BEGIN
  v := public.admin_trial_link_issue('Rollback.Check@Example.com', 'Roll');
  IF v->>'email' <> 'rollback.check@example.com' THEN
    RAISE EXCEPTION 'not ok - the restored admin_trial_link_issue answered %', v;
  END IF;
END $$;
commit;
\echo 'ok - the rollback drops admin_trial_list and source, and restores admin_trial_link_issue'
