-- Rollback of 20261120170000_global_analysis_cap.sql.
--
-- Drops the two guards. The parse-meal service must be rolled back with this: with the functions
-- gone, its guards fail closed and every analysis is refused, which is the safe direction but not
-- a working one.

drop function if exists public.caller_email_verified();
drop function if exists public.global_analyses_today();
