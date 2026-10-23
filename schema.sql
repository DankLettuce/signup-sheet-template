-- Class sign-up schema (idempotent; safe to re-run)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  needed INTEGER NOT NULL DEFAULT 1,   -- number of PEOPLE (spots); since round 3
  sort INTEGER NOT NULL DEFAULT 100,
  is_custom INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL DEFAULT 1,   -- unused since round 3 (one entry = one person); kept so the change is reversible
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_entries_item ON entries(item_id);
-- Every change is recorded here (before/after JSON) so anything can be restored.
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  who TEXT NOT NULL,          -- hashed IP, never the raw IP
  action TEXT NOT NULL,       -- create / update / delete / restore
  tbl TEXT NOT NULL,          -- entries / items / settings
  row_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  req TEXT                    -- client request id (makes retried writes idempotent)
);
CREATE INDEX IF NOT EXISTS idx_history_row ON history(tbl, row_id);
CREATE INDEX IF NOT EXISTS idx_history_who ON history(who, at);
CREATE INDEX IF NOT EXISTS idx_history_req ON history(req) WHERE req IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_deleted ON entries(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_items_deleted ON items(deleted_at) WHERE deleted_at IS NOT NULL;
-- Daily JSON snapshots of settings/items/entries (written by worker-backup cron).
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL DEFAULT 'daily',   -- daily / manual / pre-restore
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rate (
  who TEXT NOT NULL,
  win INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (who, win)
);

-- No seed here: event details and the starting item list come from site.config.json
-- (node scripts/configure.mjs writes seed.sql; it only fills an EMPTY database).
