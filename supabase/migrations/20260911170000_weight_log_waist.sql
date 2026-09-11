-- Waist measurement, alongside weight.
--
-- Weight moves several kilos on water and glycogen in a week without any change in
-- fat, so a fortnight of weigh-ins can be genuinely uninformative. Waist circumference
-- tracks fat loss far more honestly, which is why it earns a column rather than a note.
--
-- Nullable, and stays nullable: most weigh-ins will not include one, and a missing
-- measurement must never read as zero. There is no default and no backfill.
--
-- Stored in centimetres always, whatever the profile's display units are, exactly as
-- `weight_kg` and `height_cm` are. Conversion belongs at the edges (`lib/units.ts`),
-- never in the database and never in storage.
alter table public.weight_log
  add column if not exists waist_cm numeric(5,1);

-- A typo guard rather than a physiological judgement: a waist recorded as 800 cm is a
-- mistyped unit, not a measurement. The bound is wide enough not to argue with anyone.
alter table public.weight_log
  drop constraint if exists weight_log_waist_cm_range;
alter table public.weight_log
  add constraint weight_log_waist_cm_range
  check (waist_cm is null or (waist_cm > 20 and waist_cm < 300));

comment on column public.weight_log.waist_cm is
  'Waist circumference in centimetres, or null when not measured. Display units are a client concern.';
