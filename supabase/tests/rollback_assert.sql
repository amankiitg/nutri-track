-- Assertions run after the rollback: the trial is gone and llm_calls is back to its
-- pre-trial shape with user_id NOT NULL again.

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_cols text;
  v_notnull boolean;
  v_spend_cols text;
BEGIN
  -- trial_users, trial_codes, trial_settings tables are gone.
  IF to_regclass('public.trial_users') IS NOT NULL THEN
    RAISE EXCEPTION 'not ok - trial_users still exists after rollback';
  END IF;
  IF to_regclass('public.trial_codes') IS NOT NULL THEN
    RAISE EXCEPTION 'not ok - trial_codes still exists after rollback';
  END IF;
  IF to_regclass('public.trial_settings') IS NOT NULL THEN
    RAISE EXCEPTION 'not ok - trial_settings still exists after rollback';
  END IF;

  -- The trial functions are gone.
  IF to_regprocedure('public.trial_send_code(text,text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'not ok - trial_send_code still exists after rollback';
  END IF;
  IF to_regprocedure('public.trial_scan_start(text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'not ok - trial_scan_start still exists after rollback';
  END IF;
  IF to_regprocedure('public.trial_check_secret(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'not ok - trial_check_secret still exists after rollback';
  END IF;

  -- llm_calls has lost its trial and ip_hash columns.
  select string_agg(a.attname, ',') into v_cols
    from pg_attribute a
    where a.attrelid = 'public.llm_calls'::regclass
      and a.attname in ('trial', 'ip_hash')
      and a.attnum > 0 and not a.attisdropped;
  IF v_cols IS NOT NULL THEN
    RAISE EXCEPTION 'not ok - llm_calls still has trial columns: %', v_cols;
  END IF;

  -- user_id is NOT NULL again.
  select (a.attnotnull) into v_notnull
    from pg_attribute a
    where a.attrelid = 'public.llm_calls'::regclass
      and a.attname = 'user_id' and a.attnum > 0;
  IF v_notnull IS NOT TRUE THEN
    RAISE EXCEPTION 'not ok - llm_calls.user_id is not NOT NULL again';
  END IF;

  -- admin_spend is back to the pre-trial shape: its composite return type has no
  -- is_trial attribute.
  select string_agg(a.attname, ',') into v_spend_cols
    from pg_attribute a
    join pg_type t on t.typrelid = a.attrelid
    where t.typname = 'admin_spend'
      and t.typnamespace = 'public'::regnamespace
      and a.attname = 'is_trial' and a.attnum > 0 and not a.attisdropped;
  IF v_spend_cols IS NOT NULL THEN
    RAISE EXCEPTION 'not ok - admin_spend still returns is_trial';
  END IF;

  -- The request_invite overload is back to four arguments.
  IF to_regprocedure('public.request_invite(text,text,boolean,text,boolean)') IS NOT NULL THEN
    RAISE EXCEPTION 'not ok - five-argument request_invite still exists';
  END IF;
  IF to_regprocedure('public.request_invite(text,text,boolean,text)') IS NULL THEN
    RAISE EXCEPTION 'not ok - four-argument request_invite was not restored';
  END IF;
END $$;
\echo 'ok 5 - rollback removed the trial and restored llm_calls to its pre-trial shape'
