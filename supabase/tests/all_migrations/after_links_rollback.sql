-- After rolling back 20261110120000 alone: trial_scan_start is the three-argument function
-- again, with its grant, and the link functions and columns are gone.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF to_regprocedure('public.trial_scan_start(text,text,text,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'not ok - after rollback the four-argument trial_scan_start remains';
  END IF;
  IF to_regprocedure('public.trial_scan_start(text,text,text)') IS NULL
     OR NOT has_function_privilege('anon', 'public.trial_scan_start(text,text,text)', 'execute') THEN
    RAISE EXCEPTION 'not ok - after rollback the three-argument trial_scan_start is missing or not granted to anon';
  END IF;
  IF to_regprocedure('public.trial_link_status(text,text,integer)') IS NOT NULL
     OR to_regprocedure('public.admin_trial_link_issue(text,text)') IS NOT NULL
     OR to_regprocedure('public.admin_trial_links(text[])') IS NOT NULL THEN
    RAISE EXCEPTION 'not ok - after rollback a link function remains';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.trial_users'::regclass
       AND attname IN ('token_version', 'link_sent_at') AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'not ok - after rollback trial_users keeps a link column';
  END IF;
END $$;
\echo 'ok - the links rollback restores the three-argument trial_scan_start with its grant'
