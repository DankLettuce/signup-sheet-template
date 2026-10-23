// Class sign-up API (Cloudflare Pages Function + D1). Template: event details live in the
// `settings` table (seeded from site.config.json by scripts/configure.mjs), items in `items`.
// Open by design: anyone with the link (and the optional class code) can read and edit.
// Defences: optional class code (env CLASS_CODE), strict validation + length limits,
// prepared statements only, per-visitor rate limits (burst + 10-minute), soft delete +
// full history so any change can be undone.
import { visitorKey, hashVisitor, visitorSalt } from '../../lib/visitor.js';
import { buildIcs, parsePartyDate } from '../../lib/ics.js';
import { SETTINGS } from '../../lib/settings.js';
import { gateStatus, gateToken, passState, passCookie, clearPassCookie, codeMatches, SECRET_HELP } from '../../lib/gate.js';
import { orgStatus, isOrgRoute, passwordMatches, orgToken, orgState, orgCookie, clearOrgCookie, ORG_HELP } from '../../lib/organizer.js';

const LIMITS = { name: 60, note: 200, itemName: 60, setting: 60, countMax: 99, maxItems: 40, maxEntriesPerItem: 60, batchRows: 15, batchOthers: 8 };
const UNLOCK_TRIES = 10; // wrong + right class-code tries (and bad pass cookies) per visitor per 10 minutes
const ORG_TRIES = 10;    // organizer password tries (and bad organizer cookies) per visitor per 10 minutes, a separate count
const REMOVED_LIMIT = 500;
const STATE_TTL_MS = 3000; // short per-isolate cache for GET /api/state

const SEC_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
};

const json = (data, status = 200, extra = {}) => {
  const h = new Headers(SEC_HEADERS);
  for (const [k, v] of Object.entries(extra)) for (const x of [].concat(v)) h.append(k, x); // Set-Cookie may be a list
  return new Response(JSON.stringify(data), { status, headers: h });
};
class HttpError extends Error { constructor(s, m, h) { super(m); this.status = s; this.headers = h || {}; } }

// Strip control chars (keep normal spaces), collapse whitespace, trim.
function cleanText(v, max, field, { multiline = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text`);
  let s = v.normalize('NFC').replace(multiline ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, ' ');
  s = multiline ? s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : s.replace(/\s+/g, ' ').trim();
  if ([...s].length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`);
  return s;
}
const toInt = v => typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
function cleanCount(v) {
  const n = toInt(v);
  // At least 1: an item with 0 spots could never be signed up for (to drop an item, remove it instead).
  if (!Number.isInteger(n) || n < 1 || n > LIMITS.countMax) throw new HttpError(400, `How many needed must be a whole number from 1 to ${LIMITS.countMax}`);
  return n;
}
// Every sign-up shows a name on the list, so the name is required the same way on sign-up and on edit.
function cleanName(v) {
  const name = cleanText(v, LIMITS.name, 'Name');
  if (!name) throw new HttpError(400, 'Please type your name.');
  return name;
}
// Round 3: one sign-up = one person. 'qty' from clients is ignored; new rows store 1.
// (The entries.qty column is kept so the change is reversible; older rows keep their value, unused.)
const cleanQty = () => 1;
function cleanId(v) {
  if (!/^\d{1,9}$/.test(String(v))) throw new HttpError(400, 'Bad id');
  return Number(v);
}
// SQLite-style UTC timestamp with milliseconds; related rows share one exact value.
const nowTs = () => new Date().toISOString().replace('T', ' ').slice(0, 23); // ms precision

// Per visitor (hashed IPv4 address or IPv6 /64), two fixed windows:
//  - burst: RATE_BURST REQUESTS per RATE_BURST_SEC (a batch is one request, so 15 items at once is fine)
//  - 10-minute: RATE_LIMIT ROWS per RATE_WINDOW_SEC (a batch counts each sign-up; any other write counts 1)
// plus a cap of VISITOR_CAP live (non-removed) sign-ups per visitor; removing one frees a slot.
// A request that would go over a limit is refused whole and does not use up rows.
const rateCfg = env => {
  const t = Date.now() / 1000, winSec = Number(env.RATE_WINDOW_SEC || 600), bSec = Number(env.RATE_BURST_SEC || 10);
  return { t, winSec, bSec, lim: Number(env.RATE_LIMIT || 40), bLim: Number(env.RATE_BURST || 5), cap: Number(env.VISITOR_CAP || 25),
    win: Math.floor(t / winSec), bwin: Math.floor(t / bSec) };
};
const mins = s => Math.max(1, Math.ceil(s / 60));
const rowLimitError = (c, batch) => new HttpError(429, batch
  ? `That’s a lot of sign-ups from your connection in a few minutes. Please wait about ${mins((c.win + 1) * c.winSec - c.t)} min and try again. Nothing was saved.`
  : 'Too many changes from your connection. Please wait a few minutes and try again.',
  { 'Retry-After': String(Math.ceil((c.win + 1) * c.winSec - c.t)) });
const capError = (c, have, adding) => new HttpError(429, have >= c.cap
  ? `You already have ${have} sign-ups from this connection (the most is ${c.cap}). Remove one you don’t need under My sign-ups to add another. Nothing was saved.`
  : `That would be ${have + adding} sign-ups from this connection; the most is ${c.cap} (you have ${have}). Pick fewer items or remove some under My sign-ups. Nothing was saved.`);
// live sign-ups this visitor created (history 'create' rows whose entry is not removed)
const MINE_LIVE = `SELECT COUNT(*) AS n FROM history h JOIN entries e ON e.id = CAST(h.row_id AS INTEGER)
  WHERE h.who = ?1 AND h.tbl = 'entries' AND h.action = 'create' AND e.deleted_at IS NULL`;
