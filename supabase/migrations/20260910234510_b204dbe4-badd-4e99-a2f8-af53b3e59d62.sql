-- Enums
create type public.sex_type as enum ('male','female');
create type public.activity_level as enum ('sedentary','lightly_active','moderately_active','very_active','extra_active');
create type public.goal_type as enum ('lose','maintain','gain');
create type public.unit_system as enum ('metric','imperial');
create type public.meal_type as enum ('breakfast','lunch','dinner','snack');
create type public.meal_source as enum ('photo','voice','text');
create type public.weight_source as enum ('manual','import');

-- Shared updated_at trigger
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- allowed_emails
create table public.allowed_emails (
  email text primary key,
  added_by uuid,
  created_at timestamptz not null default now()
);
grant select, insert, delete on public.allowed_emails to authenticated;
grant all on public.allowed_emails to service_role;
alter table public.allowed_emails enable row level security;

-- admins
create table public.admins (
  user_id uuid primary key,
  created_at timestamptz not null default now()
);
grant select on public.admins to authenticated;
grant all on public.admins to service_role;
alter table public.admins enable row level security;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;

create or replace function public.is_email_allowed()
returns boolean language sql stable security definer set search_path = public as $$
  select (not exists (select 1 from public.allowed_emails))
      or exists (
        select 1 from public.allowed_emails
        where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      )
$$;

create or replace function public.check_email_allowed(_email text)
returns boolean language sql stable security definer set search_path = public as $$
  select (not exists (select 1 from public.allowed_emails))
      or exists (select 1 from public.allowed_emails where lower(email) = lower(trim(_email)))
$$;
grant execute on function public.check_email_allowed(text) to anon, authenticated;
grant execute on function public.is_email_allowed() to authenticated;
grant execute on function public.is_admin() to authenticated;

create policy "admins_select_self_or_admin" on public.admins for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy "allowed_emails_admin_select" on public.allowed_emails for select to authenticated
  using (public.is_admin());
create policy "allowed_emails_admin_insert" on public.allowed_emails for insert to authenticated
  with check (public.is_admin());
create policy "allowed_emails_admin_delete" on public.allowed_emails for delete to authenticated
  using (public.is_admin());

-- profiles
create table public.profiles (
  user_id uuid primary key,
  display_name text not null,
  dob date not null,
  sex public.sex_type not null,
  height_cm numeric(5,1) not null,
  weight_kg numeric(5,2) not null,
  activity_level public.activity_level not null,
  goal public.goal_type not null,
  target_weight_kg numeric(5,2),
  pace_kg_per_week numeric(3,2),
  protein_g_per_kg numeric(3,2) not null default 1.6,
  units public.unit_system not null default 'metric',
  timezone text not null default 'UTC',
  reminder_time time,
  dietary_tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.profiles to authenticated;
grant all on public.profiles to service_role;
alter table public.profiles enable row level security;
create policy "profiles_select_own" on public.profiles for select to authenticated using (user_id = auth.uid());
create policy "profiles_insert_own_allowed" on public.profiles for insert to authenticated
  with check (user_id = auth.uid() and public.is_email_allowed());
create policy "profiles_update_own" on public.profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "profiles_delete_own" on public.profiles for delete to authenticated using (user_id = auth.uid());
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- First person to finish onboarding seeds the allow list and becomes admin
create or replace function public.bootstrap_first_admin()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  jwt_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if jwt_email <> '' and not exists (select 1 from public.allowed_emails) then
    insert into public.allowed_emails(email, added_by) values (jwt_email, new.user_id) on conflict do nothing;
    insert into public.admins(user_id) values (new.user_id) on conflict do nothing;
  end if;
  return new;
end $$;
create trigger profiles_bootstrap_admin after insert on public.profiles
  for each row execute function public.bootstrap_first_admin();

-- targets (history)
create table public.targets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  effective_from date not null default current_date,
  calories integer not null,
  protein_g numeric(6,1) not null,
  carbs_g numeric(6,1) not null,
  fat_g numeric(6,1) not null,
  fiber_g numeric(6,1),
  created_at timestamptz not null default now()
);
create index targets_user_effective_idx on public.targets (user_id, effective_from desc);
grant select, insert, update, delete on public.targets to authenticated;
grant all on public.targets to service_role;
alter table public.targets enable row level security;
create policy "targets_select_own" on public.targets for select to authenticated using (user_id = auth.uid());
create policy "targets_insert_own" on public.targets for insert to authenticated
  with check (user_id = auth.uid() and public.is_email_allowed());
create policy "targets_update_own" on public.targets for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "targets_delete_own" on public.targets for delete to authenticated using (user_id = auth.uid());

-- meals
create table public.meals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  eaten_at timestamptz not null default now(),
  meal_type public.meal_type not null,
  source public.meal_source not null,
  notes text,
  photo_path text,
  photo_hash text,
  input_fingerprint text not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index meals_user_fingerprint_uniq on public.meals (user_id, input_fingerprint);
