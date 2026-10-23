#!/usr/bin/env bash
# First-time setup + deploys for ONE sign-up page (see README "Put it online").
# Requires: node >= 22, `npx wrangler login` (or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID with Pages + D1 edit),
# a real database_id in site.config.json (then `node scripts/configure.mjs`), and a clean git tree.
#   ./deploy.sh            # back up the database, apply schema + seed (empty DB only), deploy the page
#   ./deploy.sh --worker   # also deploy the optional daily-snapshot Worker
set -euo pipefail
cd "$(dirname "$0")"
node scripts/configure.mjs --check
PROJECT=$(node -e "console.log(require('./site.config.json').site.project_name)")
DB=$(node -e "console.log(require('./site.config.json').site.database_name)")

[ -z "$(git status --porcelain)" ] || { echo "Refusing: git tree not clean. Commit first."; exit 1; }
grep -q '00000000-0000-0000-0000-000000000000' wrangler.toml && { echo "Refusing: placeholder database_id. Create the D1 database, put its id in site.config.json, run node scripts/configure.mjs, commit."; exit 1; }

# 1) Backup the database before any deploy (kept out of git)
mkdir -p backups
STAMP=$(date +%Y%m%d-%H%M%S)
npx wrangler d1 export "$DB" --remote --output "backups/$DB-$STAMP.sql"
echo "Backup: backups/$DB-$STAMP.sql"

# 2) Schema is idempotent; the seed only fills an EMPTY database (never overwrites the organizer's edits)
npx wrangler d1 execute "$DB" --remote --file schema.sql
npx wrangler d1 execute "$DB" --remote --file seed.sql

# 3) Optional daily snapshot Worker (cron; no public URL). Same D1 database.
[ "${1:-}" = "--worker" ] && npx wrangler deploy -c worker-backup/wrangler.toml

# 4) Ship straight to production (no preview branch)
npx wrangler pages deploy public --project-name "$PROJECT" --branch main --commit-hash "$(git rev-parse HEAD)" --commit-message "$(git log -1 --pretty=%s)"
