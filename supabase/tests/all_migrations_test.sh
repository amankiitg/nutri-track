#!/usr/bin/env bash
#
# Replays every migration in supabase/migrations, in order, each in its own transaction
# (as `supabase db push` applies them), on a database that starts with only what the
# Supabase platform provides. So each migration meets the schema the previous ones left,
# including the previous definition of every function it re-creates.
#
# This is the test that catches "cannot change return type of existing function": the
# trial migration passed trial_migration_test.sh, which applies it to stubbed tables
# with no admin_spend() at all, and then failed against production.
#
# After the forward pass it calls the re-created functions as anon and as a signed-in
# admin, runs the trial rollbacks newest first and checks the previous definitions came
# back, then applies the trial migrations again over that restored state.
#
# Local Homebrew Postgres only: it creates and drops its own database, never touches a
# live project, and reads no credential. Every row it writes is synthetic.
#
#   bash supabase/tests/all_migrations_test.sh
#
set -euo pipefail
export PGOPTIONS="-c client_min_messages=warning"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DB="nutritrack_all_migrations_test"
# Overridable so the test can be pointed at an older copy of the files to prove it fails.
MIGRATIONS="${MIGRATIONS_DIR:-${ROOT}/supabase/migrations}"
TESTS="${ROOT}/supabase/tests"
PSQL=(psql -X -v ON_ERROR_STOP=1 -q -d "${DB}")
FIRST_TRIAL="20261109170000"

psql -X -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists ${DB} with (force);" >/dev/null
psql -X -v ON_ERROR_STOP=1 -q -d postgres -c "create database ${DB};" >/dev/null

"${PSQL[@]}" -f "${TESTS}/platform_stub.sql" >/dev/null

apply() {
  # -1 wraps the file in one transaction, so a failure rolls the whole file back, which
  # is what production did with this migration.
  if ! "${PSQL[@]}" -1 -f "$1" >/dev/null 2>"${tmp_err}"; then
    echo "FAIL: $(basename "$1") did not apply:" >&2
    cat "${tmp_err}" >&2
    exit 1
  fi
}

tmp_err="$(mktemp)"
trap 'rm -f "${tmp_err}"; psql -X -q -d postgres -c "drop database if exists ${DB} with (force);" >/dev/null 2>&1 || true' EXIT

count=0
checked_precondition=false
for f in "${MIGRATIONS}"/*.sql; do
  version="$(basename "$f" | cut -d_ -f1)"
  if [ "${version}" = "${FIRST_TRIAL}" ]; then
    "${PSQL[@]}" -f "${TESTS}/all_migrations/before_trial.sql"
    checked_precondition=true
  fi
  apply "$f"
  count=$((count + 1))
done
[ "${checked_precondition}" = true ] || { echo "FAIL: ${FIRST_TRIAL} not found in ${MIGRATIONS}" >&2; exit 1; }
echo "ok - applied all ${count} migrations in order"

"${PSQL[@]}" -f "${TESTS}/all_migrations/after_trial.sql"
"${PSQL[@]}" -f "${TESTS}/all_migrations/after_links.sql"
"${PSQL[@]}" -f "${TESTS}/all_migrations/after_trial_list.sql"
"${PSQL[@]}" -f "${TESTS}/all_migrations/after_fibre.sql"

# Roll back newest first, checking each predecessor comes back.
apply "${ROOT}/supabase/rollback/20261112120000_admin_trial_list.sql"
"${PSQL[@]}" -f "${TESTS}/all_migrations/after_trial_list_rollback.sql"
apply "${ROOT}/supabase/rollback/20261110120000_trial_links.sql"
"${PSQL[@]}" -f "${TESTS}/all_migrations/after_links_rollback.sql"
apply "${ROOT}/supabase/rollback/20261109180000_trial_scans_limit.sql"
apply "${ROOT}/supabase/rollback/20261109170000_trial_tables.sql"
"${PSQL[@]}" -f "${TESTS}/all_migrations/after_rollback.sql"

# And forward again, over the restored predecessors.
apply "${MIGRATIONS}/20261109170000_trial_tables.sql"
apply "${MIGRATIONS}/20261109180000_trial_scans_limit.sql"
apply "${MIGRATIONS}/20261110120000_trial_links.sql"
apply "${MIGRATIONS}/20261110130000_trial_meal_first_invited.sql"
apply "${MIGRATIONS}/20261112120000_admin_trial_list.sql"
echo "ok - the trial migrations (and the trials list) apply again after their rollback"

# The fibre migration adds a profile column and replaces two functions. Its rollback has to
# restore the predecessors before the column can be dropped, so this proves the pair round-trips
# rather than just that the forward file applies.
apply "${ROOT}/supabase/rollback/20261112130000_fibre_macro.sql"
fibre_col=$("${PSQL[@]}" -Atc "select count(*) from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='fiber_target_g'")
[ "${fibre_col}" = "0" ] || { echo "FAIL: fiber_target_g survived its rollback" >&2; exit 1; }
fibre_wv=$("${PSQL[@]}" -Atc "select count(*) from information_schema.columns where table_schema='public' and table_name='week_verdict' and column_name like 'avg_%fiber%'")
[ "${fibre_wv}" = "0" ] || { echo "FAIL: the restored week_verdict still has a fibre column" >&2; exit 1; }
apply "${MIGRATIONS}/20261112130000_fibre_macro.sql"
fibre_col=$("${PSQL[@]}" -Atc "select count(*) from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='fiber_target_g'")
[ "${fibre_col}" = "1" ] || { echo "FAIL: fiber_target_g missing after the fibre migration reapplied" >&2; exit 1; }
echo "ok - the fibre migration rolls back and applies again"

echo ""
echo "PASS: all migrations apply in order over their predecessors, and the trial and fibre rollbacks round-trip"
