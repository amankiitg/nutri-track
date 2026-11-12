# Security policy

NutriTrack keeps meal, weight and profile data for real people. If you think you have found a
security problem, report it privately instead of opening a public issue.

## Reporting a problem

Email **hello@tracknutri.app**. Include what you found, roughly how to reproduce it, and which
URL or file it affects. Do not include another person's meal, weight or profile data in the
report. If a screenshot is needed, use your own account or a test account you created.

If the problem is a leaked credential, say that in the subject line and do not repeat the
credential in the message body.

## What to expect

This is a small personal project, not a staffed service. Reports are read on a best-effort
basis, usually within a week. A fix is described in the commit that makes it, and a report that
changes behaviour gets a reply saying what changed. There is no bug bounty.

## Scope

In scope:

- The app at <https://tracknutri.app>, including the free trial at `/try`
- The parse-meal service at <https://nutritrack-parse-meal.onrender.com>
- The source in this repository
- The Supabase schema and its Row Level Security policies, as visible in `supabase/migrations/`

Out of scope:

- Findings that need a compromised device, a stolen session token, or access to the reporter's
  own mailbox
- Missing security headers or cookie flags with no demonstrated effect
- Reports from automated scanners that create accounts or spend model quota
- Denial of service through ordinary traffic volume

## Please do not

- Read, change or keep another user's data. Use your own account, or a test account you made.
- Run scans that sign up accounts, send emails, or spend model analyses. The daily analysis cap
  exists to keep a real budget intact.
- Test against the production service in a way that degrades it for the two people who use it.

If a test needs data that is not yours, stop and ask first. A finding that depends on somebody
else's rows is not worth the intrusion.

## Secrets in the repository

No secret belongs in this repository. The Gemini key and every Gmail credential are server-side
environment values. A `VITE_` prefixed value is inlined into the browser bundle at build time and
must never hold a secret.

Commits are scanned for secrets by a gitleaks pre-commit hook and by the CI job in
`.github/workflows/secret-scan.yml`. If a credential is ever committed, treat it as leaked:
revoke it first, then remove it from history. Removing the file is not enough, because the
commit still holds it.

## Supported versions

Only `main` is supported. Deployments are built from it.
