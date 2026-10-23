#!/usr/bin/env bash
# Local-only dev server: applies schema.sql + seed.sql to a LOCAL D1 copy, then serves on 127.0.0.1:8788.
# Nothing here talks to Cloudflare. Run `node scripts/configure.mjs` first (it writes seed.sql).
#   CLASS_CODE=BOO-123 scripts/dev.sh       # with a class code (any made-up code for testing)
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
[ -n "${TIMEZONE:-}" ] && EXTRA+=(--binding "TIMEZONE=$TIMEZONE")
exec npx wrangler pages dev public --local --persist-to "$P" --port "${PORT:-8788}" --ip 127.0.0.1 "${EXTRA[@]}" "$@"
