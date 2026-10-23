// Turn site.config.json into the files a new sign-up page needs. Safe to re-run.
//   node scripts/configure.mjs                         # uses site.config.json
//   node scripts/configure.mjs --config my.json        # another config file
//   node scripts/configure.mjs --from event-copy.json  # start from a "Copy this event" file (merged into the config, then written back)
//   node scripts/configure.mjs --check                 # only validate, write nothing
// Writes: seed.sql (event details + starting items; only fills an EMPTY database), wrangler.toml,
// worker-backup/wrangler.toml, and the theme paths in public/index.html.
// It never touches Cloudflare and never reads or writes the class code (that is a secret, see README).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS, ITEM_LIMITS } from '../lib/settings.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2), opt = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
const cfgPath = join(ROOT, opt('config') || 'site.config.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const errs = [];

if (opt('from')) { // "Copy this event" file from the Organizer page
  const copy = JSON.parse(readFileSync(opt('from'), 'utf8'));
  if (copy.format !== 'signup-event-copy') { console.error('Not a "Copy this event" file (format should be signup-event-copy)'); process.exit(2); }
  cfg.event = { ...cfg.event, ...copy.event };
  if (copy.organizer) cfg.organizer = { ...cfg.organizer, ...copy.organizer };
  if (copy.add_your_own) cfg.add_your_own = copy.add_your_own;
  if (Array.isArray(copy.items)) cfg.items = copy.items.map(i => ({ name: i.name, spots: i.spots }));
  console.log(`Merged ${opt('from')}: ${cfg.items.length} items, event "${cfg.event.event_name}". Change the date/time and anything else in ${cfgPath} as needed.`);
}

// ---- validate ----
const site = cfg.site || {}, ev = cfg.event || {}, org = cfg.organizer || {};
const slug = /^[a-z0-9][a-z0-9-]{0,56}[a-z0-9]$/;
if (!slug.test(site.project_name || '')) errs.push('site.project_name: lowercase letters, numbers and dashes (it becomes <name>.pages.dev)');
if (!slug.test(site.database_name || '')) errs.push('site.database_name: lowercase letters, numbers and dashes');
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(site.database_id || '')) errs.push('site.database_id: the D1 database id (use 00000000-0000-0000-0000-000000000000 until it exists)');
const theme = site.theme || 'vintage-poster';
if (!/^[a-z0-9-]+$/.test(theme) || !existsSync(join(ROOT, 'public/themes', theme, 'tokens.css'))) errs.push(`site.theme: no folder public/themes/${theme}/ with tokens.css`);
try { new Intl.DateTimeFormat('en-US', { timeZone: site.timezone || 'America/New_York' }); } catch { errs.push('site.timezone: not a time zone name like America/New_York'); }
const settings = { ...Object.fromEntries(Object.entries(ev).filter(([k]) => !k.startsWith('_'))), organizer_name: org.name ?? '', organizer_contact: org.contact ?? '', add_your_own: cfg.add_your_own || 'bottom' };
for (const [k, v] of Object.entries(settings)) {
  const d = SETTINGS[k];
  if (!d) { errs.push(`event.${k}: unknown field (allowed: ${Object.keys(SETTINGS).join(', ')})`); continue; }
  if (d.one_of && !d.one_of.includes(v)) errs.push(`${k}: must be one of ${d.one_of.join(', ')}`);
  if (!d.one_of && (typeof v !== 'string' || [...v].length > d.max)) errs.push(`${k}: text of at most ${d.max} characters`);
}
const items = cfg.items || [];
if (!Array.isArray(items) || !items.length) errs.push('items: at least one item');
if (items.length > ITEM_LIMITS.maxItems) errs.push(`items: at most ${ITEM_LIMITS.maxItems}`);
const seen = new Set();
items.forEach((it, i) => {
  if (!it || typeof it.name !== 'string' || !it.name.trim() || [...it.name].length > ITEM_LIMITS.itemName) errs.push(`items[${i}].name: 1-${ITEM_LIMITS.itemName} characters`);
  else if (seen.has(it.name.trim().toLowerCase())) errs.push(`items[${i}].name: "${it.name}" is listed twice`); else seen.add(it.name.trim().toLowerCase());
  if (!Number.isInteger(it.spots) || it.spots < 1 || it.spots > ITEM_LIMITS.spotsMax) errs.push(`items[${i}].spots: a whole number 1-${ITEM_LIMITS.spotsMax}`);
});
if (cfg.class_code && typeof cfg.class_code.use_code !== 'boolean') errs.push('class_code.use_code: true or false');
if (cfg.class_code && Object.keys(cfg.class_code).some(k => /^(code|value|secret)$/i.test(k))) errs.push('class_code: do not put the code itself in the config file (use the CLASS_CODE secret)');
if (errs.length) { console.error('site.config.json has problems:\n- ' + errs.join('\n- ')); process.exit(1); }
if (argv.includes('--check')) { console.log('Config OK.'); process.exit(0); }

