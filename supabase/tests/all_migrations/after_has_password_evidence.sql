-- The flag is the only evidence, planted rather than measured on anybody's account.
--
-- Four accounts, in the shapes the platform actually writes:
--
--   magic link   an email identity, the bcrypt shaped hash GoTrue writes for an OTP user, no
--                session, no profile row. Must answer link_only: the hash is not evidence.
--   amr claim    the same, plus a session whose claims include authentication_method = 'password'.
--                Must STILL answer link_only: measured on this stack, GoTrue writes that claim for
--                a session established by an emailed link, so it distinguishes nothing. This is the
--                regression test for the rule this migration replaces.
--   settings     the same shape, plus profiles.has_password = true, which is what Settings writes.
--                Must answer has_password.
--   google       a Google identity only. Must answer google_only.

DO $$
DECLARE
  v_email text := 'link.e2e@example.com';
  v_amr_email text := 'amr.e2e@example.com';
  v_flag_email text := 'flag.e2e@example.com';
  v_google_email text := 'google.e2e@example.com';
  v_id uuid;
  v_amr_id uuid;
  v_flag_id uuid;
  v_google_id uuid;
  v_session uuid;
  v_state text;
BEGIN
  DELETE FROM auth.users WHERE email IN (v_email, v_amr_email, v_flag_email, v_google_email);

  -- 1. The magic link account: a 60 character bcrypt shaped hash, an email identity, no session.
  INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, last_sign_in_at)
  VALUES (gen_random_uuid(), v_email, '$2a$10$' || repeat('x', 53), NULL, NULL)
  RETURNING id INTO v_id;
  INSERT INTO auth.identities (user_id, provider, provider_id, identity_data)
  VALUES (v_id, 'email', v_id::text, jsonb_build_object('email', v_email));

  v_state := public.auth_entry_state(v_email);
  IF v_state <> 'link_only' THEN
    RAISE EXCEPTION 'not ok - a magic link account answered %', v_state;
  END IF;

  -- 2. The amr claim that used to be trusted, and is not evidence.
  INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, last_sign_in_at)
  VALUES (gen_random_uuid(), v_amr_email, '$2a$10$' || repeat('y', 53), now(), now())
  RETURNING id INTO v_amr_id;
  INSERT INTO auth.identities (user_id, provider, provider_id, identity_data)
  VALUES (v_amr_id, 'email', v_amr_id::text, jsonb_build_object('email', v_amr_email));
  INSERT INTO auth.sessions (id, user_id) VALUES (gen_random_uuid(), v_amr_id)
  RETURNING id INTO v_session;
  INSERT INTO auth.mfa_amr_claims (id, session_id, authentication_method)
  VALUES (gen_random_uuid(), v_session, 'password');

  v_state := public.auth_entry_state(v_amr_email);
  IF v_state <> 'link_only' THEN
    RAISE EXCEPTION 'not ok - an amr claim of password answered %', v_state;
  END IF;

  -- 3. The flag, which is the evidence the app records.
  INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, last_sign_in_at)
  VALUES (gen_random_uuid(), v_flag_email, '$2a$10$' || repeat('z', 53), NULL, NULL)
  RETURNING id INTO v_flag_id;
  INSERT INTO auth.identities (user_id, provider, provider_id, identity_data)
  VALUES (v_flag_id, 'email', v_flag_id::text, jsonb_build_object('email', v_flag_email));
  INSERT INTO public.profiles (user_id, display_name, dob, sex, height_cm, weight_kg,
                              activity_level, goal, has_password)
  VALUES (v_flag_id, 'Flag', '1994-01-01', 'female', 165, 70, 'moderately_active', 'lose', true);

  v_state := public.auth_entry_state(v_flag_email);
  IF v_state <> 'has_password' THEN
    RAISE EXCEPTION 'not ok - profiles.has_password answered %', v_state;
  END IF;

  -- A Google identity beside it: both doors, and the state still says password.
  INSERT INTO auth.identities (user_id, provider, provider_id, identity_data)
  VALUES (v_flag_id, 'google', v_flag_id::text, jsonb_build_object('email', v_flag_email));
  v_state := public.auth_entry_state(v_flag_email);
  IF v_state <> 'has_password_google' THEN
    RAISE EXCEPTION 'not ok - a password account with Google answered %', v_state;
  END IF;

  -- The flag alone decides: clearing it puts the same account back on the link.
  UPDATE public.profiles SET has_password = false WHERE user_id = v_flag_id;
  v_state := public.auth_entry_state(v_flag_email);
  IF v_state <> 'link_only_google' THEN
    RAISE EXCEPTION 'not ok - a cleared flag answered %', v_state;
  END IF;

  -- 4. Google and no email identity at all.
  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES (gen_random_uuid(), v_google_email, now())
  RETURNING id INTO v_google_id;
  INSERT INTO auth.identities (user_id, provider, provider_id, identity_data)
  VALUES (v_google_id, 'google', v_google_id::text, jsonb_build_object('email', v_google_email));

  v_state := public.auth_entry_state(v_google_email);
  IF v_state <> 'google_only' THEN
    RAISE EXCEPTION 'not ok - a Google only account answered %', v_state;
  END IF;

  DELETE FROM auth.users WHERE id IN (v_id, v_amr_id, v_flag_id, v_google_id);
END $$;

\echo 'ok - the flag is the only password evidence: a hash is not, an amr claim is not, and clearing the flag puts the account back on the link'