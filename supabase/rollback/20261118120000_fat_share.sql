-- Rollback of 20261118120000_fat_share.sql.
--
-- Dropping the column restores the previous behaviour only in part: `computeTargets` falls back to
-- 30% for a missing share, so the code must be rolled back with the column. Nothing else reads it.

alter table public.profiles
  drop constraint if exists profiles_fat_share_range;

alter table public.profiles
  drop column if exists fat_share;