async function rateLimit(env, who, rows = 1) {
  const c = rateCfg(env);
  const b = await env.DB.prepare('INSERT INTO rate(who, win, n) VALUES (?1, ?2, 1) ON CONFLICT(who, win) DO UPDATE SET n = n + 1 RETURNING n').bind('b:' + who, c.bwin).first();
  if (Math.random() < 0.05) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM rate WHERE who NOT LIKE 'b:%' AND win < ?1").bind(c.win - 1),
      env.DB.prepare("DELETE FROM rate WHERE who LIKE 'b:%' AND win < ?1").bind(c.bwin - 1),
    ]);
  }
  if (b.n > c.bLim) {
    const wait = Math.max(1, Math.ceil((c.bwin + 1) * c.bSec - c.t));
    throw new HttpError(429, 'Saving a little too fast. Please wait a few seconds and try again.', { 'Retry-After': String(wait) });
  }
  if (!rows) return c; // batch: rows are counted inside its own transaction (batchSignup)
  // only counts if it fits (RETURNING gives no row when the WHERE refuses the update)
  const a = await env.DB.prepare('INSERT INTO rate(who, win, n) VALUES (?1, ?2, ?3) ON CONFLICT(who, win) DO UPDATE SET n = n + ?3 WHERE n + ?3 <= ?4 RETURNING n')
    .bind(who, c.win, rows, c.lim).first();
  if (!a || a.n > c.lim) throw rowLimitError(c, false);
  return c;
}

const logStmt = (env, who, action, tbl, rowId, before, after, req = null) => env.DB.prepare(
  'INSERT INTO history(who, action, tbl, row_id, before_json, after_json, req) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
).bind(who, action, tbl, String(rowId), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, req);

let memo = null; // { at, data } per isolate
async function getState(env) {
  const [settings, items, entries, removed, removedItems] = await env.DB.batch([
    env.DB.prepare('SELECT key, value FROM settings'),
    env.DB.prepare('SELECT id, name, needed, sort, is_custom FROM items WHERE deleted_at IS NULL ORDER BY sort, id'),
    env.DB.prepare('SELECT e.id, e.item_id, e.name, e.note FROM entries e JOIN items i ON i.id = e.item_id WHERE e.deleted_at IS NULL AND i.deleted_at IS NULL ORDER BY e.id'),
    env.DB.prepare(`SELECT e.id, e.name, e.note, e.deleted_at, i.name AS item_name FROM entries e JOIN items i ON i.id = e.item_id
                    WHERE e.deleted_at IS NOT NULL AND i.deleted_at IS NULL ORDER BY e.deleted_at DESC, e.id DESC LIMIT ${REMOVED_LIMIT}`),
    env.DB.prepare(`SELECT i.id, i.name, i.needed, i.deleted_at,
                      (SELECT COUNT(*) FROM entries e WHERE e.item_id = i.id AND e.deleted_at = i.deleted_at) AS entry_count
                    FROM items i WHERE i.deleted_at IS NOT NULL ORDER BY i.deleted_at DESC, i.id DESC LIMIT ${REMOVED_LIMIT}`),
  ]);
  const s = Object.fromEntries(settings.results.map(r => [r.key, r.value]));
  const set = Object.fromEntries(Object.entries(SETTINGS).map(([k, d]) => [k, s[k] ?? d.def]));
  const byItem = new Map(items.results.map(i => [i.id, { ...i, is_custom: !!i.is_custom, entries: [] }]));
  for (const e of entries.results) byItem.get(e.item_id)?.entries.push({ id: e.id, name: e.name, note: e.note });
  const data = {
    settings: { ...set, party_date: set.party_date || 'TBD', party_time: set.party_time || 'TBD' },
    items: [...byItem.values()], removed: removed.results, removed_items: removedItems.results, limits: LIMITS,
    calendar: !!parsePartyDate(set.party_date), // the page offers 'Add to calendar' only when the date can be read
    code: gateStatus(env) === 'on', // true when a class code protects this page (the page shows "Class code on" to organizers)
  };
  memo = { at: Date.now(), data };
  return data;
}

async function readBody(request, max = 4096) {
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'JSON required');
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > max) throw new HttpError(413, 'Too large');
  const text = await request.text();
  if (text.length > max) throw new HttpError(413, 'Too large');
  try { const b = JSON.parse(text || '{}'); if (b && typeof b === 'object' && !Array.isArray(b)) return b; } catch (_) {}
  throw new HttpError(400, 'Bad JSON');
}

// History rows for many entries in ONE statement (Free plan allows 50 D1 queries per request).
const ENTRY_JSON = d => `json_object('id', id, 'item_id', item_id, 'name', name, 'note', note, 'qty', qty, 'created_at', created_at, 'updated_at', updated_at, 'deleted_at', ${d})`;
const logEntriesStmt = (env, who, action, itemId, matchDeleted, newDeleted) => env.DB.prepare(
  `INSERT INTO history(who, action, tbl, row_id, before_json, after_json)
   SELECT ?1, ?2, 'entries', CAST(id AS TEXT), ${ENTRY_JSON('deleted_at')}, ${ENTRY_JSON('?5')}
   FROM entries WHERE item_id = ?3 AND deleted_at IS ?4`
).bind(who, action, itemId, matchDeleted, newDeleted);

