-- The mailing list read: dedupe, the two exclusion rules, the switch, paging, and the gate.
--
-- Every row here is synthetic. The addresses use .test domains, except the two that
-- are meant to be excluded by the example.com rule, and one spelling of a seeded
-- exclusion so the stored list is exercised and not only described.

insert into vault.decrypted_secrets (name, decrypted_secret)
values ('email_sync_server_secret', 'email-sync-secret-for-tests')
on conflict (name) do update set decrypted_secret = excluded.decrypted_secret;

DO $$
DECLARE
  v_aman uuid := gen_random_uuid();
  v_second uuid := gen_random_uuid();
  v_pattern uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_count integer;
  v_test_row text;
  v_second_product boolean;
  v_aman_name text;
  v_counts jsonb;
  v_before jsonb;
  v_summary jsonb;
  v_after text;
  v_refused boolean := false;
BEGIN
  -- Other test files in this script leave synthetic accounts behind, so the counts
  -- are compared with the numbers before the fixtures below rather than to an
  -- absolute total. The deltas are what this migration is responsible for.
  v_before := public.email_sync_counts('email-sync-secret-for-tests');

  -- The account, spelled with dots and a plus tag on googlemail.com. The invite list
  -- holds the plain gmail spelling of the same inbox: one contact, not two.
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (v_aman, 'Aman.Kesarwani+notes@googlemail.com', jsonb_build_object('given_name', 'Aman'));
  INSERT INTO public.profiles (user_id, display_name, dob, sex, height_cm, weight_kg,
                              activity_level, goal, product_emails)
  VALUES (v_aman, 'Aman Kesarwani', '1994-01-01', 'male', 180, 80, 'moderately_active', 'lose', true);
  INSERT INTO public.allowed_emails (email) VALUES ('amankesarwani@gmail.com');

  -- A person who turned product mail off. The sync must see false, not the default.
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (v_second, 'second@two.test', jsonb_build_object('full_name', 'Second Person'));
  INSERT INTO public.profiles (user_id, display_name, dob, sex, height_cm, weight_kg,
                              activity_level, goal, product_emails)
  VALUES (v_second, 'Second Person', '1990-05-05', 'female', 165, 60, 'lightly_active', 'maintain', false);

  -- Invited, no account yet. Eligible, with no first name.
  INSERT INTO public.allowed_emails (email) VALUES ('invitee@three.test');

  -- Rule 2: one of the five seeded exclusions, typed with a capital letter.
  INSERT INTO public.allowed_emails (email) VALUES ('Test@Gmail.com');

  -- Rule 3: an account and an invite at example.com.
  INSERT INTO auth.users (id, email)
  VALUES (v_pattern, 'pattern@example.com');
  INSERT INTO public.allowed_emails (email) VALUES ('pattern.invite@example.com');

  -- The seed itself.
  SELECT cardinality(email_sync_exclude) INTO v_count
    FROM public.app_settings WHERE id = true;
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'not ok - the exclusion seed holds % entries, wanted 5', v_count;
  END IF;

  -- The gate, before anything else: a wrong secret is refused with 42501.
  BEGIN
    PERFORM public.email_sync_page('not-the-secret', NULL, 100);
  EXCEPTION WHEN insufficient_privilege THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'not ok - a wrong secret was accepted';
  END IF;

  -- Each fixture appears once, and the three spellings of one Gmail inbox do not
  -- become three rows.
  SELECT count(*) INTO v_count
    FROM public.email_sync_page('email-sync-secret-for-tests', NULL, 100) c
   WHERE c.canonical IN (
     'amankesarwani@gmail.com',
     'second@two.test',
     'invitee@three.test'
   );
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'not ok - the three fixtures produced % page rows', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM public.email_sync_page('email-sync-secret-for-tests', NULL, 100) c
   WHERE c.canonical = 'amankesarwani@gmail.com';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'not ok - one Gmail inbox produced % contacts', v_count;
  END IF;

  SELECT c.email INTO v_test_row
    FROM public.email_sync_page('email-sync-secret-for-tests', NULL, 100) c
   WHERE c.canonical = 'amankesarwani@gmail.com';
  IF v_test_row IS NULL THEN
    RAISE EXCEPTION 'not ok - the deduped Gmail address is missing';
  END IF;
  IF v_test_row <> 'aman.kesarwani+notes@googlemail.com' THEN
    RAISE EXCEPTION 'not ok - the dedupe chose the invite spelling (%) over the account spelling', v_test_row;
  END IF;

  SELECT c.first_name INTO v_aman_name
    FROM public.email_sync_page('email-sync-secret-for-tests', NULL, 100) c
   WHERE c.canonical = 'amankesarwani@gmail.com';
  IF v_aman_name <> 'Aman' THEN
    RAISE EXCEPTION 'not ok - the first name came back as %', coalesce(v_aman_name, 'null');
  END IF;

  SELECT c.product_emails INTO v_second_product
    FROM public.email_sync_page('email-sync-secret-for-tests', NULL, 100) c
   WHERE c.canonical = 'second@two.test';
  IF v_second_product IS NOT FALSE THEN
    RAISE EXCEPTION 'not ok - a profile with product_emails false came back as %',
      coalesce(v_second_product::text, 'null');
  END IF;

  -- Neither exclusion rule may leak a row, however it is spelled.
  SELECT count(*) INTO v_count
    FROM public.email_sync_page('email-sync-secret-for-tests', NULL, 100) c
   WHERE c.canonical IN (
     'test@gmail.com',
     'pattern@example.com',
     'pattern.invite@example.com',
     'amanbrilliant@gmail.com',
     'aman_kesarwani@mfe.berkeley.edu',
     'amankesarwani@berkeley.edu',
     'samudra.jayada@gmail.com'
   );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'not ok - % excluded address(es) were returned', v_count;
  END IF;

  -- Paging starts strictly after the value it is given, and a limit of one is one
  -- row. Which row is next depends on what earlier tests left behind, so the
  -- assertion is about the boundary, not about a particular address.
  SELECT count(*) INTO v_count
    FROM public.email_sync_page('email-sync-secret-for-tests', 'amankesarwani@gmail.com', 1) c;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'not ok - a one row page returned % rows', v_count;
  END IF;
  SELECT min(c.canonical) INTO v_after
    FROM public.email_sync_page('email-sync-secret-for-tests', 'amankesarwani@gmail.com', 100) c;
  IF v_after IS NULL OR v_after <= 'amankesarwani@gmail.com' THEN
    RAISE EXCEPTION 'not ok - the page after the first address began at %', coalesce(v_after, 'null');
  END IF;

  -- The deltas this migration is responsible for: three more eligible, three more
  -- excluded, one more unsubscribed. Counts never name anybody.
  v_counts := public.email_sync_counts('email-sync-secret-for-tests');
  IF (v_counts ->> 'eligible')::integer - (v_before ->> 'eligible')::integer <> 3 THEN
    RAISE EXCEPTION 'not ok - eligible moved by %',
      (v_counts ->> 'eligible')::integer - (v_before ->> 'eligible')::integer;
  END IF;
  IF (v_counts ->> 'excluded')::integer - (v_before ->> 'excluded')::integer <> 3 THEN
    RAISE EXCEPTION 'not ok - excluded moved by %',
      (v_counts ->> 'excluded')::integer - (v_before ->> 'excluded')::integer;
  END IF;
  IF (v_counts ->> 'unsubscribed')::integer - (v_before ->> 'unsubscribed')::integer <> 1 THEN
    RAISE EXCEPTION 'not ok - unsubscribed moved by %',
      (v_counts ->> 'unsubscribed')::integer - (v_before ->> 'unsubscribed')::integer;
  END IF;

  -- A run records what it did, and the admin read returns it.
  PERFORM public.email_sync_record('email-sync-secret-for-tests', 3, 3, 1);

  INSERT INTO auth.users (id, email) VALUES (v_admin, 'admin@one.test');
  INSERT INTO public.admins (user_id) VALUES (v_admin);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  v_summary := public.admin_email_sync_summary();
  IF (v_summary ->> 'contacts')::integer <> 3
     OR (v_summary ->> 'excluded')::integer <> 3
     OR (v_summary ->> 'unsubscribed')::integer <> 1
     OR v_summary ->> 'last_sync_at' IS NULL THEN
    RAISE EXCEPTION 'not ok - the admin summary read %', v_summary::text;
  END IF;

  -- And refuses a caller who is not an admin.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    PERFORM public.admin_email_sync_summary();
    RAISE EXCEPTION 'not ok - a non-admin read the summary';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  DELETE FROM public.allowed_emails
   WHERE email IN (
     'amankesarwani@gmail.com',
     'Test@Gmail.com',
     'invitee@three.test',
     'pattern.invite@example.com'
   );
  DELETE FROM auth.users WHERE id IN (v_aman, v_second, v_pattern, v_admin);
  DELETE FROM public.admins WHERE user_id = v_admin;
  DELETE FROM public.email_sync_state WHERE id = true;
  INSERT INTO public.email_sync_state (id) VALUES (true);
END $$;

\echo 'ok - the mailing list read dedupes Gmail spellings, excludes the stored list and example.com, and reports its counts'
