#!/usr/bin/env bash
# Local-only dev server: applies schema.sql + seed.sql to a LOCAL D1 copy, then serves on 127.0.0.1:8788.
# Nothing here talks to Cloudflare. Run `node scripts/configure.mjs` first (it writes seed.sql).
#   CLASS_CODE=BOO-123 PASS_SECRET="$(openssl rand -base64 32)" scripts/dev.sh   # with a class code (made-up code)
#     (CLASS_CODE without a PASS_SECRET of 32+ random bytes: the API refuses to serve, on purpose (fail closed))
#   add ORGANIZER_PASSWORD=<made-up, 10+ characters> for Organizer mode (without it organizer actions answer 503)
#   scripts/dev.sh                          # no class code (open page)
#   PERSIST=/tmp/fresh scripts/dev.sh       # a fresh, empty local database
# TEST_HOOKS=1 enables the batch rollback test hooks (X-Test-Fail-After / X-Test-Skip-Precheck); never set in production.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f seed.sql ] || node scripts/configure.mjs
P="${PERSIST:-.wrangler/state}"
npx wrangler d1 execute DB --local --persist-to "$P" --file schema.sql >/dev/null
npx wrangler d1 execute DB --local --persist-to "$P" --file seed.sql >/dev/null
EXTRA=(--binding TEST_HOOKS=1)
[ -n "${CLASS_CODE:-}" ] && EXTRA+=(--binding "CLASS_CODE=$CLASS_CODE")
[ -n "${PASS_SECRET:-}" ] && EXTRA+=(--binding "PASS_SECRET=$PASS_SECRET")
[ -n "${ORGANIZER_PASSWORD:-}" ] && EXTRA+=(--binding "ORGANIZER_PASSWORD=$ORGANIZER_PASSWORD")
[ -z "${ORGANIZER_PASSWORD:-}" ] && echo 'dev.sh: no ORGANIZER_PASSWORD, so organizer actions answer 503 (setup needed).' >&2
[ -n "${CLASS_CODE:-}" ] && [ -z "${PASS_SECRET:-}" ] && echo 'dev.sh: CLASS_CODE is set without PASS_SECRET, so the API will answer 503 (setup needed).' >&2
[ -n "${TIMEZONE:-}" ] && EXTRA+=(--binding "TIMEZONE=$TIMEZONE")
exec npx wrangler pages dev public --local --persist-to "$P" --port "${PORT:-8788}" --ip 127.0.0.1 "${EXTRA[@]}" "$@"