// ---- write ----
const lit = s => `'${String(s).replace(/'/g, "''")}'`;
const seed = [
  '-- GENERATED by scripts/configure.mjs from site.config.json. Only fills an EMPTY database (safe to re-run).',
  'INSERT OR IGNORE INTO settings(key, value) VALUES',
  Object.entries(settings).map(([k, v]) => `  (${lit(k)}, ${lit(v === '' && SETTINGS[k].def === 'TBD' ? 'TBD' : v)})`).join(',\n') + ';',
  '',
  'INSERT INTO items(name, needed, sort)',
  'SELECT * FROM (VALUES',
  items.map((it, i) => `  (${lit(it.name.trim())}, ${it.spots}, ${(i + 1) * 10})`).join(',\n'),
  ') WHERE NOT EXISTS (SELECT 1 FROM items);',
  '',
].join('\n');
writeFileSync(join(ROOT, 'seed.sql'), seed);

writeFileSync(join(ROOT, 'wrangler.toml'), `# GENERATED by scripts/configure.mjs from site.config.json (edit the config, not this file).
# Cloudflare Pages project config. Secrets (CLASS_CODE, VISITOR_SALT) are NOT here: see README "Class code".
name = "${site.project_name}"
pages_build_output_dir = "public"
compatibility_date = "2026-10-01"

[[d1_databases]]
binding = "DB"
database_name = "${site.database_name}"
database_id = "${site.database_id}"

[vars]
TIMEZONE = "${site.timezone || 'America/New_York'}"   # export times + calendar (America/New_York gets a real time zone; others use local time)
RATE_LIMIT = "40"        # ROWS per visitor per window (a batch counts each sign-up; other writes 1)
RATE_WINDOW_SEC = "600"  # 10 minutes
RATE_BURST = "5"         # burst: REQUESTS per visitor per short window (a batch is one)
RATE_BURST_SEC = "10"
VISITOR_CAP = "25"       # live (non-removed) sign-ups per visitor; removing one frees a slot
`);
writeFileSync(join(ROOT, 'worker-backup/wrangler.toml'), `# GENERATED by scripts/configure.mjs. Optional companion Worker: daily JSON snapshot of the sign-up data
# into the \`snapshots\` table. Uses the SAME D1 database as the Pages project.
name = "${site.project_name}-backup"
main = "src/index.js"
compatibility_date = "2026-10-01"
workers_dev = false   # no public URL; cron only

[triggers]
crons = ["0 9 * * *"]  # once a day, 09:00 UTC

[[d1_databases]]
binding = "DB"
database_name = "${site.database_name}"
database_id = "${site.database_id}"

[vars]
STOP_AFTER = "${stopAfter(ev.party_date)}"  # stop snapshotting after this date (about 3 weeks after the event)
`);
function stopAfter(d) {
  const m = String(d || '').match(/(\d{4})/); const y = m ? +m[1] : new Date().getUTCFullYear();
  const t = Date.parse(String(d).replace(/^[A-Za-z]+,\s*/, '')); const base = isNaN(t) ? new Date(Date.UTC(y, 11, 31)) : new Date(t);
  return new Date(base.getTime() + 21 * 86400000).toISOString().slice(0, 10);
}

// theme: every /themes/<name>/ path in index.html points at the chosen theme
const idx = join(ROOT, 'public/index.html');
const html = readFileSync(idx, 'utf8').replace(/\/themes\/[a-z0-9-]+\//g, `/themes/${theme}/`);
const missing = [...new Set([...html.matchAll(/\/themes\/[a-z0-9-]+\/[^"' )]+/g)].map(m => m[0]))].filter(f => !existsSync(join(ROOT, 'public', f)));
if (missing.length) { console.error(`Theme "${theme}" is missing files the page uses (add them, or pick another theme):\n- ` + missing.join('\n- ')); process.exit(1); }
writeFileSync(idx, html);

console.log(`Configured "${site.project_name}": ${items.length} items, theme ${theme}, class code ${cfg.class_code?.use_code ? 'ON (set the CLASS_CODE secret)' : 'off'}.
Wrote seed.sql, wrangler.toml, worker-backup/wrangler.toml, public/index.html (theme paths).`);
if (opt('from')) { writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n'); console.log('Updated ' + cfgPath); }
