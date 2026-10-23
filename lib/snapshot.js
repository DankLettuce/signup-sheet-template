// Shared SQL for JSON snapshots (used by worker-backup cron and scripts/snapshot.mjs).
const cols = {
  settings: ['key', 'value', 'updated_at'],
  items: ['id', 'name', 'needed', 'sort', 'is_custom', 'created_at', 'updated_at', 'deleted_at'],
  entries: ['id', 'item_id', 'name', 'note', 'qty', 'created_at', 'updated_at', 'deleted_at'],
};
const arr = t => `json((SELECT json_group_array(json_object(${cols[t].map(c => `'${c}', ${c}`).join(', ')})) FROM ${t}))`;

// INSERT one snapshot row. kind is bound as ?1 (D1) or inlined by the CLI script.
export const SNAPSHOT_SQL = `INSERT INTO snapshots(kind, data) SELECT ?1, json_object('settings', ${arr('settings')}, 'items', ${arr('items')}, 'entries', ${arr('entries')})`;
export const PRUNE_SQL = `DELETE FROM snapshots WHERE kind = 'daily' AND at < datetime('now', '-45 days')`;

// Full restore of settings/items/entries from snapshot id N (history is kept; a
// 'pre-restore' snapshot is taken first so the restore itself can be undone).
export function restoreSql(id) {
  if (!Number.isInteger(id) || id < 1) throw new Error('bad snapshot id');
  const ins = t => `INSERT INTO ${t}(${cols[t].join(', ')}) SELECT ${cols[t].map(c => `json_extract(j.value, '$.${c}')`).join(', ')} FROM snapshots s, json_each(s.data, '$.${t}') j WHERE s.id = ${id};`;
  return [
    SNAPSHOT_SQL.replace('?1', "'pre-restore'") + ';',
    'DELETE FROM entries;', 'DELETE FROM items;', 'DELETE FROM settings;',
    ins('settings'), ins('items'), ins('entries'),
    `INSERT INTO history(who, action, tbl, row_id) VALUES ('admin', 'restore-snapshot', 'snapshots', '${id}');`,
  ].join('\n');
}
