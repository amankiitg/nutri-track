-- The account shape a magic link actually leaves, and what the answer must be.
--
-- Measured on a real account created by a magic link: `encrypted_password` holds a 60-character
-- bcrypt hash, `email_confirmed_at` is null because the mail was never opened, `last_sign_in_at` is
-- null, and the only identity is `email`. This test plants exactly those values, with a made up
-- address, and asserts the answer is `link_only` rather than `has_password`.

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_state text;
  v_id uuid := gen_random_uuid();
  v_email text := 'magiclink-shape-' || gen_random_uuid() || '@example.com';
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data, raw_app_meta_data, encrypted_password, email_confirmed_at, last_sign_in_at)
  VALUES (v_id, v_email, '{}'::jsonb, '{"provider":"email","providers":["email"]}'::jsonb,
          -- 60 characters, the shape of a bcrypt hash. Not a real credential: it is never used to
          -- sign in, and the address cannot receive mail.
          '$2a$10$' || repeat('x', 53),
          NULL, NULL);

  INSERT INTO auth.identities (user_id, provider, provider_id, identity_data)
  VALUES (v_id, 'email', v_id::text, jsonb_build_object('email', v_email));

  v_state := public.auth_entry_state(v_email);
  IF v_state <> 'link_only' THEN
    RAISE EXCEPTION 'not ok - a magic-link account answered %', v_state;
  END IF;

  -- A Google identity beside it still answers the combined state.
  INSERT INTO auth.identities (user_id, provider, provider_id, identity_data)
  VALUES (v_id, 'google', v_id::text, jsonb_build_object('email', v_email));
  v_state := public.auth_entry_state(v_email);
  IF v_state <> 'link_only_google' THEN
    RAISE EXCEPTION 'not ok - a magic-link account with Google answered %', v_state;
  END IF;

  DELETE FROM auth.identities WHERE user_id = v_id;
  DELETE FROM auth.users WHERE id = v_id;
END $$;

\echo 'ok - a magic-link account resolves to link_only, and to link_only_google with Google attached'
