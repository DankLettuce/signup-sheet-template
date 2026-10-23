#!/usr/bin/env bash
# First-time setup + deploys for ONE sign-up page (see README "Make a new sign-up page (step by step)").
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

# 0) Secrets: PASS_SECRET and ORGANIZER_PASSWORD (and CLASS_CODE when class_code.use_code is true) must be set on
#    the Pages project FIRST (README step 6). Only secret names are listed, never values. If they can't be checked, you must confirm:
#    type "secrets are set" at the prompt, or run CONFIRM_SECRETS=yes ./deploy.sh (non-interactive).
set +e; node scripts/check-secrets.mjs; RC=$?; set -e
if [ "$RC" -eq 1 ]; then exit 1; fi
if [ "$RC" -ne 0 ]; then
  if [ "${CONFIRM_SECRETS:-}" = "yes" ]; then echo "CONFIRM_SECRETS=yes: continuing without the secrets check."
  elif [ -t 0 ]; then
    read -r -p 'Could not check the secrets. Type "secrets are set" to deploy anyway: ' ANS
    [ "$ANS" = "secrets are set" ] || { echo "Stopped. Set the secrets (README step 6), then run ./deploy.sh again."; exit 1; }
  else echo "Refusing: could not check the secrets and there is no terminal to confirm. Re-run with CONFIRM_SECRETS=yes once they are set."; exit 1; fi
fi

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
