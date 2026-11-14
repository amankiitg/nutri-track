-- Anonymous trials (20261114120000), after every migration. Synthetic rows only.
--
-- Runs after after_fibre.sql, with the Vault secret planted by after_links.sql
-- ('links-secret'). The email-flow rows from earlier files stay in place so the admin
-- list test can prove both funnels still answer together.

\set ON_ERROR_STOP on

update vault.decrypted_secrets
   set decrypted_secret = 'links-secret'
 where name = 'trial_server_secret';

-- Shapes, RLS and grants.
DO $$
DECLARE
  v_cols text;
BEGIN
  IF to_regclass('public.trial_devices') IS NULL THEN
    RAISE EXCEPTION 'not ok - trial_devices does not exist';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.trial_devices'::regclass) THEN
    RAISE EXCEPTION 'not ok - trial_devices has RLS off';
  END IF;
  IF has_table_privilege('anon', 'public.trial_devices', 'select')
     OR has_table_privilege('authenticated', 'public.trial_devices', 'select') THEN
    RAISE EXCEPTION 'not ok - a caller role can read trial_devices';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.trial_devices', 'select') THEN
    RAISE EXCEPTION 'not ok - service_role cannot read trial_devices';
  END IF;

  SELECT string_agg(a.attname, ',') INTO v_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.trial_devices'::regclass
     AND a.attname IN ('id', 'token_version', 'scans_used', 'created_at', 'last_used_at', 'ip_hash')
     AND a.attnum > 0 AND NOT a.attisdropped;
  IF v_cols IS NULL OR v_cols <> 'id,token_version,scans_used,created_at,last_used_at,ip_hash' THEN
    RAISE EXCEPTION 'not ok - trial_devices columns are %', v_cols;
  END IF;

  IF to_regprocedure('public.trial_anon_start(text,text,uuid)') IS NULL
     OR to_regprocedure('public.trial_anon_scan_start(text,uuid,text,integer)') IS NULL THEN
    RAISE EXCEPTION 'not ok - an anonymous trial function is missing';
  END IF;
  IF NOT has_function_privilege('anon', 'public.trial_anon_start(text,text,uuid)', 'execute')
     OR NOT has_function_privilege('anon', 'public.trial_anon_scan_start(text,uuid,text,integer)', 'execute') THEN
    RAISE EXCEPTION 'not ok - anon cannot execute the anonymous trial functions';
  END IF;
  IF has_function_privilege('anon', 'public.admin_trial_stats()', 'execute') THEN
    RAISE EXCEPTION 'not ok - anon may execute admin_trial_stats()';
  END IF;
END $$;
\echo 'ok - trial_devices has RLS, no caller grant, and the two anon functions are gated and callable'

-- 1. Per-device: the settings limit, a reused device id, and the raw address is never stored.
update public.trial_settings set scans_limit = 2, daily_budget = 200;
delete from public.llm_calls where trial = true;
delete from public.trial_devices;

DO $$
DECLARE
  v_start jsonb;
  v_reissue jsonb;
  v_scan jsonb;
  v_id uuid;
  v_ip_hash text;
BEGIN
  v_start := public.trial_anon_start('links-secret', '192.0.2.10', null);
  IF v_start->>'status' <> 'ok' THEN
    RAISE EXCEPTION 'not ok - trial_anon_start answered %', v_start;
  END IF;
  v_id := (v_start->>'device_id')::uuid;
  IF v_id IS NULL OR (v_start->>'scans_left')::int <> 2 OR (v_start->>'scans_total')::int <> 2 THEN
    RAISE EXCEPTION 'not ok - trial_anon_start answered %', v_start;
  END IF;

  select d.ip_hash into v_ip_hash from public.trial_devices d where d.id = v_id;
  IF v_ip_hash = '192.0.2.10' OR v_ip_hash IS NULL THEN
    RAISE EXCEPTION 'not ok - the raw address was stored (ip_hash=%)', v_ip_hash;
  END IF;
  IF v_ip_hash <> public.trial_ip_hash('192.0.2.10') THEN
    RAISE EXCEPTION 'not ok - the stored ip_hash is not the salted hash';
  END IF;

  v_scan := public.trial_anon_scan_start('links-secret', v_id, '192.0.2.10', 0);
  IF v_scan->>'status' <> 'ok' OR (v_scan->>'scans_left')::int <> 1 THEN
    RAISE EXCEPTION 'not ok - first anon scan answered %', v_scan;
  END IF;
  v_scan := public.trial_anon_scan_start('links-secret', v_id, '192.0.2.10', 0);
  IF v_scan->>'status' <> 'ok' OR (v_scan->>'scans_left')::int <> 0 THEN
    RAISE EXCEPTION 'not ok - second anon scan answered %', v_scan;
  END IF;
  v_scan := public.trial_anon_scan_start('links-secret', v_id, '192.0.2.10', 0);
  IF v_scan->>'status' <> 'no_scans_left' OR (v_scan->>'scans_total')::int <> 2 THEN
    RAISE EXCEPTION 'not ok - third anon scan answered %', v_scan;
  END IF;

  -- The token expired and the page asked for a new one: the same browser keeps its count.
  v_reissue := public.trial_anon_start('links-secret', '192.0.2.10', v_id);
  IF (v_reissue->>'device_id')::uuid <> v_id
     OR (v_reissue->>'scans_left')::int <> 0 THEN
    RAISE EXCEPTION 'not ok - reissuing reset the device: %', v_reissue;
  END IF;
