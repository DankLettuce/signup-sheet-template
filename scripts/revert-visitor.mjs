// Revert everything one visitor changed since a given Eastern time.
//   node scripts/revert-visitor.mjs --list --since "2026-10-25 14:00"            # who changed what
//   node scripts/revert-visitor.mjs --visitor <hash> --since "2026-10-25 14:00" --dry-run
//   node scripts/revert-visitor.mjs --ip 203.0.113.7 --since "2026-10-25 14:00"   # hashes the IP (IPv6 -> /64) with the site's salt:
//   set env VISITOR_SALT (or PASS_SECRET, if the site has no VISITOR_SALT) to the same value as the Pages secret, or pass --salt
// Add --remote for production (default is the local dev DB). Optional --until "...".
// Each touched row is put back to how it was before the visitor's FIRST change in the
// window (sign-ups they added are removed). A summary row is written to history.
import { q, d1, flag, opt, lit, etToUtc, utcToEt, REMOTE } from './_d1.mjs';
import { visitorKey, hashVisitor, visitorSalt } from '../lib/visitor.js';

const since = etToUtc(opt('since'));
const until = opt('until') ? etToUtc(opt('until')) : '9999-12-31 00:00:00';
console.log(`Window (UTC): ${since} .. ${until}  [${REMOTE ? 'REMOTE production' : 'local'}]`);

if (flag('list')) {
  const rows = q(`SELECT who, COUNT(*) AS changes, MIN(at) AS first, MAX(at) AS last,
    SUM(action='delete') AS deletes, SUM(action='update') AS edits, SUM(action='create') AS adds
    FROM history WHERE at >= ${lit(since)} AND at < ${lit(until)} AND who != 'admin' GROUP BY who ORDER BY changes DESC`);
  for (const r of rows) console.log(`${r.who}  changes=${r.changes} adds=${r.adds} edits=${r.edits} deletes=${r.deletes}  ${utcToEt(r.first)} → ${utcToEt(r.last)}`);
  if (!rows.length) console.log('No changes in that window.');
  process.exit(0);
}

const who = opt('visitor') || (opt('ip') && await hashVisitor(visitorKey(opt('ip')), opt('salt') || visitorSalt(process.env)));
if (!who || !/^[0-9a-f]{24}$/.test(who)) { console.error('Need --visitor <24-hex hash> or --ip <address>'); process.exit(2); }

const hist = q(`SELECT id, at, action, tbl, row_id, before_json FROM history
  WHERE who = ${lit(who)} AND at >= ${lit(since)} AND at < ${lit(until)} AND tbl IN ('entries','items','settings') ORDER BY id DESC`);
if (!hist.length) { console.log('Nothing to revert for', who); process.exit(0); }

const from = h => `FROM (SELECT before_json AS b FROM history WHERE id = ${h.id}) AS h`;
const sql = [];
for (const h of hist) { // newest first, so the oldest "before" wins
  if (h.tbl === 'settings') {
    sql.push(`UPDATE settings SET value = COALESCE((SELECT json_extract(before_json, '$.value') FROM history WHERE id = ${h.id}), 'TBD'), updated_at = datetime('now') WHERE key = ${lit(h.row_id)};`);
  } else if (!h.before_json) {
    sql.push(`UPDATE ${h.tbl} SET deleted_at = datetime('now') WHERE id = ${Number(h.row_id)} AND deleted_at IS NULL;`);
  } else if (h.tbl === 'entries') {
    sql.push(`UPDATE entries SET name = json_extract(h.b, '$.name'), note = json_extract(h.b, '$.note'), qty = json_extract(h.b, '$.qty'), deleted_at = json_extract(h.b, '$.deleted_at'), updated_at = datetime('now') ${from(h)} WHERE entries.id = ${Number(h.row_id)};`);
  } else {
    sql.push(`UPDATE items SET name = json_extract(h.b, '$.name'), needed = json_extract(h.b, '$.needed'), deleted_at = json_extract(h.b, '$.deleted_at'), updated_at = datetime('now') ${from(h)} WHERE items.id = ${Number(h.row_id)};`);
  }
}
const ids = hist.map(h => h.id);
sql.push(`INSERT INTO history(who, action, tbl, row_id, after_json) VALUES ('admin', 'revert-visitor', 'history', ${lit(who)}, ${lit(JSON.stringify({ since, until, history_ids: ids }))});`);

// Warn if someone else changed the same rows afterwards (their later edit gets overwritten).
const later = q(`SELECT DISTINCT tbl, row_id FROM history WHERE who != ${lit(who)} AND who != 'admin' AND id > ${Math.min(...ids)}
  AND (tbl || ':' || row_id) IN (${[...new Set(hist.map(h => lit(h.tbl + ':' + h.row_id)))].join(',')})`);
console.log(`Visitor ${who}: ${hist.length} change(s) to revert` + (later.length ? `\nWARNING: later changes by others to: ${later.map(r => r.tbl + ' ' + r.row_id).join(', ')}` : ''));
for (const h of [...hist].reverse()) console.log(`  #${h.id} ${utcToEt(h.at)} ${h.action} ${h.tbl} ${h.row_id}`);
if (flag('dry-run')) { console.log('\n-- SQL (dry run, nothing changed):\n' + sql.join('\n')); process.exit(0); }
d1(sql.join('\n'));
console.log('Reverted.');
