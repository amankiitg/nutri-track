-- Take the address out of the client's hands entirely.
--
-- `invite_requests.email` was `not null` with no default, so the browser had to send it
-- and the insert policy then checked it against the JWT. That works, but it makes the
-- safety property "the policy compares two values" rather than "there is only one value".
--
-- With the default, an honest client sends nothing and the address comes from the signed
-- token. The policy check stays, because a default does not stop a caller supplying
-- something else — defaults are applied before the WITH CHECK, so a tampered row is
-- still refused. The difference is that the guarantee no longer depends on the browser
-- getting it right.
--
-- If a token has no `email` claim at all, the default is NULL and the not-null constraint
-- refuses the row. That is the correct outcome: there is nothing to record.
alter table public.invite_requests
  alter column email set default (auth.jwt() ->> 'email');
