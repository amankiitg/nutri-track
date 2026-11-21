-- The evidence rules, planted rather than measured on anybody's account.
--
-- Three accounts, each in the shape the platform actually writes:
--
--   magic link   an email identity, a bcrypt shaped hash GoTrue wrote for an OTP user, no session,
--                no profile row. Must answer link_only: the hash is not evidence.
--   password     the same, plus a session with an mfa_amr_claim of 'password'. Must answer
--                has_password, which is what the backfill reads.
--   settings     the same shape as the magic link account, plus profiles.has_password = true. Must
--                answer has_password too: GoTrue writes no amr claim for a password set in Settings.

DO $$
DECLARE
  v_email text := 'link.e2e@example.com';
  v_pw_email text := 'password.e2e@example.com';
  v_settings_email text := 'settings.e2e@example.com';
  v_id uuid;
  v_settings_id uuid;
  v_session uuid;
  v_state text;
BEGIN
  DELETE FROM auth.users WHERE email IN (v_email, v_pw_email, v_settings_email);

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

  -- The flag alone proves the password door opens, without a session: what Settings writes.
  INSERT INTO public.profiles (user_id, display_name, dob, sex, height_cm, weight_kg,
                              activity_level, goal, has_password)
  VALUES (v_id, 'Settings', '1994-01-01', 'female', 165, 70, 'moderately_active', 'lose', true)
  ON CONFLICT (user_id) DO UPDATE SET has_password = true;
  v_state := public.auth_entry_state(v_email);
  IF v_state <> 'has_password' THEN
    RAISE EXCEPTION 'not ok - profiles.has_password answered %', v_state;
  END IF;
  DELETE FROM public.profiles WHERE user_id = v_id;

  -- 2. The amr claim: a real session whose authentication method was a password.
  INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, last_sign_in_at)
  VALUES (gen_random_uuid(), v_pw_email, '$2a$10$' || repeat('y', 53), now(), now())
  RETURNING id INTO v_settings_id;
  INSERT INTO auth.identities (user_id, provider, provider_id, identity_data)
  VALUES (v_settings_id, 'email', v_settings_id::text, jsonb_build_object('email', v_pw_email));
  INSERT INTO auth.sessions (id, user_id) VALUES (gen_random_uuid(), v_settings_id)
  RETURNING id INTO v_session;
  INSERT INTO auth.mfa_amr_claims (id, session_id, authentication_method)
  VALUES (gen_random_uuid(), v_session, 'password');

  v_state := public.auth_entry_state(v_pw_email);
  IF v_state <> 'has_password' THEN
    RAISE EXCEPTION 'not ok - an amr claim of password answered %', v_state;
  END IF;

  -- A Google identity beside it: both doors, and the state still says password.
  INSERT INTO auth.identities (user_id, provider, provider_id, identity_data)
  VALUES (v_settings_id, 'google', v_settings_id::text, jsonb_build_object('email', v_pw_email));
  v_state := public.auth_entry_state(v_pw_email);
  IF v_state <> 'has_password_google' THEN
    RAISE EXCEPTION 'not ok - a password account with Google answered %', v_state;
  END IF;

  -- 3. A session that authenticated by otp is not evidence of a password.
  DELETE FROM auth.mfa_amr_claims WHERE session_id = v_session;
  INSERT INTO auth.mfa_amr_claims (id, session_id, authentication_method)
  VALUES (gen_random_uuid(), v_session, 'otp');
  v_state := public.auth_entry_state(v_pw_email);
  IF v_state <> 'link_only_google' THEN
    RAISE EXCEPTION 'not ok - an otp session answered %', v_state;
  END IF;

  DELETE FROM auth.users WHERE email IN (v_email, v_pw_email, v_settings_email);
END $$;

\echo 'ok - a magic link account is link_only, an amr password claim and profiles.has_password both mean has_password, and Google adds has_password_google'