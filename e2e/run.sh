#!/usr/bin/env bash
# Starts the app against a local Supabase stack and runs the sign-in suite against it.
#
# Nothing here reads production: the keys come from the local stack, they are written to .env.e2e
# (gitignored), and the suite refuses any host that is not this machine. The stack config lives in
# supabase/config.e2e.toml and is copied into a gitignored workdir, so a fresh clone (and CI) can run
# this without any local setup beyond docker.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# colima on a laptop, plain docker on CI.
if [ -z "${DOCKER_HOST-}" ] && [ -d "${HOME}/.colima/default" ]; then
  export DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"
  export DOCKER_CONFIG="${DOCKER_CONFIG:-${ROOT}/.e2e/docker-config}"
fi

mkdir -p .e2e/supabase .e2e/docker-config
cp supabase/config.e2e.toml .e2e/supabase/config.toml
[ -f .e2e/docker-config/config.json ] || printf '{\n  "auths": {}\n}\n' > .e2e/docker-config/config.json

npx supabase start --workdir .e2e --exclude studio,realtime,imgproxy,logflare,vector,edge-runtime,pg-meta,supavisor > /tmp/e2e-stack.log 2>&1

eval "$(npx supabase status --workdir .e2e -o env | grep -E "^(API_URL|ANON_KEY|MAILPIT_URL|DB_URL)=")"

cat > .env.e2e <<ENVFILE
VITE_SUPABASE_URL=$API_URL
VITE_SUPABASE_PUBLISHABLE_KEY=$ANON_KEY
VITE_SUPABASE_PROJECT_ID=e2e
VITE_PARSE_MEAL_URL=http://127.0.0.1:9/parse-meal
VITE_TURNSTILE_SITE_KEY=${E2E_TURNSTILE_SITE_KEY-1x00000000000000000000AA}
VITE_TRIAL_REQUIRE_EMAIL=false
ENVFILE

export E2E_MAILPIT_URL="$MAILPIT_URL"
export E2E_DB_URL="$DB_URL"

# The local database is rebuilt from the migration files on every run. Without this a suite can
# pass against a function body that has since been edited, which is exactly what happened once: the
# stack was still running the previous auth_entry_state and case (b) failed for a rule already
# replaced. E2E_NO_RESET=1 skips it when iterating on the suite itself.
if [ "${E2E_NO_RESET-}" != "1" ]; then
  npx supabase db reset --workdir .e2e > /tmp/e2e-reset.log 2>&1
fi

npx vite dev --mode e2e --port 5173 --strictPort > /tmp/e2e-vite.log 2>&1 &
VITE_PID=$!
trap "kill $VITE_PID 2>/dev/null || true" EXIT

for _ in $(seq 1 120); do
  if curl -fsS http://127.0.0.1:5173/auth > /dev/null 2>&1; then break; fi
  sleep 0.5
done

npx playwright test "$@"