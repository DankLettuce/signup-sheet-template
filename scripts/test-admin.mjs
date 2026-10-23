// Tests the recovery tools against the LOCAL dev server + local D1:
// revert-visitor.mjs, snapshot.mjs (take/restore/undo) and the worker-backup cron.
// Usage: ORGANIZER_PASSWORD=<same as the server> PASS_SECRET=<same> [CLASS_CODE=<same>] node scripts/test-admin.mjs [http://127.0.0.1:8788]
//   (run from the repo; dev server must be up). revert-visitor --ip hashes addresses with the site's salt (VISITOR_SALT,
//   else PASS_SECRET), so this needs the same PASS_SECRET (or VISITOR_SALT) as the server in the environment.
import { execFileSync, spawn } from 'node:child_process';
import { q, ROOT } from './_d1.mjs';
const BASE = process.argv.find(a => a.startsWith('http')) || 'http://127.0.0.1:8788';
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The local server drops keep-alive sockets that sat idle (e.g. while an admin script ran). A request that hits such a
// socket never reached the server, so GETs are simply retried once.
const fetch = async (url, o = {}) => {
  try { return await globalThis.fetch(url, o); }
  catch (e) { if ((o.method || 'GET') === 'GET' && e?.cause?.code === 'UND_ERR_SOCKET') return globalThis.fetch(url, o); throw e; }
};
let COOKIE = ''; // class code pass (only when the server has a code)
const rnd = () => `10.${Math.random() * 255 | 0}.${Math.random() * 255 | 0}.${Math.random() * 255 | 0}`;
async function call(ip, method, path, body) {
  for (;;) {
    const r = await fetch(BASE + '/api/' + path, { method, headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json', ...(COOKIE ? { Cookie: COOKIE } : {}) }, body: JSON.stringify(body || {}) });
    if (r.status === 429) { await sleep(Number(r.headers.get('retry-after') || 2) * 1000 + 200); continue; } // pace like the UI does
    return { status: r.status, data: await r.json() };
  }
}
const state = async () => (await fetch(BASE + '/api/state', { headers: COOKIE ? { Cookie: COOKIE } : {} })).json();
if ((await fetch(BASE + '/api/state')).status === 401) {
  const u = await fetch(BASE + '/api/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': rnd() }, body: JSON.stringify({ code: process.env.CLASS_CODE || '' }) });
  if (!u.ok) { console.log('The server has a class code: run with CLASS_CODE=<code>'); process.exit(1); }
  COOKIE = (u.headers.get('set-cookie') || '').split(';')[0];
  if (!process.env.PASS_SECRET && !process.env.VISITOR_SALT) { console.log('Run with the same PASS_SECRET (or VISITOR_SALT) as the server: revert-visitor --ip needs the salt.'); process.exit(1); }
}
// The vandal steps below change items and event details, which needs the organizer password (a leaked password is
// exactly what the recovery tools are for).
if (!process.env.ORGANIZER_PASSWORD) { console.log('Run with the same ORGANIZER_PASSWORD as the server.'); process.exit(1); }
{
  const o = await fetch(BASE + '/api/organizer/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': rnd(), ...(COOKIE ? { Cookie: COOKIE } : {}) }, body: JSON.stringify({ password: process.env.ORGANIZER_PASSWORD }) });
  if (!o.ok) { console.log('Organizer login failed (' + o.status + '): is ORGANIZER_PASSWORD the same as the server\'s?'); process.exit(1); }
  COOKIE = [COOKIE, (o.headers.get('set-cookie') || '').split(';')[0]].filter(Boolean).join('; ');
}
// Admin scripts write D1 directly; GET /api/state has a 3 s per-isolate cache, so wait it out.
const node = (...a) => { const o = execFileSync(process.execPath, a, { cwd: ROOT, encoding: 'utf8' }); execFileSync('sleep', ['3.2']); return o; };
const etNow = (offMs = 0) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(Date.now() + offMs)).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`; };
const fp = s => JSON.stringify({ settings: s.settings, items: s.items.map(i => [i.id, i.name, i.needed, i.entries.map(e => [e.id, e.name, e.note])]) });

// --- seed real sign-ups from different parents ---
// own roomy items (needed = people since round 3), so earlier test runs filling the standard items don't matter
const mk = async n => (await call(rnd(), 'POST', 'items', { name: `${n} ${Date.now()}`, needed: 10 })).data.items.at(-1);
const A = await mk('Adm A'), B = await mk('Adm B'), C = await mk('Adm C');
let s = await state();
const real = [];
for (const [it, name] of [[A, 'Admin Real 1'], [A, 'Admin Real 2'], [B, 'Admin Real 3'], [C, 'Admin Real 4']]) {
  const r = await call(rnd(), 'POST', 'entries', { item_id: it.id, name, note: 'real note' });
  real.push(r.data.items.find(i => i.id === it.id).entries.at(-1));
}
let ro = await call(rnd(), 'POST', 'items', { name: 'Real other ' + Date.now(), needed: 2 });
const roItem = ro.data.items.at(-1);
await call(rnd(), 'POST', 'entries', { item_id: roItem.id, name: 'On real other' });
await sleep(1100);
const since = etNow(-60_000); // a minute ago, Eastern
const before = fp(await state());

// --- a vandal on IPv6 rotates addresses inside one /64 ---
const P = `2001:db8:${(Math.random() * 65535 | 0).toString(16)}:77`;
const V = i => `${P}::${i}`;
await call(V(1), 'PUT', `entries/${real[0].id}`, { name: 'VANDAL', note: 'x' });
await call(V(2), 'PUT', `entries/${real[1].id}`, { name: 'VANDAL', note: 'x' });
await call(V(3), 'DELETE', `entries/${real[2].id}`);
await call(V(4), 'PUT', 'settings', { key: 'party_date', value: 'CANCELLED' });
await call(V(5), 'PUT', `items/${B.id}`, { needed: 1 }); // 0 is refused since QA round 1; 1 is the lowest a vandal can set
let r = await call(V(6), 'POST', 'items', { name: 'Vandal item', needed: 9 });
const vi = r.data.items.find(i => i.name === 'Vandal item');
await call(V(7), 'POST', 'entries', { item_id: vi.id, name: 'VANDAL entry' });
await call(V(8), 'PUT', `entries/${real[0].id}`, { name: 'VANDAL again', note: 'y' });
await call(V(9), 'DELETE', `items/${roItem.id}`); // takes its sign-up with it
await call(V(10), 'POST', 'batch', { name: 'VANDAL batch', rows: [{ item_id: A.id }], others: [{ name: 'Vandal batch thing ' + Date.now() }] }); // 1 item + 2 sign-ups
// a legit parent changes something unrelated afterwards
r = await call(rnd(), 'POST', 'entries', { item_id: C.id, name: 'Admin Legit Later' });
const legitId = r.data.items.find(i => i.id === C.id).entries.at(-1).id;
s = await state();
ok(s.settings.party_date === 'CANCELLED' && s.items.some(i => i.name === 'Vandal item'), 'vandal changes applied (setup)');

// history records every kind of change, with hashed visitor ids only
const h = q(`SELECT who, action, tbl FROM history WHERE at >= datetime('now', '-5 minutes')`);
ok(['entries:update', 'entries:delete', 'settings:update', 'items:update', 'items:create', 'entries:create'].every(k => h.some(x => x.tbl + ':' + x.action === k)), 'history has edits, removes, date, needed count, item create');
ok(h.every(x => x.who === 'admin' || /^[0-9a-f]{24}$/.test(x.who)) && !q(`SELECT COUNT(*) AS n FROM history WHERE who LIKE '%:%' OR who LIKE '%.%'`)[0].n, 'history stores hashed visitors, no raw IPs');

// --- revert-visitor ---
const list = node('scripts/revert-visitor.mjs', '--list', '--since', since);
ok(/changes=13 /.test(list), 'revert-visitor --list shows the /64 visitor (9 actions + 1 cascaded sign-up + batch: 1 item, 2 sign-ups)');
const dry = node('scripts/revert-visitor.mjs', '--ip', V('abcd'), '--since', since, '--dry-run');
ok(/13 change\(s\) to revert/.test(dry) && fp(await state()) === fp(s), 'dry run (any address in the /64) changes nothing');
node('scripts/revert-visitor.mjs', '--ip', V(1), '--since', since);
s = await state();
const after = JSON.parse(fp(s));
after.items = after.items.map(i => [i[0], i[1], i[2], i[3].filter(e => e[0] !== legitId)]);
if (JSON.stringify(after) !== before) console.log('BEFORE', before, '\nAFTER ', JSON.stringify(after));
ok(JSON.stringify(after) === before, 'revert restores names, notes, removed sign-up, date, needed, removed Other item + its sign-up; vandal item + batch sign-ups gone');
ok(s.items.flatMap(i => i.entries).some(e => e.id === legitId), "other visitors' later changes kept");
ok(q(`SELECT COUNT(*) AS n FROM history WHERE action = 'revert-visitor'`)[0].n >= 1, 'revert is itself recorded in history');

// --- snapshots: take -> wipe -> restore -> undo ---
node('scripts/snapshot.mjs', 'take');
const good = fp(await state());
s = await state();
for (const e of s.items.flatMap(i => i.entries)) await call(rnd(), 'DELETE', `entries/${e.id}`);
await call(rnd(), 'PUT', 'settings', { key: 'party_time', value: 'WIPED' });
ok((await state()).items.every(i => !i.entries.length), 'wipe applied (setup)');
const wiped = fp(await state());
node('scripts/snapshot.mjs', 'restore', 'latest');
ok(fp(await state()) === good, 'snapshot restore brings back the exact pre-wipe state');
const undoId = q("SELECT MAX(id) AS id FROM snapshots WHERE kind = 'pre-restore'")[0].id;
node('scripts/snapshot.mjs', 'restore', String(undoId));
ok(fp(await state()) === wiped, 'restore can be undone from its pre-restore snapshot');
node('scripts/snapshot.mjs', 'restore', 'latest'); // back to good for the next checks
ok(fp(await state()) === good, 're-restore ok');

// --- worker-backup cron (wrangler dev --test-scheduled, same local D1) ---
const n0 = q("SELECT COUNT(*) AS n FROM snapshots WHERE kind = 'daily'")[0].n;
const w = spawn('npx', ['wrangler', 'dev', '-c', 'worker-backup/wrangler.toml', '--local', '--persist-to', process.env.PERSIST || '.wrangler/state', '--test-scheduled', '--port', '8797', '--ip', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore', detached: true });
try {
  let res = null;
  for (let i = 0; i < 40 && !res; i++) { await sleep(1000); res = await fetch('http://127.0.0.1:8797/__scheduled?cron=0+9+*+*+*').catch(() => null); }
  ok(res && res.ok, 'cron handler ran (/__scheduled)');
  await sleep(500);
  const d = q("SELECT id, data FROM snapshots WHERE kind = 'daily' ORDER BY id DESC LIMIT 1")[0];
  const snap = d && JSON.parse(d.data);
  ok(q("SELECT COUNT(*) AS n FROM snapshots WHERE kind = 'daily'")[0].n === n0 + 1 && snap.entries.length > 0 && snap.settings.length >= 2, 'daily snapshot row written with settings/items/entries');
} finally { try { process.kill(-w.pid); } catch (_) {} }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
