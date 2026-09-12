-- `admin_spend()` failed the first time it was called, and the mistake is worth recording
-- because it is invisible until runtime.
--
-- `auth.users.email` is `character varying(255)`, not `text`. A plpgsql `RETURN QUERY`
-- demands an exact type match against `RETURNS TABLE`, so `us.email` failed with
-- "structure of query does not match function result type" — a 400 at call time, not a
-- failure at creation time. Every other column this reads is already `text`
-- (`allowed_emails.email`, `invite_requests.email`, `profiles.timezone`,
-- `profiles.display_name`), so this one cast is the whole fix.
--
-- Call it out rather than leaving it as a silent cast: the next function that joins
-- `auth.users` will hit the same wall.
create or replace function public.admin_spend()
returns table (
  user_id uuid,
  email text,
  timezone text,
  calls_today integer,
  resets_today timestamptz,
  calls_month integer,
  tokens_month bigint,
  calls_total integer,
  tokens_total bigint,
  last_call_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  return query
    with users as (
      select u.id, u.email::text as email,
             coalesce(p.timezone, 'UTC') as tz
        from auth.users u
        left join public.profiles p on p.user_id = u.id
    ),
    spend as (
      select c.user_id,
             count(*) filter (
               where c.created_at >= public.local_day_start(now(), us.tz)
             )::integer as calls_today,
             count(*) filter (
               where c.created_at >= date_trunc('month', now() at time zone us.tz)
                                     at time zone us.tz
             )::integer as calls_month,
             coalesce(sum(coalesce(c.prompt_tokens, 0) + coalesce(c.completion_tokens, 0))
               filter (
                 where c.created_at >= date_trunc('month', now() at time zone us.tz)
                                       at time zone us.tz
               ), 0)::bigint as tokens_month,
             count(*)::integer as calls_total,
             coalesce(sum(coalesce(c.prompt_tokens, 0) + coalesce(c.completion_tokens, 0)), 0)::bigint
               as tokens_total,
             max(c.created_at) as last_call_at
        from public.llm_calls c
        join users us on us.id = c.user_id
       group by c.user_id
    )
    select
      us.id,
      us.email,
      us.tz,
      coalesce(s.calls_today, 0),
      public.local_day_start_offset(now(), us.tz, 1),
      coalesce(s.calls_month, 0),
      coalesce(s.tokens_month, 0),
      coalesce(s.calls_total, 0),
      coalesce(s.tokens_total, 0),
      s.last_call_at
    from users us
    left join spend s on s.user_id = us.id
    order by coalesce(s.calls_total, 0) desc, us.email;
end $$;

revoke execute on function public.admin_spend() from public, anon;
grant execute on function public.admin_spend() to authenticated;
