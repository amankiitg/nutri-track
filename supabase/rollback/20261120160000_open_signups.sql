-- Rollback of 20261120130000_open_signups.sql.
--
-- Puts the sign-in answer back to invite-only, removes the switch and the counts, and takes the
-- two sign-up steps back out of the funnel. The app's OPEN_SIGNUPS read falls back to false when
-- `open_signups()` is gone, so no frontend rollback is needed with this.

alter table public.trial_funnel_daily
  drop constraint trial_funnel_daily_event;

alter table public.trial_funnel_daily
  add constraint trial_funnel_daily_event check (event in (
    'try_page_view',
    'analyse_tapped',
    'turnstile_failed',
    'token_issued',
    'analysis_ok',
    'analysis_no_food',
    'analysis_error',
    'limit_reached',
    'request_invite_submitted'
  ));

-- The writer and both admin reads keep working: the allowlist is permissive, and a stray
-- 'signup_started' row can only fail the constraint if one arrives, which cannot while the app
-- is rolled back with it. Their bodies are restored by the original migrations on a full rebuild.

drop function if exists public.admin_signup_counts();
drop function if exists public.open_signups();
drop table if exists public.app_settings;
