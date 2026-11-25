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
"${PSQL[@]}" -f "${TESTS}/all_migrations/after_anonymous.sql"
"${PSQL[@]}" -f "${TESTS}/all_migrations/after_funnel.sql"
"${PSQL[@]}" -f "${TESTS}/all_migrations/after_no_food.sql"
"${PSQL[@]}" -f "${TESTS}/all_migrations/after_open_signups.sql"
"${PSQL[@]}" -f "${TESTS}/all_migrations/after_global_cap.sql"
"${PSQL[@]}" -f "${TESTS}/all_migrations/after_open_signups_post_login.sql"
"${PSQL[@]}" -f "${TESTS}/all_migrations/after_no_password_claim.sql"
"${PSQL[@]}" -f "${TESTS}/all_migrations/after_has_password_evidence.sql"
"${PSQL[@]}" -f "${TESTS}/all_migrations/after_email_sync.sql"
"${PSQL[@]}" -f "${TESTS}/all_migrations/after_email_sync_counters.sql"

# Roll back newest first, checking each predecessor comes back. The no-food rollback goes
# before the funnel one because it restores the eight-event reader that the funnel rollback
# then drops; and the funnel goes before the trial tables, whose rollback drops a column its
# trigger depends on.
apply "${ROOT}/supabase/rollback/20261125120000_email_sync_counters.sql"
counters=$("${PSQL[@]}" -Atc "select count(*) from information_schema.columns where table_schema='public' and table_name='email_sync_state' and column_name in ('checked','added','already','names','failed','first_error')")
[ "${counters}" = "0" ] || { echo "FAIL: the counter columns survived their rollback" >&2; exit 1; }
back=$("${PSQL[@]}" -Atc "select count(*) from information_schema.columns where table_schema='public' and table_name='email_sync_state' and column_name = 'contacts'")
[ "${back}" = "1" ] || { echo "FAIL: the rollback did not restore the contacts column" >&2; exit 1; }
echo "ok - the counter migration rolls back to the contacts column"
apply "${ROOT}/supabase/rollback/20261121140000_email_sync_audience.sql"
sync_left=$("${PSQL[@]}" -Atc "select count(*) from pg_proc where proname in ('email_sync_page', 'email_sync_addresses', 'email_sync_candidates', 'email_sync_counts', 'email_sync_record', 'email_sync_check_secret', 'email_sync_server_secret', 'admin_email_sync_summary')")
[ "${sync_left}" = "0" ] || { echo "FAIL: an email sync function survived its rollback" >&2; exit 1; }
sync_table=$("${PSQL[@]}" -Atc "select coalesce(to_regclass('public.email_sync_state')::text, 'none')")
[ "${sync_table}" = "none" ] || { echo "FAIL: email_sync_state survived its rollback" >&2; exit 1; }
sync_profile=$("${PSQL[@]}" -Atc "select count(*) from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='product_emails'")
[ "${sync_profile}" = "0" ] || { echo "FAIL: profiles.product_emails survived its rollback" >&2; exit 1; }
sync_settings=$("${PSQL[@]}" -Atc "select count(*) from information_schema.columns where table_schema='public' and table_name='app_settings' and column_name='email_sync_exclude'")
[ "${sync_settings}" = "0" ] || { echo "FAIL: app_settings.email_sync_exclude survived its rollback" >&2; exit 1; }
apply "${MIGRATIONS}/20261121140000_email_sync_audience.sql"
sync_back=$("${PSQL[@]}" -Atc "select count(*) from pg_proc where proname = 'email_sync_page'")
[ "${sync_back}" = "1" ] || { echo "FAIL: email_sync_page missing after the migration reapplied" >&2; exit 1; }
echo "ok - the email sync migration rolls back and applies again"
apply "${ROOT}/supabase/rollback/20261121120000_has_password_evidence.sql"
evidence=$("${PSQL[@]}" -Atc "select count(*) from pg_proc where proname in ('mark_has_password', 'profiles_has_password_guard')")
[ "${evidence}" = "0" ] || { echo "FAIL: the password recorder or its guard survived the rollback" >&2; exit 1; }
column=$("${PSQL[@]}" -Atc "select count(*) from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='has_password'")
[ "${column}" = "0" ] || { echo "FAIL: profiles.has_password survived its rollback" >&2; exit 1; }
states=$("${PSQL[@]}" -Atc "select pg_get_functiondef(oid) from pg_proc where proname='auth_entry_state'" | grep -c "has_password_google" || true)
[ "${states}" = "0" ] || { echo "FAIL: the restored auth_entry_state still names has_password_google" >&2; exit 1; }
echo "ok - the password evidence migration rolls back: no column, no recorder, no guard"
apply "${ROOT}/supabase/rollback/20261121090000_no_password_claim.sql"
claim=$("${PSQL[@]}" -Atc "select pg_get_functiondef(oid) from pg_proc where proname='auth_entry_state'" | grep -c "encrypted_password" || true)
[ "${claim}" = "1" ] || { echo "FAIL: the rollback did not restore the encrypted_password branch" >&2; exit 1; }
echo "ok - the no-claim migration rolls back to the claiming version"
apply "${ROOT}/supabase/rollback/20261120200000_link_only_google.sql"
linkonly=$("${PSQL[@]}" -Atc "select pg_get_functiondef(oid) from pg_proc where proname='auth_entry_state'" | grep -c "link_only_google" || true)
[ "${linkonly}" = "0" ] || { echo "FAIL: the restored auth_entry_state still names link_only_google" >&2; exit 1; }
echo "ok - the combined answer rolls back to three states"
apply "${ROOT}/supabase/rollback/20261120180000_open_signups_post_login.sql"
postlogin=$("${PSQL[@]}" -Atc "select count(*) from pg_trigger where tgname='invite_requests_skip_when_open'")
[ "${postlogin}" = "0" ] || { echo "FAIL: the request trigger survived its rollback" >&2; exit 1; }
echo "ok - the post-login migration rolls back: the trigger is gone"
apply "${ROOT}/supabase/rollback/20261120170000_global_analysis_cap.sql"
cap_left=$("${PSQL[@]}" -Atc "select count(*) from pg_proc where proname in ('global_analyses_today', 'caller_email_verified')")
[ "${cap_left}" = "0" ] || { echo "FAIL: the analysis guards survived their rollback" >&2; exit 1; }
apply "${ROOT}/supabase/rollback/20261120160000_open_signups.sql"
settings_left=$("${PSQL[@]}" -Atc "select coalesce(to_regclass('public.app_settings')::text, 'none')")
[ "${settings_left}" = "none" ] || { echo "FAIL: app_settings survived its rollback" >&2; exit 1; }
switch_left=$("${PSQL[@]}" -Atc "select count(*) from pg_proc where proname='open_signups'")
[ "${switch_left}" = "0" ] || { echo "FAIL: open_signups survived its rollback" >&2; exit 1; }
echo "ok - the open-signups migration rolls back: the switch and its table are gone"
apply "${ROOT}/supabase/rollback/20261120150000_no_food_result.sql"
refund_left=$("${PSQL[@]}" -Atc "select count(*) from pg_proc where proname='trial_scan_refund'")
[ "${refund_left}" = "0" ] || { echo "FAIL: trial_scan_refund survived its rollback" >&2; exit 1; }
refund_col=$("${PSQL[@]}" -Atc "select count(*) from information_schema.columns where table_schema='public' and table_name='trial_devices' and column_name='no_food_refunds'")
[ "${refund_col}" = "0" ] || { echo "FAIL: no_food_refunds survived its rollback" >&2; exit 1; }
no_food_event=$("${PSQL[@]}" -Atc "select count(*) from pg_constraint where conname='trial_funnel_daily_event' and pg_get_constraintdef(oid) like '%analysis_no_food%'")
[ "${no_food_event}" = "0" ] || { echo "FAIL: the restored allowlist still names analysis_no_food" >&2; exit 1; }
echo "ok - the no-food refund rolls back: function, columns and the extra event all gone"
apply "${ROOT}/supabase/rollback/20261120120000_trial_funnel.sql"
funnel_left=$("${PSQL[@]}" -Atc "select count(*) from information_schema.tables where table_schema='public' and table_name='trial_funnel_daily'")
[ "${funnel_left}" = "0" ] || { echo "FAIL: trial_funnel_daily survived its rollback" >&2; exit 1; }
apply "${ROOT}/supabase/rollback/20261114120000_trial_anonymous.sql"
"${PSQL[@]}" -f "${TESTS}/all_migrations/after_anonymous_rollback.sql"
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
apply "${MIGRATIONS}/20261114120000_trial_anonymous.sql"
apply "${MIGRATIONS}/20261120120000_trial_funnel.sql"
apply "${MIGRATIONS}/20261120150000_no_food_result.sql"
apply "${MIGRATIONS}/20261120160000_open_signups.sql"
apply "${MIGRATIONS}/20261120170000_global_analysis_cap.sql"
apply "${MIGRATIONS}/20261120180000_open_signups_post_login.sql"
apply "${MIGRATIONS}/20261120200000_link_only_google.sql"
apply "${MIGRATIONS}/20261121090000_no_password_claim.sql"
refund_back=$("${PSQL[@]}" -Atc "select count(*) from pg_proc where proname='trial_scan_refund'")
[ "${refund_back}" = "1" ] || { echo "FAIL: trial_scan_refund missing after the no-food migration reapplied" >&2; exit 1; }
funnel_back=$("${PSQL[@]}" -Atc "select count(*) from information_schema.tables where table_schema='public' and table_name='trial_funnel_daily'")
[ "${funnel_back}" = "1" ] || { echo "FAIL: trial_funnel_daily missing after the funnel migration reapplied" >&2; exit 1; }
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

# The fat share is one column and one constraint; the round trip is here because a column with a
# default is the kind of change that looks reversible and is not if the constraint is left behind.
apply "${ROOT}/supabase/rollback/20261118120000_fat_share.sql"
fat_col=$("${PSQL[@]}" -Atc "select count(*) from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='fat_share'")
[ "${fat_col}" = "0" ] || { echo "FAIL: fat_share survived its rollback" >&2; exit 1; }
fat_con=$("${PSQL[@]}" -Atc "select count(*) from pg_constraint where conname='profiles_fat_share_range'")
[ "${fat_con}" = "0" ] || { echo "FAIL: profiles_fat_share_range survived its rollback" >&2; exit 1; }
apply "${MIGRATIONS}/20261118120000_fat_share.sql"
fat_col=$("${PSQL[@]}" -Atc "select count(*) from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='fat_share'")
[ "${fat_col}" = "1" ] || { echo "FAIL: fat_share missing after the fat share migration reapplied" >&2; exit 1; }
echo "ok - the fat share migration rolls back and applies again"

echo ""
echo "PASS: all migrations apply in order over their predecessors, and the trial, fibre and fat share rollbacks round-trip"
