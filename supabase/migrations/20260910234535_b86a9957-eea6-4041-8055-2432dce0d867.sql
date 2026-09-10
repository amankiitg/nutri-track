revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.is_email_allowed() from public, anon;
revoke execute on function public.check_email_allowed(text) from public;
revoke execute on function public.bootstrap_first_admin() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_email_allowed() to authenticated;
grant execute on function public.check_email_allowed(text) to anon, authenticated;