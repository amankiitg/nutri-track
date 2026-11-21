#!/usr/bin/env bash
# Case j: the same app with CAPTCHA off, which is a different stack. It rewrites the local config,
# restarts it, writes an .env.e2e with no site key, and runs the one spec that needs that.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

export DOCKER_HOST="${DOCKER_HOST:-unix://${HOME}/.colima/default/docker.sock}"
export DOCKER_CONFIG="${DOCKER_CONFIG:-${ROOT}/.e2e/docker-config}"
CONFIG=".e2e/supabase/config.toml"
cp "$CONFIG" "$CONFIG.captcha-on"
restore() { mv "$CONFIG.captcha-on" "$CONFIG"; }
trap restore EXIT

# enabled = true under [auth.captcha] becomes false for this run.
perl -0pi -e "s/(\[auth\.captcha\]\nenabled = )true/\${1}false/" "$CONFIG"
npx supabase stop --workdir .e2e --no-backup > /dev/null 2>&1 || true
npx supabase start --workdir .e2e --exclude studio,realtime,imgproxy,logflare,vector,edge-runtime,pg-meta,supavisor > /tmp/e2e-captcha-off-stack.log 2>&1

eval "$(npx supabase status --workdir .e2e -o env | grep -E "^(API_URL|ANON_KEY|MAILPIT_URL|DB_URL)=")"

cat > .env.e2e <<ENVFILE
VITE_SUPABASE_URL=$API_URL
VITE_SUPABASE_PUBLISHABLE_KEY=$ANON_KEY
VITE_SUPABASE_PROJECT_ID=e2e
VITE_PARSE_MEAL_URL=http://127.0.0.1:9/parse-meal
VITE_TURNSTILE_SITE_KEY=
VITE_TRIAL_REQUIRE_EMAIL=false
ENVFILE

export E2E_MAILPIT_URL="$MAILPIT_URL"
export E2E_DB_URL="$DB_URL"
export E2E_CAPTCHA_OFF=1

npx vite dev --mode e2e --port 5173 --strictPort > /tmp/e2e-vite-captcha-off.log 2>&1 &
VITE_PID=$!
trap "kill $VITE_PID 2>/dev/null || true; restore" EXIT

for _ in $(seq 1 120); do
  if curl -fsS http://127.0.0.1:5173/auth > /dev/null 2>&1; then break; fi
  sleep 0.5
done

npx playwright test e2e/captcha-off.spec.ts "$@"