const row = (env, sql, id) => env.DB.prepare(sql).bind(id).first();
const ITEM_JSON = `json_object('id', id, 'name', name, 'needed', needed, 'sort', sort, 'is_custom', is_custom, 'created_at', created_at, 'updated_at', updated_at, 'deleted_at', deleted_at)`;
// Sign-ups created by an already-applied request id (so a retried batch still tells the phone its entry ids).
const createdFor = async (env, req) => (await env.DB.prepare(
  "SELECT CAST(row_id AS INTEGER) AS id, json_extract(after_json, '$.item_id') AS item_id FROM history WHERE req = ?1 AND tbl = 'entries' AND action = 'create' ORDER BY id"
).bind(req).all()).results;

// POST /api/batch: one name, many sign-ups, up to 3 brand-new Other items, ALL OR NOTHING.
// Validation errors come back per row (nothing written). Writes are inserts only (no
// read-modify-write of shared rows), run as ONE D1 batch = one transaction, so two parents
// submitting at once both land. Every new row gets a history row tagged with the request id.
async function batchSignup(env, request, body, who, req) {
  const rows = body.rows ?? [], others = body.others ?? [];
  if (!Array.isArray(rows) || !Array.isArray(others)) throw new HttpError(400, 'rows and others must be lists');
  const name = cleanName(body.name);
  if (!rows.length && !others.length) throw new HttpError(400, 'Pick at least one item');
  if (rows.length + others.length > LIMITS.batchRows) throw new HttpError(400, `At most ${LIMITS.batchRows} items in one go`);
  if (others.length > LIMITS.batchOthers) throw new HttpError(400, `That’s more than ${LIMITS.batchOthers} new items. ${LIMITS.batchOthers} is the max for one sign-up. Nothing was saved.`);

  const c = rateCfg(env), k = rows.length + others.length;
  const [live, counts, used, mineLive] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, needed FROM items WHERE deleted_at IS NULL'),
    env.DB.prepare('SELECT item_id, COUNT(*) AS n FROM entries WHERE deleted_at IS NULL GROUP BY item_id'),
    env.DB.prepare('SELECT n FROM rate WHERE who = ?1 AND win = ?2').bind(who, c.win),
    env.DB.prepare(MINE_LIVE).bind(who),
  ]);
  // limits first: the whole batch is refused, nothing saved, no rows used up
  const have = mineLive.results[0].n;
  if (have + k > c.cap) throw capError(c, have, k);
  if ((used.results[0]?.n || 0) + k > c.lim) throw rowLimitError(c, true);
  const liveIds = new Set(live.results.map(i => i.id));
  const byName = new Map(live.results.map(i => [i.name.toLowerCase(), i.id]));
  const cnt = new Map(counts.results.map(c => [c.item_id, c.n]));
  const errs = [], R = [], O = [], seen = new Set(), newNames = new Set();
  const check = (kind, index, fn) => { try { fn(); } catch (e) { if (e instanceof HttpError) errs.push({ kind, index, error: e.message, ...(e.covered ? { covered: e.covered } : {}) }); else throw e; } };
  const batchNote = cleanText(body.note, LIMITS.note, 'Note', { multiline: true }); // 'Anything to add?' -> stored on each entry
  const neededOf = new Map(live.results.map(i => [i.id, i.needed]));
  const skipPre = env.TEST_HOOKS === '1' && request.headers.get('X-Test-Skip-Precheck') === '1';
  const addTo = (itemId, r) => {
    if (seen.has(itemId)) throw new HttpError(400, 'This item is listed twice');
    // (test hook X-Test-Skip-Precheck, local dev only: skip this pre-check to prove the in-transaction guard)
    if (!skipPre && (cnt.get(itemId) || 0) >= Math.min(neededOf.get(itemId), LIMITS.maxEntriesPerItem)) throw Object.assign(new HttpError(409, 'Just got covered by someone else'), { covered: itemId });
    seen.add(itemId); R.push({ ...r, itemId });
  };
  rows.forEach((r, i) => check('row', i, () => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new HttpError(400, 'Bad row');
    const itemId = cleanId(r.item_id);
    const qty = cleanQty(r.qty), note = r.note === undefined ? batchNote : cleanText(r.note, LIMITS.note, 'Note', { multiline: true });
    if (!liveIds.has(itemId)) throw new HttpError(404, 'That item no longer exists');
    addTo(itemId, { kind: 'row', index: i, qty, note });
  }));
  others.forEach((o, i) => check('other', i, () => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new HttpError(400, 'Bad row');
    const iname = cleanText(o.name, LIMITS.itemName, 'Item name');
    if (!iname) throw new HttpError(400, 'Please type an item name');
    const qty = cleanQty(o.qty), note = o.note === undefined ? batchNote : cleanText(o.note, LIMITS.note, 'Note', { multiline: true });
    const key = iname.toLowerCase(), existing = byName.get(key);
    if (existing) return addTo(existing, { kind: 'other', index: i, qty, note }); // same name already on the list: join it
    if (newNames.has(key)) throw new HttpError(400, 'This item is listed twice');
    newNames.add(key); O.push({ index: i, name: iname, qty, note });
  }));
  if (O.length && live.results.length + O.length > LIMITS.maxItems) errs.push({ kind: 'other', index: O[0].index, error: 'The list is full' });
  if (errs.length) {
    const cov = errs.filter(e => e.covered);
    if (cov.length === errs.length) { // only "covered" problems: one friendly message
      const names = [...new Set(cov.map(e => live.results.find(i => i.id === e.covered).name))];
      throw Object.assign(coveredError(names), { rows: errs });
    }
    const what = e => e.kind === 'other' ? `New item ${e.index + 1}` : `Row ${e.index + 1}`;
    throw Object.assign(new HttpError(400, errs.length === 1 ? `${what(errs[0])}: ${errs[0].error}. Nothing was saved.` : `${errs.length} rows need fixing. Nothing was saved.`), { rows: errs });
  }

  const ts = nowTs(), DB = env.DB, st = [];
  // Row budget, inside the same transaction so parallel batches can't all slip under it:
  // add the rows, then a guard insert that fails (NOT NULL on rate.n) if the total is over -> whole batch rolls back.
  st.push(DB.prepare('INSERT INTO rate(who, win, n) VALUES (?1, ?2, ?3) ON CONFLICT(who, win) DO UPDATE SET n = n + ?3').bind(who, c.win, k));
  st.push(DB.prepare('INSERT INTO rate(who, win, n) SELECT ?1, -1, NULL WHERE (SELECT n FROM rate WHERE who = ?1 AND win = ?2) > ?3').bind(who, c.win, c.lim));
  for (const o of O) st.push(DB.prepare(`INSERT INTO items(name, needed, sort, is_custom, created_at, updated_at) VALUES (?1, 1, ${NEXT_SORT}, 1, ?2, ?2)`).bind(o.name, ts));
  if (O.length) st.push(DB.prepare(`INSERT INTO history(who, action, tbl, row_id, before_json, after_json, req)
    SELECT ?1, 'create', 'items', CAST(id AS TEXT), NULL, ${ITEM_JSON}, ?2 FROM (SELECT * FROM items ORDER BY id DESC LIMIT ?3)`).bind(who, req, O.length));
  // item_id resolves to NULL if the item was removed meanwhile -> NOT NULL fails -> whole batch rolls back
  for (const r of R) st.push(DB.prepare('INSERT INTO entries(item_id, name, note, qty, created_at, updated_at) VALUES ((SELECT id FROM items WHERE id = ?1 AND deleted_at IS NULL), ?2, ?3, ?4, ?5, ?5)').bind(r.itemId, name, r.note, r.qty, ts));
  for (const o of O) st.push(DB.prepare(`INSERT INTO entries(item_id, name, note, qty, created_at, updated_at) VALUES (
    (SELECT id FROM items WHERE name = ?1 AND created_at = ?5 AND is_custom = 1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1), ?2, ?3, ?4, ?5, ?5)`).bind(o.name, name, o.note, o.qty, ts));
  const n = R.length + O.length;
  // Slots, inside the transaction: if any item in this batch now has more people than spots
  // (someone took the last spot a moment ago), a guard insert fails (NOT NULL on items.name) -> whole batch rolls back.
  const batchItemIds = [...seen];
  if (batchItemIds.length) st.push(DB.prepare(`INSERT INTO items(name) SELECT NULL WHERE EXISTS (SELECT 1 FROM items i WHERE i.id IN (SELECT value FROM json_each(?1))
    AND (SELECT COUNT(*) FROM entries e WHERE e.item_id = i.id AND e.deleted_at IS NULL) > i.needed)`).bind(JSON.stringify(batchItemIds)));
  // Test hook (local dev only, env TEST_HOOKS=1): fail after k statements to prove the rollback.
  const failAt = env.TEST_HOOKS === '1' && Number(request.headers.get('X-Test-Fail-After'));
  if (failAt) st.splice(Math.min(failAt, st.length), 0, DB.prepare('INSERT INTO entries(item_id, name) VALUES (NULL, ?1)').bind('test-hook'));
  st.push(DB.prepare(`INSERT INTO history(who, action, tbl, row_id, before_json, after_json, req)
    SELECT ?1, 'create', 'entries', CAST(id AS TEXT), NULL, ${ENTRY_JSON('deleted_at')}, ?2 FROM (SELECT * FROM entries ORDER BY id DESC LIMIT ?3)`).bind(who, req, n));
  // live sign-up cap, same idea (guard fails on settings.value NOT NULL), counted after this batch's history rows
  st.push(DB.prepare(`INSERT INTO settings(key, value) SELECT 'visitor-cap-guard', NULL WHERE (${MINE_LIVE}) > ?2`).bind(who, c.cap));
  st.push(DB.prepare('SELECT id, item_id FROM entries ORDER BY id DESC LIMIT ?1').bind(n));
  let res;
  try { res = await DB.batch(st); } catch (e) {
    const msg = String(e && (e.message || e)) + String(e && e.cause);
    if (/NOT NULL constraint failed: rate\.n/i.test(msg)) throw rowLimitError(rateCfg(env), true);
    if (/NOT NULL constraint failed: items\.name/i.test(msg)) {
      const now = (await DB.prepare(`SELECT i.name FROM items i WHERE i.id IN (SELECT value FROM json_each(?1))
        AND (SELECT COUNT(*) FROM entries e WHERE e.item_id = i.id AND e.deleted_at IS NULL) >= i.needed`).bind(JSON.stringify(batchItemIds)).all()).results.map(r => r.name);
      throw coveredError(now);
    }
    if (/NOT NULL constraint failed: settings\.value/i.test(msg)) throw capError(c, (await env.DB.prepare(MINE_LIVE).bind(who).first()).n, k);
    if (/NOT NULL constraint failed: entries\.item_id/i.test(String(e && (e.message || e)) + String(e && e.cause))) {
      throw new HttpError(409, 'One of these items was just removed by someone else. Nothing was saved. Please check the list and try again.');
    }
    throw e;
  }
  return res.at(-1).results.reverse(); // in submit order: rows first, then new items
}
const NEXT_SORT = '(SELECT COALESCE(MAX(sort), 0) + 10 FROM items)';
const coveredError = names => new HttpError(409, `Sorry, ${names.length ? names.join(' & ') : 'one of these'} just got covered by someone else. Nothing was saved. Please pick again.`);

