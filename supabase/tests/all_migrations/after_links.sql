-- Personal trial links (20261110120000), after every migration. Synthetic rows only.

\set ON_ERROR_STOP on

insert into vault.decrypted_secrets (name, decrypted_secret)
values ('trial_server_secret', 'links-secret') on conflict (name) do nothing;
update vault.decrypted_secrets set decrypted_secret = 'links-secret' where name = 'trial_server_secret';

-- Shapes and grants.
DO $$
BEGIN
  IF to_regprocedure('public.trial_scan_start(text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'not ok - the three-argument trial_scan_start is still there';
  END IF;
  IF NOT has_function_privilege('anon', 'public.trial_scan_start(text,text,text,integer)', 'execute')
     OR NOT has_function_privilege('anon', 'public.trial_link_status(text,text,integer)', 'execute') THEN
    RAISE EXCEPTION 'not ok - anon cannot execute the secret-gated trial functions';
  END IF;
  IF has_function_privilege('anon', 'public.admin_trial_link_issue(text,text)', 'execute')
     OR has_function_privilege('anon', 'public.admin_trial_link_revoke(text)', 'execute')
     OR has_function_privilege('anon', 'public.admin_trial_links(text[])', 'execute')
     OR has_function_privilege('anon', 'public.admin_trial_link_mark_sent(text)', 'execute') THEN
    RAISE EXCEPTION 'not ok - anon may execute an admin trial-link function';
  END IF;
END $$;

-- An invited address with no account, and a member who is not the admin.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b1', 'links-admin@example.com'),
  ('00000000-0000-0000-0000-0000000000b2', 'links-member@example.com');
insert into public.admins (user_id) values ('00000000-0000-0000-0000-0000000000b1') on conflict do nothing;
insert into public.allowed_emails (email) values ('invited.friend@gmail.com') on conflict do nothing;
update public.trial_settings set scans_limit = 10, daily_budget = 200;
delete from public.llm_calls where trial;

-- The admin issues a link: the row exists, version 0, the name kept, nothing marked yet.
begin;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
DO $$
DECLARE
  v jsonb;
  n integer;
BEGIN
  v := public.admin_trial_link_issue('Invited.Friend+news@gmail.com', 'Priya');
  IF v->>'email' <> 'invitedfriend@gmail.com' OR (v->>'token_version')::int <> 0 OR v->>'first_name' <> 'Priya' THEN
    RAISE EXCEPTION 'not ok - issue returned %', v;
  END IF;
  SELECT count(*) INTO n FROM public.admin_trial_links(ARRAY['invited.friend@gmail.com']);
  IF n <> 0 THEN RAISE EXCEPTION 'not ok - a link shows as sent before it was marked'; END IF;

  PERFORM public.admin_trial_link_mark_sent('invited.friend@gmail.com');
  SELECT count(*) INTO n FROM public.admin_trial_links(ARRAY['invited.friend@gmail.com', 'nobody@example.com']);
  IF n <> 1 THEN RAISE EXCEPTION 'not ok - admin_trial_links returned % rows, expected the one sent', n; END IF;
  PERFORM 1 FROM public.admin_trial_links(ARRAY['invited.friend@gmail.com']) l
   WHERE l.email = 'invited.friend@gmail.com' AND l.first_name = 'Priya' AND l.scans_limit = 10;
  IF NOT FOUND THEN RAISE EXCEPTION 'not ok - the sent row does not answer with the email as passed'; END IF;
END $$;
commit;
\echo 'ok - the admin issues a link (canonical row, version 0) and it shows as sent once marked'

-- A member who is not the admin cannot issue, revoke or read links.
begin;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
DO $$
DECLARE
  raised integer := 0;
BEGIN
  BEGIN PERFORM public.admin_trial_link_issue('x@example.com', null); EXCEPTION WHEN insufficient_privilege THEN raised := raised + 1; END;
  BEGIN PERFORM public.admin_trial_link_revoke('invited.friend@gmail.com'); EXCEPTION WHEN insufficient_privilege THEN raised := raised + 1; END;
  BEGIN PERFORM * FROM public.admin_trial_links(ARRAY['invited.friend@gmail.com']); EXCEPTION WHEN insufficient_privilege THEN raised := raised + 1; END;
  BEGIN PERFORM public.admin_trial_link_mark_sent('invited.friend@gmail.com'); EXCEPTION WHEN insufficient_privilege THEN raised := raised + 1; END;
  IF raised <> 4 THEN RAISE EXCEPTION 'not ok - a non-admin got through % of 4 admin trial-link functions', 4 - raised; END IF;
END $$;
commit;
\echo 'ok - a non-admin is refused every admin trial-link function'

-- The link works for the invited address, and spends from that mailbox's scans.
begin;
set local role anon;
DO $$
DECLARE
  v jsonb;
  raised boolean := false;
BEGIN
  BEGIN PERFORM public.trial_link_status('wrong', 'invited.friend@gmail.com', 0);
  EXCEPTION WHEN insufficient_privilege THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'not ok - trial_link_status accepted a wrong secret'; END IF;

  v := public.trial_link_status('links-secret', 'invited.friend@gmail.com', 0);
  IF v->>'status' <> 'ok' OR v->>'first_name' <> 'Priya' OR (v->>'scans_left')::int <> 10 THEN
    RAISE EXCEPTION 'not ok - a valid link for an invited address answered %', v;
  END IF;

  v := public.trial_scan_start('links-secret', 'invited.friend@gmail.com', '198.51.100.1', 0);
  IF v->>'status' <> 'ok' OR (v->>'scans_left')::int <> 9 THEN
    RAISE EXCEPTION 'not ok - a scan on a valid link answered %', v;
  END IF;

  -- The previous service build calls with three named arguments; it must still resolve.
  v := public.trial_scan_start(p_server_secret => 'links-secret', p_email => 'invited.friend@gmail.com', p_ip => '198.51.100.1');
  IF v->>'status' <> 'ok' THEN
    RAISE EXCEPTION 'not ok - a three-argument call answered %', v;
  END IF;

  v := public.trial_link_status('links-secret', 'never-issued@example.com', 0);
  IF v->>'status' <> 'invalid' THEN RAISE EXCEPTION 'not ok - an unknown mailbox answered %', v; END IF;
END $$;
commit;
\echo 'ok - a link works for an invited address with no account, and counts against its scans'

-- Revoke: the old version stops, the new one works.
begin;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
DO $$ BEGIN PERFORM public.admin_trial_link_revoke('invited.friend@gmail.com'); END $$;
commit;
begin;
set local role anon;
DO $$
DECLARE
  v jsonb;
BEGIN
  v := public.trial_link_status('links-secret', 'invited.friend@gmail.com', 0);
  IF v->>'status' <> 'revoked' THEN RAISE EXCEPTION 'not ok - a revoked link answered %', v; END IF;
  v := public.trial_scan_start('links-secret', 'invited.friend@gmail.com', '198.51.100.1', 0);
  IF v->>'status' <> 'revoked' THEN RAISE EXCEPTION 'not ok - a scan on a revoked link answered %', v; END IF;
  v := public.trial_link_status('links-secret', 'invited.friend@gmail.com', 1);
  IF v->>'status' <> 'ok' OR (v->>'scans_left')::int <> 8 THEN
    RAISE EXCEPTION 'not ok - the re-issued version answered %', v;
  END IF;
END $$;
commit;
\echo 'ok - revoking stops every token at the old version, and a new link works'

-- The daily budget still applies to a link.
update public.trial_settings set daily_budget = (select count(*) from public.llm_calls where trial);
begin;
set local role anon;
DO $$
DECLARE
  v jsonb;
BEGIN
  v := public.trial_scan_start('links-secret', 'invited.friend@gmail.com', '198.51.100.2', 1);
  IF v->>'status' <> 'busy' THEN RAISE EXCEPTION 'not ok - a link scan over the daily budget answered %', v; END IF;
END $$;
commit;
update public.trial_settings set daily_budget = 200;
\echo 'ok - the daily trial budget still applies to a link'

-- Once the address has an account, the link and its scans still work: the "already have
-- access" wall is gone, so an invited address that already signed up can still preview.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000b3', 'InvitedFriend@gmail.com');
begin;
set local role anon;
DO $$
DECLARE
  v jsonb;
BEGIN
  v := public.trial_link_status('links-secret', 'invited.friend@gmail.com', 1);
  IF v->>'status' <> 'ok' OR (v->>'invited')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'not ok - a link for an account answered %', v;
  END IF;
  v := public.trial_scan_start('links-secret', 'invited.friend@gmail.com', '198.51.100.1', 1);
  IF v->>'status' <> 'ok' THEN RAISE EXCEPTION 'not ok - a scan for an account answered %', v; END IF;
END $$;
commit;
\echo 'ok - an account can still preview with a link, and the link says the address is invited'

-- An invited address typed on /try now gets a code and a trial, with the invited flag, not
-- an "already access" refusal.
insert into public.allowed_emails (email) values ('typed.invite@example.com') on conflict do nothing;
begin;
set local role anon;
DO $$
DECLARE
  v jsonb;
BEGIN
  v := public.trial_send_code('links-secret', 'typed.invite@example.com', null, '198.51.100.9');
  IF v->>'status' <> 'sent' OR (v->>'invited')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'not ok - /try for an invited address answered %', v;
  END IF;
END $$;
commit;
\echo 'ok - typing an invited address on /try sends a code with the invited flag'

-- One counter per person: the code route and the /t/ link spend from the same trial_users
-- row. admin_trial_link_issue creates the row; trial_send_code reuses it (on conflict), so
-- a scan before and after the code was sent decrements one count, not two.
begin;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
DO $$ BEGIN PERFORM public.admin_trial_link_issue('Shared@Example.com', null); END $$;
commit;
begin;
set local role anon;
DO $$
DECLARE
  v jsonb;
BEGIN
  v := public.trial_link_status('links-secret', 'shared@example.com', 0);
  IF v->>'status' <> 'ok' OR (v->>'scans_left')::int <> 10 THEN
    RAISE EXCEPTION 'not ok - the shared row did not start at 10 scans: %', v;
  END IF;

  v := public.trial_send_code('links-secret', 'shared@example.com', null, '198.51.100.7');
  IF v->>'status' <> 'sent' THEN RAISE EXCEPTION 'not ok - code for the shared address answered %', v; END IF;

  -- Two scans, one count: the first leaves 9 and the second 8, not 9 and 9.
  v := public.trial_scan_start('links-secret', 'shared@example.com', '198.51.100.7', 0);
  IF v->>'status' <> 'ok' OR (v->>'scans_left')::int <> 9 THEN
    RAISE EXCEPTION 'not ok - first shared scan answered %', v;
  END IF;
  v := public.trial_scan_start('links-secret', 'shared@example.com', '198.51.100.7', 0);
  IF v->>'status' <> 'ok' OR (v->>'scans_left')::int <> 8 THEN
    RAISE EXCEPTION 'not ok - second shared scan answered %', v;
  END IF;
END $$;
commit;
\echo 'ok - the code and link routes share one trial_users row (one scan counter)'
