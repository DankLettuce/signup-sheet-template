// Offline test of deploy.sh's secrets check (QA round 1 item 2). No network, no Cloudflare: it runs deploy.sh in a
// throwaway copy of this repo with a FAKE `npx` first on PATH, which answers `wrangler pages secret list` as told
// and only logs every other command (backup, schema, deploy). Usage: node scripts/test-deploy.mjs
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
let pass = 0, fail = 0;
const ok = (c, n, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x && !c ? '  -> ' + x : ''}`); };
const tmp = mkdtempSync(join(tmpdir(), 'signup-deploy-test-'));
try {
  const repo = join(tmp, 'repo'), bin = join(tmp, 'bin'), log = join(tmp, 'npx.log');
  execSync(`mkdir -p "${repo}" "${bin}" && tar -C "${ROOT}" --exclude ./node_modules --exclude ./.git --exclude ./.wrangler --exclude ./backups --exclude ./PLAN-approved.md --exclude ./.dev.vars --exclude ./video --exclude ./feedback -cf - . | tar -C "${repo}" -xf -`);
  // fake npx: `wrangler pages secret list` answers per FAKE_SECRETS ("FAIL" = command fails); anything else is only logged
  writeFileSync(join(bin, 'npx'), `#!/usr/bin/env bash
echo "$*" >> "${log}"
if [ "$1 $2 $3 $4" = "wrangler pages secret list" ]; then
  [ "\${FAKE_SECRETS:-}" = "FAIL" ] && { echo "Authentication error" >&2; exit 1; }
  echo 'The "production" environment of your Pages project "x" has access to the following secrets:'
  for n in \${FAKE_SECRETS:-}; do echo "  - $n: Value Encrypted"; done
fi
exit 0
`); chmodSync(join(bin, 'npx'), 0o755);
  const cfgPath = join(repo, 'site.config.json');
  const setup = useCode => {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.site.database_id = '12345678-1234-1234-1234-123456789abc'; cfg.class_code.use_code = useCode;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    execSync('node scripts/configure.mjs >/dev/null && git init -q 2>/dev/null; git add -A && git -c user.name="Software Engineer bot" -c user.email="se-bot@local" commit -qm test --allow-empty', { cwd: repo });
  };
  const run = (env) => {
    rmSync(log, { force: true });
    const r = spawnSync('bash', ['deploy.sh'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CONFIRM_SECRETS: '', ...env } });
    const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
    return { code: r.status, out: r.stdout + r.stderr, deployed: /pages deploy/.test(calls), backedUp: /d1 export/.test(calls) };
  };
  const ALL = 'CLASS_CODE PASS_SECRET ORGANIZER_PASSWORD';
  setup(true);
  let r = run({ FAKE_SECRETS: ALL });
  ok(r.code === 0 && r.backedUp && r.deployed, 'use_code on + CLASS_CODE, PASS_SECRET and ORGANIZER_PASSWORD set -> deploys', r.out);
  r = run({ FAKE_SECRETS: 'CLASS_CODE ORGANIZER_PASSWORD' });
  ok(r.code === 1 && !r.backedUp && !r.deployed && /PASS_SECRET is not set/.test(r.out) && /secret put PASS_SECRET/.test(r.out), 'PASS_SECRET missing -> refuses before anything runs, says how to set it', r.out);
  r = run({ FAKE_SECRETS: 'CLASS_CODE PASS_SECRET' });
  ok(r.code === 1 && !r.backedUp && !r.deployed && /ORGANIZER_PASSWORD is not set/.test(r.out) && /secret put ORGANIZER_PASSWORD/.test(r.out), 'ORGANIZER_PASSWORD missing -> refuses, says how to set it', r.out);
  r = run({ FAKE_SECRETS: 'PASS_SECRET ORGANIZER_PASSWORD' });
  ok(r.code === 1 && !r.deployed && /CLASS_CODE is not set/.test(r.out), 'use_code on, CLASS_CODE missing -> refuses', r.out);
  r = run({ FAKE_SECRETS: '' });
  ok(r.code === 1 && !r.deployed && /CLASS_CODE and PASS_SECRET and ORGANIZER_PASSWORD are not set/.test(r.out), 'no secrets -> refuses', r.out);
  r = run({ FAKE_SECRETS: 'FAIL' });
  ok(r.code === 1 && !r.backedUp && !r.deployed && /CONFIRM_SECRETS=yes/.test(r.out), "can't check + no terminal -> refuses and says how to confirm", r.out);
  r = run({ FAKE_SECRETS: 'FAIL', CONFIRM_SECRETS: 'yes' });
  ok(r.code === 0 && r.deployed, "can't check + CONFIRM_SECRETS=yes -> deploys (explicit confirmation)", r.out);
  r = run({ FAKE_SECRETS: 'FAIL', CONFIRM_SECRETS: 'y' });
  ok(r.code === 1 && !r.deployed, 'only CONFIRM_SECRETS=yes counts as confirmation', r.out);
  setup(false);
  r = run({ FAKE_SECRETS: 'PASS_SECRET ORGANIZER_PASSWORD' });
  ok(r.code === 0 && r.deployed, 'use_code off + PASS_SECRET and ORGANIZER_PASSWORD -> deploys (no CLASS_CODE needed)', r.out);
  r = run({ FAKE_SECRETS: 'PASS_SECRET' });
  ok(r.code === 1 && !r.deployed && /ORGANIZER_PASSWORD is not set/.test(r.out), 'use_code off still needs ORGANIZER_PASSWORD', r.out);
  r = run({ FAKE_SECRETS: ALL });
  ok(r.code === 0 && /WILL ask for the code/.test(r.out), 'use_code off but CLASS_CODE set on the project -> warns that the page will ask for the code', r.out);
  ok(!/deploy\.sh.*Put it online/.test(readFileSync(join(ROOT, 'deploy.sh'), 'utf8')) && readFileSync(join(ROOT, 'README.md'), 'utf8').includes('## Make a new sign-up page (step by step)')
    && readFileSync(join(ROOT, 'deploy.sh'), 'utf8').includes('README "Make a new sign-up page (step by step)"'), "deploy.sh points at a README section that exists");
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
