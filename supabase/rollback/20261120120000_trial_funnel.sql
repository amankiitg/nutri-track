-- Rollback of 20261120120000_trial_funnel.sql.
--
-- Drops the counters, the cap's store, the writer, the admin read, the bump and the trigger
-- on invite_requests. Nothing else reads them: the parse-meal service calls
-- trial_funnel_log, so the service must be rolled back with this (it degrades to a logged
-- warning and still serves, but the events are lost).

drop trigger if exists invite_requests_trial_funnel on public.invite_requests;
drop function if exists public.trial_funnel_from_invite_request();
drop function if exists public.admin_trial_funnel(integer);
drop function if exists public.trial_funnel_log(text, text, text);
drop function if exists public.trial_funnel_bump(text, text, integer);
drop table if exists public.trial_funnel_ip_daily;
drop table if exists public.trial_funnel_daily;