// ---------- GET /api/calendar.ics?name=…&item=…&item=… : 'Add to calendar' (no DB write; builder in lib/ics.js) ----------
async function calendar(env, url) {
  const q = url.searchParams;
  const name = cleanText(q.get('name') ?? '', LIMITS.name, 'Name');
  const items = q.getAll('item').slice(0, LIMITS.batchRows + LIMITS.batchOthers).map(v => cleanText(v, LIMITS.itemName, 'Item name')).filter(Boolean);
  const set = await readSettings(env);
  const body = buildIcs({ name, items, date: set.party_date, time: set.party_time, uid: crypto.randomUUID(), host: url.host, origin: url.origin,
    title: eventTitle(set), location: set.school, tz: env.TIMEZONE || 'America/New_York' });
  if (!body) throw new HttpError(422, 'The event date isn’t a calendar date yet, so there is no calendar file.');
  return new Response(body, { headers: { ...SEC_HEADERS, 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="${fileSlug(set.event_name)}.ics"` } });
}
async function readSettings(env) {
  const s = Object.fromEntries((await env.DB.prepare('SELECT key, value FROM settings').all()).results.map(r => [r.key, r.value]));
  return Object.fromEntries(Object.entries(SETTINGS).map(([k, d]) => [k, s[k] ?? d.def]));
}
// "Ms. Rivera's 2nd Grade Fall Party" style title, from whatever details are filled in.
export function eventTitle(s) {
  const who = s.teacher && s.class_name ? `${s.teacher}'s ${s.class_name}` : (s.teacher || s.class_name || '');
  return [who, s.event_name].filter(Boolean).join(' ');
}
const fileSlug = s => (String(s || 'event').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'event').slice(0, 40);

// ---------- Organizer: one-tap backup (CSV for a spreadsheet, JSON = everything incl. removed rows) ----------
// No visitor hashes, rate rows or history are exported. Gated by the class code like everything else.
const csvCell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const etStamp = (utc, tz) => { if (!utc) return ''; const d = new Date(String(utc).replace(' ', 'T') + 'Z'); return isNaN(d) ? '' : d.toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }); };
async function exportBackup(env, format) {
  const [settings, items, entries] = await env.DB.batch([
    env.DB.prepare('SELECT key, value, updated_at FROM settings ORDER BY key'),
    env.DB.prepare('SELECT id, name, needed, sort, is_custom, created_at, updated_at, deleted_at FROM items ORDER BY sort, id'),
    env.DB.prepare('SELECT id, item_id, name, note, created_at, updated_at, deleted_at FROM entries ORDER BY id'),
  ]);
  const set = Object.fromEntries(settings.results.filter(r => r.key in SETTINGS).map(r => [r.key, r.value]));
  const day = new Date().toISOString().slice(0, 10), base = `${fileSlug(set.event_name)}-backup-${day}`;
  if (format === 'json') {
    const body = JSON.stringify({ format: 'signup-backup', version: 1, exported_at: new Date().toISOString(),
      settings: settings.results.filter(r => r.key in SETTINGS), items: items.results, entries: entries.results }, null, 2);
    return new Response(body, { headers: { ...SEC_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${base}.json"` } });
  }
  const tz = env.TIMEZONE || 'America/New_York';
  const rows = [['Item', 'Spots', 'Person', 'Note', 'Signed up']];
  const live = items.results.filter(i => !i.deleted_at);
  for (const it of live) {
    const es = entries.results.filter(e => e.item_id === it.id && !e.deleted_at);
    if (!es.length) rows.push([it.name, it.needed, '', '', '']);
    for (const e of es) rows.push([it.name, it.needed, e.name || 'Someone', e.note, etStamp(e.created_at, tz)]);
    for (let k = es.length; k < it.needed; k++) if (es.length) rows.push([it.name, it.needed, '(open spot)', '', '']);
  }
  const body = '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  return new Response(body, { headers: { ...SEC_HEADERS, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${base}.csv"` } });
}
// Slot check for Undo / Put back, run INSIDE the restore batch: if the item now has more live sign-ups than spots,
// the guard insert fails (NOT NULL on items.name) and the whole restore rolls back -> 409 'just got covered'.
const slotGuard = (env, itemId) => env.DB.prepare(`INSERT INTO items(name) SELECT NULL WHERE
  (SELECT COUNT(*) FROM entries WHERE item_id = ?1 AND deleted_at IS NULL) > (SELECT needed FROM items WHERE id = ?1)`).bind(itemId);
async function guardedRestore(env, request, item, stmts, adding) {
  const skipPre = env.TEST_HOOKS === '1' && request.headers.get('X-Test-Skip-Precheck') === '1';
  if (!skipPre) {
    const c = await row(env, 'SELECT COUNT(*) AS n FROM entries WHERE item_id = ?1 AND deleted_at IS NULL', item.id);
    if (c.n + adding > item.needed) throw coveredError([item.name]);
  }
  try { await env.DB.batch([...stmts, slotGuard(env, item.id)]); }
  catch (e) {
    if (/NOT NULL constraint failed: items\.name/i.test(String(e && (e.message || e)) + String(e && e.cause))) throw coveredError([item.name]);
    throw e;
  }
}
const liveItem = (env, id) => row(env, 'SELECT * FROM items WHERE id = ?1 AND deleted_at IS NULL', id);

function cleanSetting(key, v) {
  const d = Object.prototype.hasOwnProperty.call(SETTINGS, key) ? SETTINGS[key] : null;
  if (!d) throw new HttpError(400, 'Unknown setting');
  if (d.one_of) { if (!d.one_of.includes(v)) throw new HttpError(400, `${key} must be one of: ${d.one_of.join(', ')}`); return v; }
  const label = key === 'party_date' || key === 'party_time' ? 'Date/time' : key.replace(/_/g, ' ');
  const s = cleanText(v, d.max, label, { multiline: !!d.multiline });
  return s || (d.def === 'TBD' ? 'TBD' : s);
}

// POST /api/unlock { code }: right code -> a pass cookie (HttpOnly, this site only); wrong code -> 403.
// Tries are limited per visitor (UNLOCK_TRIES per 10 minutes, shared with bad pass cookies, see gateCheck) so
// neither the code nor the pass can be guessed by brute force.
async function unlockTry(env, request, kind = 'u', max = UNLOCK_TRIES) { // one try on a visitor lockout counter ('u' class code, 'o' organizer); 429 when over
  const who = await hashVisitor(visitorKey(request.headers.get('CF-Connecting-IP')), visitorSalt(env));
  const c = rateCfg(env);
  const n = (await env.DB.prepare('INSERT INTO rate(who, win, n) VALUES (?1, ?2, 1) ON CONFLICT(who, win) DO UPDATE SET n = n + 1 RETURNING n').bind(kind + ':' + who, c.win).first()).n;
  if (n > max) throw new HttpError(429, 'Too many tries. Please wait about 10 minutes and try again.', { 'Retry-After': String(Math.ceil((c.win + 1) * c.winSec - c.t)) });
}
async function unlock(env, request, url) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ error: 'Forbidden' }, 403);
  if (gateStatus(env) === 'off') return json({ ok: true, gate: false });
  const body = await readBody(request, 1024);
  await unlockTry(env, request);
  if (typeof body.code !== 'string' || body.code.length > 64 || !(await codeMatches(env, body.code)))
    return json({ error: 'That code didn’t work. Check the email from the organizer and try again.' }, 403);
  return json({ ok: true }, 200, { 'Set-Cookie': passCookie(await gateToken(env), url.protocol === 'https:') });
}
// Fail closed: CLASS_CODE set but PASS_SECRET missing/too short -> every /api route answers 503 (no default secret).
function setupError() {
  console.error('Class code is on but PASS_SECRET is missing or too short. ' + SECRET_HELP);
  return json({ error: 'This sign-up page isn’t finished being set up yet. Please tell the organizer.', setup: true }, 503);
}

function orgSetupError() {
  console.error('Organizer routes are off: ' + ORG_HELP);
  return json({ error: 'The organizer password isn’t set up yet (see the README, step 6).', setup: true, organizer: true }, 503);
}
// POST /api/organizer/login { password } -> organizer cookie (12 h); POST /api/organizer/logout clears it.
async function orgLogin(env, request, url, body) {
  if (orgStatus(env) !== 'on') return orgSetupError();
  await unlockTry(env, request, 'o', ORG_TRIES);
  if (!(await passwordMatches(env, body.password)))
    return json({ error: 'That password didn’t work.', organizer: true }, 403);
  return json({ ok: true, organizer: true }, 200, { 'Set-Cookie': orgCookie(await orgToken(env), url.protocol === 'https:') });
}

export async function onRequest({ request, env, params }) {
  try {
    const path = (params.path || []).join('/');
    const method = request.method;
    const url = new URL(request.url);
    // ---- class code (optional; on when the CLASS_CODE secret is set) ----
    const gate = gateStatus(env);
    if (gate === 'setup') return setupError();
    if (method === 'POST' && path === 'unlock') return await unlock(env, request, url);
    if (gate === 'on') {
      const pass = await passState(env, request);
      if (pass !== 'ok') {
        const hdr = {};
        if (pass === 'bad') { // forged/old cookie: costs one try on the same lockout as a wrong code, then is cleared
          await unlockTry(env, request);
          hdr['Set-Cookie'] = clearPassCookie(url.protocol === 'https:');
        }
        const msg = { error: 'Please enter the class code from the email.', gate: true };
        if (method === 'GET' && path === 'state') msg.event_name = (await readSettings(env)).event_name; // only the event name before the code
        return json(msg, 401, hdr);
      }
    }
    // ---- organizer password (organizer-only routes; see lib/organizer.js) ----
    const secure = url.protocol === 'https:';
    const org = await orgState(env, request), orgHdr = {};
    if (org === 'bad') { // forged / expired / old organizer cookie: one try on the organizer lockout, then cleared
      orgHdr['Set-Cookie'] = clearOrgCookie(secure);
      try { await unlockTry(env, request, 'o', ORG_TRIES); } catch (e) { if (e instanceof HttpError) e.headers = { ...e.headers, ...orgHdr }; throw e; }
    }
    const isOrg = org === 'ok';
    if (isOrgRoute(method, path) && !isOrg) {
      if (orgStatus(env) !== 'on') return orgSetupError();
      return json({ error: 'Only the organizer can do that. Please enter the organizer password.', organizer: true }, 401, orgHdr);
    }
    const withOrg = d => ({ ...d, organizer: isOrg });
    if (method === 'GET' && path === 'state') {
      if (memo && Date.now() - memo.at < STATE_TTL_MS) return json(withOrg(memo.data), 200, orgHdr);
      return json(withOrg(await getState(env)), 200, orgHdr);
    }
    if (method === 'GET' && path === 'calendar.ics') return await calendar(env, url);
    if (method === 'GET' && path === 'export.csv') return await exportBackup(env, 'csv');
    if (method === 'GET' && path === 'export.json') return await exportBackup(env, 'json');
    if (method === 'GET' || method === 'HEAD') return json({ error: 'Not found' }, 404);

    // Same-origin only for writes (blocks cross-site form/fetch abuse).
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin) return json({ error: 'Forbidden' }, 403);

    const body = await readBody(request, method === 'POST' && path === 'batch' ? 16384 : 4096);
    if (method === 'POST' && path === 'organizer/login') return await orgLogin(env, request, url, body);
    if (method === 'POST' && path === 'organizer/logout') return json({ ok: true, organizer: false }, 200, { 'Set-Cookie': clearOrgCookie(secure) });
    const who = await hashVisitor(visitorKey(request.headers.get('CF-Connecting-IP')), visitorSalt(env));

    // Idempotent retries: a write with a request id we've already applied is not applied again.
    let req = request.headers.get('X-Req-Id');
    if (req !== null && !/^[A-Za-z0-9-]{8,64}$/.test(req)) req = null;
    if (req && await row(env, 'SELECT 1 AS x FROM history WHERE req = ?1', req)) return json(withOrg({ ...(await getState(env)), created: await createdFor(env, req), replayed: true }), 200, orgHdr);

    const isBatch = method === 'POST' && path === 'batch';
    const rc = await rateLimit(env, who, isBatch ? 0 : 1);
    const log = (action, tbl, id, before, after) => logStmt(env, who, action, tbl, id, before, after, req);

    let m, created;
    if (method === 'POST' && path === 'batch') created = await batchSignup(env, request, body, who, req);
    // --- settings ---
    else if (method === 'PUT' && path === 'settings') {
      // one { key, value } or several at once: { values: { event_name: '…', party_date: '…' } } (all or nothing)
      const pairs = body.values && typeof body.values === 'object' && !Array.isArray(body.values) ? Object.entries(body.values) : [[body.key, body.value]];
      if (!pairs.length || pairs.length > Object.keys(SETTINGS).length) throw new HttpError(400, 'Nothing to save');
      const clean = pairs.map(([key, v]) => [key, cleanSetting(key, v)]);
      const keys = clean.map(([k]) => k);
      const before = new Map((await env.DB.prepare('SELECT key, value FROM settings WHERE key IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(keys)).all()).results.map(r => [r.key, r]));
      const st = [];
      for (const [key, value] of clean) {
        if (before.get(key)?.value === value) continue; // unchanged: no write, no history row
        st.push(env.DB.prepare("INSERT INTO settings(key, value, updated_at) VALUES (?1, ?2, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = datetime('now')").bind(key, value),
          log('update', 'settings', key, before.get(key) || null, { key, value }));
      }
      if (st.length) await env.DB.batch(st);
    }
    // --- entries ---
    else if (method === 'POST' && path === 'entries') {
      const itemId = cleanId(body.item_id);
      const name = cleanName(body.name);
      const note = cleanText(body.note, LIMITS.note, 'Note', { multiline: true });
      const qty = cleanQty(body.qty);
      if (!(await liveItem(env, itemId))) throw new HttpError(404, 'That item no longer exists');
      const c = await row(env, 'SELECT COUNT(*) AS n FROM entries WHERE item_id = ?1 AND deleted_at IS NULL', itemId);
      if (c.n >= Math.min(LIMITS.maxEntriesPerItem, (await liveItem(env, itemId)).needed)) throw coveredError([(await liveItem(env, itemId)).name]);
      const mineN = (await env.DB.prepare(MINE_LIVE).bind(who).first()).n;
      if (mineN + 1 > rc.cap) throw capError(rc, mineN, 1);
      const r = await env.DB.prepare('INSERT INTO entries(item_id, name, note, qty) VALUES (?1, ?2, ?3, ?4) RETURNING *').bind(itemId, name, note, qty).first();
      await log('create', 'entries', r.id, null, r).run();
      created = [{ id: r.id, item_id: r.item_id }];
    }
    else if ((m = path.match(/^entries\/(\d+)$/)) && method === 'PUT') {
      const id = cleanId(m[1]);
      const name = cleanName(body.name);
      const note = cleanText(body.note, LIMITS.note, 'Note', { multiline: true });
      const before = await row(env, 'SELECT * FROM entries WHERE id = ?1 AND deleted_at IS NULL', id);
      if (!before) throw new HttpError(404, 'That sign-up no longer exists');
      await env.DB.batch([ // qty is no longer edited (one sign-up = one person)
        env.DB.prepare("UPDATE entries SET name = ?2, note = ?3, updated_at = datetime('now') WHERE id = ?1").bind(id, name, note),
        log('update', 'entries', id, before, { ...before, name, note }),
      ]);
    }
    else if ((m = path.match(/^entries\/(\d+)$/)) && method === 'DELETE') {
      const id = cleanId(m[1]);
      const before = await row(env, 'SELECT * FROM entries WHERE id = ?1 AND deleted_at IS NULL', id);
      if (!before) throw new HttpError(404, 'That sign-up no longer exists');
      const ts = nowTs();
      await env.DB.batch([
        env.DB.prepare('UPDATE entries SET deleted_at = ?2 WHERE id = ?1').bind(id, ts),
        log('delete', 'entries', id, before, { ...before, deleted_at: ts }),
      ]);
    }
    else if ((m = path.match(/^entries\/(\d+)\/restore$/)) && method === 'POST') {
      const id = cleanId(m[1]);
      const before = await row(env, 'SELECT * FROM entries WHERE id = ?1 AND deleted_at IS NOT NULL', id);
      if (!before) throw new HttpError(404, 'Nothing to restore');
      const item = await liveItem(env, before.item_id);
      if (!item) throw new HttpError(400, 'Put the item back first');
      await guardedRestore(env, request, item, [
        env.DB.prepare('UPDATE entries SET deleted_at = NULL WHERE id = ?1').bind(id),
        log('restore', 'entries', id, before, { ...before, deleted_at: null }),
      ], 1);
    }
    // --- items ---
    else if (method === 'POST' && path === 'items') {
      const name = cleanText(body.name, LIMITS.itemName, 'Item name');
      if (!name) throw new HttpError(400, 'Please type an item name');
      const needed = cleanCount(body.needed ?? 1);
      const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL').first();
      if (c.n >= LIMITS.maxItems) throw new HttpError(400, 'The list is full');
      const r = await env.DB.prepare(`INSERT INTO items(name, needed, sort, is_custom) VALUES (?1, ?2, ${NEXT_SORT}, 1) RETURNING *`).bind(name, needed).first();
      await log('create', 'items', r.id, null, r).run();
    }
    else if ((m = path.match(/^items\/(\d+)$/)) && method === 'PUT') {
      const id = cleanId(m[1]);
      const before = await liveItem(env, id);
      if (!before) throw new HttpError(404, 'That item no longer exists');
      if (body.move !== undefined) { // Organizer: move one place up (-1) or down (+1) in the list order
        if (body.move !== -1 && body.move !== 1) throw new HttpError(400, 'move must be -1 or 1');
        const list = (await env.DB.prepare('SELECT id FROM items WHERE deleted_at IS NULL ORDER BY sort, id').all()).results.map(r => r.id);
        const i = list.indexOf(id), j = i + body.move;
        if (j < 0 || j >= list.length) throw new HttpError(400, body.move < 0 ? 'Already at the top' : 'Already at the bottom');
        [list[i], list[j]] = [list[j], list[i]];
        // one statement renumbers every live item (10, 20, 30…) in the new order
        await env.DB.batch([
          env.DB.prepare(`UPDATE items SET sort = (SELECT (CAST(j.key AS INTEGER) + 1) * 10 FROM json_each(?1) j WHERE j.value = items.id), updated_at = datetime('now')
            WHERE id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(list)),
          log('update', 'items', id, { id, sort: before.sort, order: list.slice().sort() }, { id, move: body.move, order: list }),
        ]);
        return json(withOrg(await getState(env)), 200, orgHdr);
      }
      const needed = body.needed === undefined ? before.needed : cleanCount(body.needed);
      let name = before.name;
      if (body.name !== undefined) { // Organizer: any item can be renamed (standard or added)
        name = cleanText(body.name, LIMITS.itemName, 'Item name');
        if (!name) throw new HttpError(400, 'Please type an item name');
        const dup = await env.DB.prepare('SELECT 1 AS x FROM items WHERE deleted_at IS NULL AND id != ?1 AND lower(name) = lower(?2)').bind(id, name).first();
        if (dup) throw new HttpError(400, 'Another item already has that name');
      }
      await env.DB.batch([
        env.DB.prepare("UPDATE items SET name = ?2, needed = ?3, updated_at = datetime('now') WHERE id = ?1").bind(id, name, needed),
        log('update', 'items', id, before, { ...before, name, needed }),
      ]);
    }
    else if ((m = path.match(/^items\/(\d+)$/)) && method === 'DELETE') {
      // Removing an item (Organizer: any item) also removes its live sign-ups with the SAME timestamp,
      // so putting the item back brings exactly those sign-ups back.
      const id = cleanId(m[1]);
      const before = await liveItem(env, id);
      if (!before) throw new HttpError(404, 'That item no longer exists');
      const ts = nowTs();
      await env.DB.batch([
        env.DB.prepare('UPDATE items SET deleted_at = ?2 WHERE id = ?1').bind(id, ts),
        log('delete', 'items', id, before, { ...before, deleted_at: ts }),
        logEntriesStmt(env, who, 'delete', id, null, ts),
        env.DB.prepare('UPDATE entries SET deleted_at = ?2 WHERE item_id = ?1 AND deleted_at IS NULL').bind(id, ts),
      ]);
    }
    else if ((m = path.match(/^items\/(\d+)\/restore$/)) && method === 'POST') {
      const id = cleanId(m[1]);
      const before = await row(env, 'SELECT * FROM items WHERE id = ?1 AND deleted_at IS NOT NULL', id);
      if (!before) throw new HttpError(404, 'Nothing to restore');
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM entries WHERE item_id = ?1 AND deleted_at = ?2').bind(id, before.deleted_at).first();
      await guardedRestore(env, request, before, [
        env.DB.prepare('UPDATE items SET deleted_at = NULL WHERE id = ?1').bind(id),
        log('restore', 'items', id, before, { ...before, deleted_at: null }),
        logEntriesStmt(env, who, 'restore', id, before.deleted_at, null),
        env.DB.prepare('UPDATE entries SET deleted_at = NULL WHERE item_id = ?1 AND deleted_at = ?2').bind(id, before.deleted_at),
      ], n.n);
    }
    else return json({ error: 'Not found' }, 404);

    const data = withOrg(await getState(env));
    return json(created ? { ...data, created } : data, 200, orgHdr);
  } catch (e) {
    if (e instanceof HttpError) return json(e.rows ? { error: e.message, rows: e.rows } : { error: e.message }, e.status, e.headers);
    console.error('api error', e && e.stack || e);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
}