create index meals_user_eaten_idx on public.meals (user_id, eaten_at desc);
create index meals_user_photo_hash_idx on public.meals (user_id, photo_hash) where photo_hash is not null;
grant select, insert, update, delete on public.meals to authenticated;
grant all on public.meals to service_role;
alter table public.meals enable row level security;
create policy "meals_select_own" on public.meals for select to authenticated using (user_id = auth.uid());
create policy "meals_insert_own" on public.meals for insert to authenticated
  with check (user_id = auth.uid() and public.is_email_allowed());
create policy "meals_update_own" on public.meals for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "meals_delete_own" on public.meals for delete to authenticated using (user_id = auth.uid());

-- meal_items
create table public.meal_items (
  id uuid primary key default gen_random_uuid(),
  meal_id uuid not null references public.meals(id) on delete cascade,
  name text not null,
  quantity numeric(8,2),
  unit text,
  grams numeric(8,1),
  calories numeric(8,1) not null default 0,
  protein_g numeric(7,1) not null default 0,
  carbs_g numeric(7,1) not null default 0,
  fat_g numeric(7,1) not null default 0,
  fiber_g numeric(7,1),
  sugar_g numeric(7,1),
  sodium_mg numeric(8,1),
  confidence numeric(3,2),
  user_edited boolean not null default false,
  llm_raw jsonb,
  created_at timestamptz not null default now()
);
create index meal_items_meal_idx on public.meal_items (meal_id);
grant select, insert, update, delete on public.meal_items to authenticated;
grant all on public.meal_items to service_role;
alter table public.meal_items enable row level security;
create policy "meal_items_select_own" on public.meal_items for select to authenticated
  using (exists (select 1 from public.meals m where m.id = meal_id and m.user_id = auth.uid()));
create policy "meal_items_insert_own" on public.meal_items for insert to authenticated
  with check (exists (select 1 from public.meals m where m.id = meal_id and m.user_id = auth.uid()));
create policy "meal_items_update_own" on public.meal_items for update to authenticated
  using (exists (select 1 from public.meals m where m.id = meal_id and m.user_id = auth.uid()))
  with check (exists (select 1 from public.meals m where m.id = meal_id and m.user_id = auth.uid()));
create policy "meal_items_delete_own" on public.meal_items for delete to authenticated
  using (exists (select 1 from public.meals m where m.id = meal_id and m.user_id = auth.uid()));

-- weight_log
create table public.weight_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  logged_on date not null,
  weight_kg numeric(5,2) not null,
  source public.weight_source not null default 'manual',
  created_at timestamptz not null default now(),
  unique (user_id, logged_on)
);
grant select, insert, update, delete on public.weight_log to authenticated;
grant all on public.weight_log to service_role;
alter table public.weight_log enable row level security;
create policy "weight_select_own" on public.weight_log for select to authenticated using (user_id = auth.uid());
create policy "weight_insert_own" on public.weight_log for insert to authenticated
  with check (user_id = auth.uid() and public.is_email_allowed());
create policy "weight_update_own" on public.weight_log for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "weight_delete_own" on public.weight_log for delete to authenticated using (user_id = auth.uid());

-- llm_calls
create table public.llm_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  model text not null,
  prompt_tokens integer,
  completion_tokens integer,
  latency_ms integer,
  status text not null,
  created_at timestamptz not null default now()
);
create index llm_calls_user_created_idx on public.llm_calls (user_id, created_at desc);
grant select, insert on public.llm_calls to authenticated;
grant all on public.llm_calls to service_role;
alter table public.llm_calls enable row level security;
create policy "llm_calls_select_own_or_admin" on public.llm_calls for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy "llm_calls_insert_own" on public.llm_calls for insert to authenticated
  with check (user_id = auth.uid());

-- daily_summaries view (runs with the caller's permissions, so RLS applies)
create view public.daily_summaries with (security_invoker = true) as
with meal_days as (
  select m.id as meal_id, m.user_id,
         (m.eaten_at at time zone coalesce(p.timezone, 'UTC'))::date as local_date
  from public.meals m
  join public.profiles p on p.user_id = m.user_id
  where m.deleted_at is null
),
agg as (
  select md.user_id, md.local_date,
         count(distinct md.meal_id) as meal_count,
         coalesce(sum(mi.calories), 0) as calories,
         coalesce(sum(mi.protein_g), 0) as protein_g,
         coalesce(sum(mi.carbs_g), 0) as carbs_g,
         coalesce(sum(mi.fat_g), 0) as fat_g,
         coalesce(sum(mi.fiber_g), 0) as fiber_g
  from meal_days md
  join public.meal_items mi on mi.meal_id = md.meal_id
  group by md.user_id, md.local_date
)
select a.user_id, a.local_date, a.meal_count, a.calories, a.protein_g, a.carbs_g, a.fat_g, a.fiber_g,
       t.calories as target_calories, t.protein_g as target_protein_g,
       t.carbs_g as target_carbs_g, t.fat_g as target_fat_g,
       case
         when t.calories is null then null
         when a.calories < t.calories * 0.9 then 'under'
         when a.calories > t.calories * 1.1 then 'over'
         else 'on_track'
       end as status
from agg a
left join lateral (
  select * from public.targets t
  where t.user_id = a.user_id and t.effective_from <= a.local_date
  order by t.effective_from desc limit 1
) t on true;
grant select on public.daily_summaries to authenticated;
grant select on public.daily_summaries to service_role;