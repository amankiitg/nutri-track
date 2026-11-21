-- Open sign-ups, post login (20261120180000).
--
-- Runs after after_global_cap.sql. The proofs are about the two functions every downstream gate
-- reads, and about the trigger that stops a request being recorded while the switch is on.

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_state text;
BEGIN
  -- Closed: the old answer. The list is not empty in this fixture, so a stranger is refused.
  UPDATE public.app_settings SET open_signups = false WHERE id;
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000d1","email":"postlogin-stranger@example.com","role":"authenticated"}', true);
  IF public.is_email_allowed() THEN
    RAISE EXCEPTION 'not ok - a stranger passed the gate with sign-ups closed';
  END IF;
  IF public.check_email_allowed('postlogin-stranger@example.com') THEN
    RAISE EXCEPTION 'not ok - check_email_allowed let a stranger through with sign-ups closed';
  END IF;

  -- Open: the same call passes, which is what lets a new account reach onboarding.
  UPDATE public.app_settings SET open_signups = true WHERE id;
  IF NOT public.is_email_allowed() THEN
    RAISE EXCEPTION 'not ok - a stranger was refused with sign-ups open';
  END IF;
  IF NOT public.check_email_allowed('postlogin-stranger@example.com') THEN
    RAISE EXCEPTION 'not ok - check_email_allowed refused a stranger with sign-ups open';
  END IF;

  -- An invited address is unaffected either way.
  INSERT INTO public.allowed_emails (email) VALUES ('postlogin-invited@example.com')
  ON CONFLICT DO NOTHING;
  IF NOT public.check_email_allowed('postlogin-invited@example.com') THEN
    RAISE EXCEPTION 'not ok - an invited address was refused';
  END IF;
  DELETE FROM public.allowed_emails WHERE email = 'postlogin-invited@example.com';

  -- No request is recorded while the switch is on.
  DELETE FROM public.invite_requests WHERE email = 'postlogin-request@example.com';
  INSERT INTO public.invite_requests (email, status) VALUES ('postlogin-request@example.com', 'pending');
  IF EXISTS (SELECT 1 FROM public.invite_requests r WHERE r.email = 'postlogin-request@example.com') THEN
    RAISE EXCEPTION 'not ok - a request was recorded while sign-ups were open';
  END IF;

  -- And with the switch off the trigger steps aside, so the ordinary flow still records one.
  UPDATE public.app_settings SET open_signups = false WHERE id;
  INSERT INTO public.invite_requests (email, status) VALUES ('postlogin-request@example.com', 'pending');
  IF NOT EXISTS (SELECT 1 FROM public.invite_requests r WHERE r.email = 'postlogin-request@example.com') THEN
    RAISE EXCEPTION 'not ok - a request was not recorded with sign-ups closed';
  END IF;

  DELETE FROM public.invite_requests WHERE email = 'postlogin-request@example.com';
  UPDATE public.app_settings SET open_signups = true WHERE id;
END $$;

\echo 'ok - the post-login gates follow the switch, and no request is recorded while it is on'
