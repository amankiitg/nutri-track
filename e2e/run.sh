#!/usr/bin/env bash
# Starts the app against the local stack and runs the sign-in suite against it.
#
# Nothing here reads production: the keys come from the local stack, they are written to .env.e2e
# (gitignored), and the suite refuses any host that is not this machine.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

export DOCKER_HOST="${DOCKER_HOST:-unix://${HOME}/.colima/default/docker.sock}"
export DOCKER_CONFIG="${DOCKER_CONFIG:-${ROOT}/.e2e/docker-config}"

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

npx vite dev --mode e2e --port 5173 --strictPort > /tmp/e2e-vite.log 2>&1 &
VITE_PID=$!
trap "kill $VITE_PID 2>/dev/null || true" EXIT

for _ in $(seq 1 120); do
  if curl -fsS http://127.0.0.1:5173/auth > /dev/null 2>&1; then break; fi
  sleep 0.5
done

npx playwright test "$@"