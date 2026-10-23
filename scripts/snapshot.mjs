// Snapshots of settings/items/entries (the daily cron in worker-backup writes kind='daily').
//   node scripts/snapshot.mjs list
//   node scripts/snapshot.mjs take
//   node scripts/snapshot.mjs restore <id|latest> [--dry-run]
// Add --remote for production (default: local dev DB). Restore takes a 'pre-restore' snapshot first.
import { q, d1, args, flag, utcToEt, REMOTE } from './_d1.mjs';
import { SNAPSHOT_SQL, restoreSql } from '../lib/snapshot.js';

const [cmd, which] = args.filter(a => !a.startsWith('--'));
console.log(`[${REMOTE ? 'REMOTE production' : 'local'}]`);
if (cmd === 'list') {
  for (const r of q(`SELECT id, at, kind, json_array_length(data, '$.entries') AS entries, json_array_length(data, '$.items') AS items, length(data) AS bytes FROM snapshots ORDER BY id DESC LIMIT 60`))
    console.log(`#${r.id}  ${utcToEt(r.at)}  ${r.kind}  items=${r.items} entries=${r.entries}  ${r.bytes}B`);
} else if (cmd === 'take') {
  d1(SNAPSHOT_SQL.replace('?1', "'manual'") + ';');
  console.log('Saved snapshot #' + q('SELECT MAX(id) AS id FROM snapshots')[0].id);
} else if (cmd === 'restore' && which) {
  const id = which === 'latest' ? q("SELECT MAX(id) AS id FROM snapshots WHERE kind != 'pre-restore'")[0].id : Number(which);
  const snap = id && q(`SELECT id, at, kind FROM snapshots WHERE id = ${Number(id)}`)[0];
  if (!snap) { console.error('No such snapshot:', which); process.exit(2); }
  const sql = restoreSql(snap.id);
  console.log(`Restoring snapshot #${snap.id} (${snap.kind}, ${utcToEt(snap.at)})`);
  if (flag('dry-run')) { console.log(sql); process.exit(0); }
  d1(sql);
  console.log('Restored. Undo with: node scripts/snapshot.mjs restore ' + q("SELECT MAX(id) AS id FROM snapshots WHERE kind = 'pre-restore'")[0].id + (REMOTE ? ' --remote' : ''));
} else { console.error('usage: list | take | restore <id|latest> [--dry-run] [--remote]'); process.exit(2); }
