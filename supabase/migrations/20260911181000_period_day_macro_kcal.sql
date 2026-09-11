-- Per-day macro energy, added while building the Trends charts.
--
-- The macro donut shows the split by *energy* — protein and carbohydrate are 4 kcal/g and
-- fat is 9, so a donut of grams would claim 100 g of fat is the same share of a diet as
-- 100 g of carbohydrate. The stacked bar shows the same split over time, and if it
-- stacked grams instead it would be answering a different question next to a chart
-- answering this one, inviting the reader to compare two things that are not comparable.
--
-- So the conversion lives here rather than in the renderer. It is arithmetic over
-- stored values, which is the category this screen keeps in the database.
create or replace function public.get_period_summary(p_start date, p_end date)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with span as (
    select least(greatest((p_end - p_start) + 1, 1), 400) as days
  ),
  day_rows as (
    select * from public.trailing_days(p_end, (select days from span))
  ),
  logged as (
    select * from day_rows where meal_count > 0
  ),
  judged as (
    select * from logged where target_calories is not null
  )
  select jsonb_build_object(
    'start', (select min(local_date) from day_rows),
    'end', p_end,
    'window_days', (select count(*) from day_rows),
    'days', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'local_date', local_date,
            'meal_count', meal_count,
            'calories', calories,
            'protein_g', protein_g,
            'carbs_g', carbs_g,
            'fat_g', fat_g,
            'protein_kcal', round(protein_g * 4),
            'carbs_kcal', round(carbs_g * 4),
            'fat_kcal', round(fat_g * 9),
            'target_calories', target_calories,
            'status', status
          )
          order by local_date
        ),
        '[]'::jsonb
      )
      from day_rows
    ),
    'totals', jsonb_build_object(
      'days_logged', (select count(*) from logged),
      'days_judged', (select count(*) from judged),
      'days_on_track', (select count(*) from judged where status = 'on_track'),
      'adherence_pct', (
        select round(100.0 * count(*) filter (where status = 'on_track') / nullif(count(*), 0))
        from judged
      ),
      'avg_calories', (select round(avg(calories)) from judged),
      'avg_target_calories', (select round(avg(target_calories)) from judged),
      'avg_protein_g', (select round(avg(protein_g), 1) from judged),
      'avg_target_protein_g', (select round(avg(target_protein_g), 1) from judged),
      'avg_carbs_g', (select round(avg(carbs_g), 1) from judged),
      'avg_fat_g', (select round(avg(fat_g), 1) from judged),
      'protein_kcal', (select round(avg(protein_g) * 4) from judged),
      'carbs_kcal', (select round(avg(carbs_g) * 4) from judged),
      'fat_kcal', (select round(avg(fat_g) * 9) from judged),
      'total_meals', (select coalesce(sum(meal_count), 0) from day_rows)
    )
  );
$$;
