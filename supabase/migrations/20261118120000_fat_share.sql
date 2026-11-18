-- Fat becomes a share of the calorie target that the person chooses.
--
-- The split was hard-coded: fat took 25% of the day's calories and carbohydrate took whatever was
-- left after protein and fat. That is a reasonable default and a poor decision to make for
-- somebody, because the ratio people want genuinely differs — a low-fat diet and a Mediterranean
-- one have the same protein dose and different fat shares.
--
-- The column lives on `profiles`, beside `protein_g_per_kg` and for the same reason: it is a
-- preference, not arithmetic on the body. The calories, protein and carbohydrate figures stay
-- derived — `computeTargets` in `src/lib/targets.ts` is the only place that does the maths, and it
-- reads this column on every recompute.
--
-- Default 0.30, which changes the number existing users see: their fat target moves from 25% to
-- 30% of the same calories the next time their targets are recomputed, and their carbohydrate
-- target absorbs the difference. Nothing is rewritten here — `targets` rows are history, and a
-- past day stays logged against the target it was eaten against.
--
-- The range is the slider's range, enforced by a check constraint so no writer can store a share
-- outside what the UI offers. numeric(4,3) holds 0.200 to 0.350 exactly.
--
-- Rollback: supabase/rollback/20261118120000_fat_share.sql

alter table public.profiles
  add column fat_share numeric(4,3) not null default 0.30;

alter table public.profiles
  add constraint profiles_fat_share_range check (fat_share between 0.20 and 0.35);

comment on column public.profiles.fat_share is
  'Share of the daily calorie target given to fat, 0.20-0.35. 0.30 by default; carbohydrate takes the remainder after protein and fat.';
