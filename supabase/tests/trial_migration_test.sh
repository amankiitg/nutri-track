#!/usr/bin/env bash
#
# Applies the trial migration to a throwaway local database, exercises the trial
# functions (secret gate, limits, concurrency), inserts trial rows, runs the rollback,
# and asserts the rollback succeeded.
#
# This runs against the local Homebrew Postgres only: it creates and drops its own
# database and never touches a live project. Nothing here reads a credential.
#
#   bash supabase/tests/trial_migration_test.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DB="nutritrack_trial_test"
PSQL=(psql -X -v ON_ERROR_STOP=1 -q)

pass=0
say() { echo "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# A fresh database each run.
psql -X -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists ${DB} with (force);" >/dev/null
psql -X -v ON_ERROR_STOP=1 -q -d postgres -c "create database ${DB};" >/dev/null

# 1. The prerequisites (auth schema, Vault stub, roles, tables, functions).
"${PSQL[@]}" -d "${DB}" -f "${ROOT}/supabase/tests/stub.sql" >/dev/null

# 2. Plant the Vault secret the gate reads.
"${PSQL[@]}" -d "${DB}" -c "insert into vault.decrypted_secrets (name, decrypted_secret) values ('trial_server_secret', 'test-secret-123');" >/dev/null

# 3. The migration under test.
"${PSQL[@]}" -d "${DB}" -f "${ROOT}/supabase/migrations/20261109170000_trial_tables.sql" >/dev/null
say "applied the trial migration"

# 4. The function assertions (secret gate, happy path, limits-from-settings).
"${PSQL[@]}" -d "${DB}" -f "${ROOT}/supabase/tests/trial_functions.sql"
pass=$((pass + 4))

# 5. Concurrency: a daily budget of 1 must admit exactly one of five simultaneous
#    scan_start calls. The advisory locks serialise them, and the reserved row is what
#    the budget counts, so the ceiling cannot be overshot. Clear earlier trial rows
#    first so the count starts from zero.
"${PSQL[@]}" -d "${DB}" >/dev/null <<'SQL'
delete from public.llm_calls where trial = true;
update public.trial_settings set scans_limit = 10, daily_budget = 1;
select public.trial_send_code('test-secret-123', 'c1@example.com', 'C1', '10.0.0.1');
select public.trial_send_code('test-secret-123', 'c2@example.com', 'C2', '10.0.0.2');
select public.trial_send_code('test-secret-123', 'c3@example.com', 'C3', '10.0.0.3');
select public.trial_send_code('test-secret-123', 'c4@example.com', 'C4', '10.0.0.4');
select public.trial_send_code('test-secret-123', 'c5@example.com', 'C5', '10.0.0.5');
SQL

tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT
for i in 1 2 3 4 5; do
  psql -X -t -A -d "${DB}" -c "select public.trial_scan_start('test-secret-123', 'c${i}@example.com', '10.0.0.${i}')->>'status';" > "${tmpdir}/${i}" 2>&1 &
done
wait

ok_count="$(grep -h -x 'ok' "${tmpdir}"/1 "${tmpdir}"/2 "${tmpdir}"/3 "${tmpdir}"/4 "${tmpdir}"/5 | wc -l | tr -d ' ')"
busy_count="$(grep -h -x 'busy' "${tmpdir}"/1 "${tmpdir}"/2 "${tmpdir}"/3 "${tmpdir}"/4 "${tmpdir}"/5 | wc -l | tr -d ' ')"

if [ "${ok_count}" != "1" ] || [ "${busy_count}" != "4" ]; then
  fail "concurrency: expected 1 ok and 4 busy, got ${ok_count} ok and ${busy_count} busy"
fi
say "ok - concurrent scan_start calls cannot exceed the daily budget (1 ok, 4 busy)"
pass=$((pass + 1))

# 6. Insert a completed trial row by hand (what the old trial_log_call would have
#    written) so the rollback's delete path has both a reserved and a completed row to
#    remove before it restores user_id NOT NULL.
"${PSQL[@]}" -d "${DB}" -c "insert into public.llm_calls (user_id, model, status, trial, ip_hash) values (null, 'gemini-3.8-flash', 'ok', true, 'deadbeef');" >/dev/null

# 7. The rollback.
"${PSQL[@]}" -d "${DB}" -f "${ROOT}/supabase/rollback/20261109170000_trial_tables.sql" >/dev/null
say "applied the rollback"

# 8. Assert the rollback left llm_calls back to its pre-trial shape.
"${PSQL[@]}" -d "${DB}" -f "${ROOT}/supabase/tests/rollback_assert.sql"
pass=$((pass + 1))

say ""
say "PASS: all ${pass} trial migration checks passed"