END $$;
\echo 'ok - an anonymous device gets the settings limit, keeps it across a reissue, and stores only a salted hash'

-- Revoking the device version refuses the old token.
update public.trial_devices set token_version = 1;
DO $$
DECLARE
  v_id uuid;
  v_scan jsonb;
BEGIN
  select d.id into v_id from public.trial_devices d limit 1;
  v_scan := public.trial_anon_scan_start('links-secret', v_id, '192.0.2.10', 0);
  IF v_scan->>'status' <> 'revoked' THEN
    RAISE EXCEPTION 'not ok - a stale token was not revoked: %', v_scan;
  END IF;
END $$;
\echo 'ok - a stale token version is refused'

-- 2. Per-network: 20 scans a day from one salted address, the twenty-first refused.
update public.trial_settings set scans_limit = 50, daily_budget = 200;
delete from public.llm_calls where trial = true;
delete from public.trial_devices;

DO $$
DECLARE
  v_start jsonb;
  v_scan jsonb;
  v_id uuid;
  i integer;
BEGIN
  v_start := public.trial_anon_start('links-secret', '198.51.100.20', null);
  v_id := (v_start->>'device_id')::uuid;

  FOR i IN 1..20 LOOP
    v_scan := public.trial_anon_scan_start('links-secret', v_id, '198.51.100.20', 0);
    IF v_scan->>'status' <> 'ok' THEN
      RAISE EXCEPTION 'not ok - per-IP scan % was refused: %', i, v_scan;
    END IF;
  END LOOP;

  v_scan := public.trial_anon_scan_start('links-secret', v_id, '198.51.100.20', 0);
  IF v_scan->>'status' <> 'rate_limited' THEN
    RAISE EXCEPTION 'not ok - the twenty-first per-IP scan answered %', v_scan;
  END IF;
END $$;
\echo 'ok - a network gets 20 anonymous scans a day and the twenty-first is rate limited'

-- 3. Global: the existing daily budget covers anonymous scans too.
update public.trial_settings set scans_limit = 10, daily_budget = 0;
delete from public.llm_calls where trial = true;
delete from public.trial_devices;

DO $$
DECLARE
  v_start jsonb;
  v_scan jsonb;
BEGIN
  v_start := public.trial_anon_start('links-secret', '203.0.113.30', null);
  v_scan := public.trial_anon_scan_start('links-secret', (v_start->>'device_id')::uuid, '203.0.113.30', 0);
  IF v_scan->>'status' <> 'busy' THEN
    RAISE EXCEPTION 'not ok - a spent global budget answered %', v_scan;
  END IF;
END $$;
\echo 'ok - the global daily budget stops an anonymous scan'

-- 4. The admin list shows an anonymous device beside the email rows, and the stats count both.
update public.trial_settings set scans_limit = 10, daily_budget = 200;
delete from public.llm_calls where trial = true;
delete from public.trial_devices;
insert into public.trial_devices (scans_used, created_at, last_used_at)
values (4, '2026-11-13T09:00:00Z', '2026-11-13T10:00:00Z');

-- Computed as the owner: the authenticated role may not read these tables directly.
select set_config(
  'test.expected_user_count',
  (((select count(*) from public.trial_users)
    + (select count(*) from public.trial_devices))::integer)::text,
  false
);

begin;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b1","email":"links-admin@example.com","role":"authenticated"}';
DO $$
DECLARE
  v_rows integer;
  v_anon record;
  v_email_rows integer;
  v_expected integer;
  v_stats record;
BEGIN
  SELECT count(*) INTO v_email_rows FROM public.admin_trial_list('list');
  IF v_email_rows <> 3 THEN
    RAISE EXCEPTION 'not ok - email trials through the new list returned % rows, expected 3', v_email_rows;
  END IF;

  SELECT count(*) INTO v_rows FROM public.admin_trial_list('anonymous');
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'not ok - searching anonymous returned % rows, expected 1', v_rows;
  END IF;
  SELECT * INTO v_anon FROM public.admin_trial_list('anonymous') l LIMIT 1;
  IF v_anon.email IS NOT NULL OR v_anon.source <> 'anonymous'
     OR v_anon.invited IS DISTINCT FROM false
     OR v_anon.scans_used <> 4 OR v_anon.scans_limit <> 10
     OR v_anon.first_seen <> '2026-11-13T09:00:00Z'::timestamptz
     OR v_anon.last_active <> '2026-11-13T10:00:00Z'::timestamptz
     OR v_anon.requested_after IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'not ok - the anonymous row answered %', v_anon;
  END IF;

  v_expected := current_setting('test.expected_user_count')::integer;
  SELECT * INTO v_stats FROM public.admin_trial_stats();
  IF v_stats.user_count <> v_expected THEN
    RAISE EXCEPTION 'not ok - admin_trial_stats user_count is %, expected %', v_stats.user_count, v_expected;
  END IF;
END $$;
commit;
\echo 'ok - the admin list answers email rows and Anonymous rows together, and the stats count both'

-- A signed-in member who is not the admin is refused the anonymous list too.
begin;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b2","email":"links-member@example.com","role":"authenticated"}';
DO $$
DECLARE
  raised boolean := false;
BEGIN
  BEGIN PERFORM * FROM public.admin_trial_list('anonymous');
  EXCEPTION WHEN insufficient_privilege THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'not ok - a non-admin could read the anonymous trial'; END IF;
END $$;
commit;
\echo 'ok - a non-admin is refused the anonymous trial list'
