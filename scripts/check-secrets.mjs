// Before a deploy: are the secrets this page needs set on the Cloudflare Pages project?
// Lists secret NAMES only (`wrangler pages secret list`; values are never shown or printed).
//   node scripts/check-secrets.mjs
// Exit 0 = OK; 1 = a needed secret is missing (do not deploy); 3 = could not check (deploy.sh then asks you
// to confirm). Always needed: PASS_SECRET and ORGANIZER_PASSWORD; with class_code.use_code true also CLASS_CODE.
// The server also fails closed (503) without them, so a skipped check can't open the page or Organizer mode.
// WRANGLER (env) overrides the command, e.g. for tests: WRANGLER="node fake-wrangler.mjs".
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(new URL('../site.config.json', import.meta.url), 'utf8'));
const project = cfg.site.project_name;
const useCode = !!cfg.class_code?.use_code;
const need = [...(useCode ? ['CLASS_CODE'] : []), 'PASS_SECRET', 'ORGANIZER_PASSWORD'];

let out;
try {
  out = execSync(`${process.env.WRANGLER || 'npx wrangler'} pages secret list --project-name ${JSON.stringify(project)}`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  console.error(`Could not list the secrets of Pages project "${project}" (not logged in, no network, or the project doesn't exist yet).`);
  process.exit(3);
}
if (!/has access to the following secrets/.test(out)) {
  console.error(`Unexpected answer from "wrangler pages secret list" for "${project}"; could not check.`);
  process.exit(3);
}
const have = new Set([...out.matchAll(/^\s*-\s*([A-Za-z0-9_]+)\s*:/gm)].map(m => m[1]));
const missing = need.filter(n => !have.has(n));
if (missing.length) {
  console.error(`Refusing: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set on Pages project "${project}"${missing.includes('CLASS_CODE') ? ' (class_code.use_code is true)' : ''}.`);
  console.error('Set the secrets first (README step 6), then run ./deploy.sh again:');
  if (missing.includes('CLASS_CODE')) console.error(`  npx wrangler pages secret put CLASS_CODE --project-name ${project}`);
  if (missing.includes('PASS_SECRET')) console.error(`  openssl rand -base64 32 | npx wrangler pages secret put PASS_SECRET --project-name ${project}`);
  if (missing.includes('ORGANIZER_PASSWORD')) console.error(`  npx wrangler pages secret put ORGANIZER_PASSWORD --project-name ${project}   (10+ characters; type it at the prompt)`);
  process.exit(1);
}
if (!useCode && have.has('CLASS_CODE')) console.warn(`Note: class_code.use_code is false, but CLASS_CODE is set on "${project}", so the page WILL ask for the code.`);
console.log(`Secrets OK for "${project}": ${need.join(', ')} set${useCode ? '' : ' (class code off)'}.`);
