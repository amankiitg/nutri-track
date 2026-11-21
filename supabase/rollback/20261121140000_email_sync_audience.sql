-- Rollback of 20261121140000_email_sync_audience.sql.
--
-- Drops the read, the state row and the two exclusion lists, in the reverse order
-- they were created. The profiles column goes last: nothing else depends on it, and
-- dropping it first would make a half applied rollback lose a person's setting
-- before the functions that read it are gone.
--
-- What this cannot undo: the profiles.product_emails values a person chose, once the
-- column is dropped. Nothing else in the app reads the column, so the app keeps
-- working with or without this rollback.

drop function if exists public.admin_email_sync_summary();
drop function if exists public.email_sync_record(text, integer, integer, integer);
drop function if exists public.email_sync_counts(text);
drop function if exists public.email_sync_page(text, text, integer);
drop function if exists public.email_sync_candidates();
drop function if exists public.email_sync_addresses();
drop function if exists public.email_sync_check_secret(text);
drop function if exists public.email_sync_server_secret();

drop table if exists public.email_sync_state;

alter table public.app_settings
  drop column if exists email_sync_exclude;

alter table public.profiles
  drop column if exists product_emails;
