-- Open sign-ups (20261120130000), after every migration. Synthetic addresses only.
--
-- Runs after after_funnel.sql, so the funnel tables and the Vault secret already exist, and
-- after after_no_food.sql added its own event to the allowlist. Every address below is made up;
-- nothing here reads a row belonging to anyone.

\set ON_ERROR_STOP on

-- The table, the switch's default, and both answers it produces.
DO $$
DECLARE
  v_state text;
  v_invited text;
BEGIN
  IF to_regclass('public.app_settings') IS NULL THEN
    RAISE EXCEPTION 'not ok - app_settings is missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.app_settings'::regclass) THEN
    RAISE EXCEPTION 'not ok - app_settings has RLS off';
  END IF;
  IF has_table_privilege('anon', 'public.app_settings', 'select')
     OR has_table_privilege('authenticated', 'public.app_settings', 'select') THEN
    RAISE EXCEPTION 'not ok - a caller role can read the settings row directly';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.app_settings', 'select') THEN
    RAISE EXCEPTION 'not ok - service_role cannot read the settings row';
  END IF;
  IF NOT has_function_privilege('anon', 'public.open_signups()', 'execute') THEN
    RAISE EXCEPTION 'not ok - anon cannot read the switch';
  END IF;

  IF NOT public.open_signups() THEN
    RAISE EXCEPTION 'not ok - sign-ups do not default to open';
  END IF;

  -- Open: a stranger is offered an account.
  v_state := public.auth_entry_state('stranger-' || gen_random_uuid() || '@example.com');
  IF v_state <> 'open_signup' THEN
    RAISE EXCEPTION 'not ok - a stranger got % with sign-ups open', v_state;
  END IF;

  -- An invited address with no account is still an invite, open or closed.
  INSERT INTO public.allowed_emails (email)
  VALUES ('invited-' || gen_random_uuid() || '@example.com')
  RETURNING lower(email) INTO v_invited;
  v_state := public.auth_entry_state(v_invited);
  IF v_state <> 'invited_new' THEN
    RAISE EXCEPTION 'not ok - an invited address got % with sign-ups open', v_state;
  END IF;

  -- Closed: the same kind of stranger is back to not invited, which is the old behaviour.
  UPDATE public.app_settings SET open_signups = false WHERE id;
  v_state := public.auth_entry_state('stranger-' || gen_random_uuid() || '@example.com');
  IF v_state <> 'not_invited' THEN
    RAISE EXCEPTION 'not ok - a stranger got % with sign-ups closed', v_state;
  END IF;
  v_state := public.auth_entry_state(v_invited);
  IF v_state <> 'invited_new' THEN
    RAISE EXCEPTION 'not ok - an invited address got % with sign-ups closed', v_state;
  END IF;
  UPDATE public.app_settings SET open_signups = true WHERE id;

  DELETE FROM public.allowed_emails WHERE email = v_invited;
END $$;
\echo 'ok - the switch defaults open, and both answers change with it'

-- The counts: refused to a signed-in non-admin.
begin;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-4000-8000-0000000000b2","email":"member@example.com","role":"authenticated"}';
DO $$
DECLARE
  raised boolean := false;
BEGIN
  BEGIN PERFORM public.admin_signup_counts();
  EXCEPTION WHEN insufficient_privilege THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'not ok - a non-admin read the sign-up counts'; END IF;
END $$;
commit;

-- And answered to the admin, with all three numbers.
begin;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b1","email":"links-admin@example.com","role":"authenticated"}';
DO $$
DECLARE
  v jsonb;
BEGIN
  v := public.admin_signup_counts();
  IF NOT (v ? 'today') OR NOT (v ? 'week') OR NOT (v ? 'total') THEN
    RAISE EXCEPTION 'not ok - sign-up counts are missing a field: %', v;
  END IF;
  IF (v ->> 'total')::integer < (v ->> 'week')::integer THEN
    RAISE EXCEPTION 'not ok - the total is smaller than the week: %', v;
  END IF;
  v := public.admin_trial_funnel(7);
  IF NOT (v -> 'today') ? 'signup_started' OR NOT (v -> 'today') ? 'signup_completed' THEN
    RAISE EXCEPTION 'not ok - the funnel read omits a sign-up step: %', v -> 'today';
  END IF;
END $$;
commit;
\echo 'ok - sign-up counts are admin-only and land beside the funnel steps'

-- The two new steps are on the allowlist, and are capped like the other browser events.
DO $$
BEGIN
  IF public.trial_funnel_log('signup_started', '203.0.113.9', 'links-secret')->>'status' <> 'ok' THEN
    RAISE EXCEPTION 'not ok - signup_started was not recorded';
  END IF;
  IF public.trial_funnel_log('signup_completed', '203.0.113.9', 'links-secret')->>'status' <> 'ok' THEN
    RAISE EXCEPTION 'not ok - signup_completed was not recorded';
  END IF;

  DELETE FROM public.trial_funnel_daily WHERE event IN ('signup_started', 'signup_completed');
  DELETE FROM public.trial_funnel_ip_daily WHERE event IN ('signup_started', 'signup_completed');
END $$;
\echo 'ok - the two sign-up funnel steps are recorded'
