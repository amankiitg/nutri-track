-- The counters: seven numbers, each row counted once, and the first error kept.
--
-- Runs after after_email_sync.sql, which planted the accounts and the Vault secret, so the list
-- already has rows and the record call can be checked against a real state row.

DO $$
DECLARE
  v_summary jsonb;
  v_secret text := 'email-sync-secret-for-tests';
  v_admin uuid := gen_random_uuid();
BEGIN
  -- The summary is admin only, so this test is one: the claim is what the function reads.
  INSERT INTO auth.users (id, email) VALUES (v_admin, 'counters-admin@one.test');
  INSERT INTO public.admins (user_id) VALUES (v_admin);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  -- A finished run: 12 checked, of which 2 were new, 8 already in step, 1 had a name filled in,
  -- and 1 was refused. 2 + 8 + 1 = 11, and the refused one is the twelfth: every checked row lands
  -- in exactly one of added, already, names or failed.
  PERFORM public.email_sync_record(
    v_secret, 12, 2, 8, 1, 1, 5, 3,
    'Resend contact create failed (422)'
  );

  v_summary := public.admin_email_sync_summary();

  IF (v_summary ->> 'checked')::integer <> 12 THEN
    RAISE EXCEPTION 'not ok - checked answered %', v_summary ->> 'checked';
  END IF;
  IF (v_summary ->> 'added')::integer <> 2
     OR (v_summary ->> 'already')::integer <> 8
     OR (v_summary ->> 'names')::integer <> 1
     OR (v_summary ->> 'failed')::integer <> 1 THEN
    RAISE EXCEPTION 'not ok - the buckets answered %', v_summary;
  END IF;
  IF v_summary ->> 'first_error' <> 'Resend contact create failed (422)' THEN
    RAISE EXCEPTION 'not ok - the first error answered %', v_summary ->> 'first_error';
  END IF;
  -- The two totals are the database's own count of the list, not of the run.
  IF (v_summary ->> 'excluded')::integer <> 5
     OR (v_summary ->> 'unsubscribed')::integer <> 3 THEN
    RAISE EXCEPTION 'not ok - the totals answered %', v_summary;
  END IF;

  -- A second run with nothing to do says so rather than leaving the old numbers behind.
  PERFORM public.email_sync_record(v_secret, 11, 0, 11, 0, 0, 5, 3, NULL);
  v_summary := public.admin_email_sync_summary();
  IF (v_summary ->> 'checked')::integer <> 11
     OR (v_summary ->> 'added')::integer <> 0
     OR (v_summary ->> 'already')::integer <> 11
     OR v_summary ->> 'first_error' IS NOT NULL THEN
    RAISE EXCEPTION 'not ok - an idle run answered %', v_summary;
  END IF;
  DELETE FROM public.admins WHERE user_id = v_admin;
  DELETE FROM auth.users WHERE id = v_admin;
END $$;

\echo 'ok - the sync records seven counters, each checked row in one bucket, and the first error'