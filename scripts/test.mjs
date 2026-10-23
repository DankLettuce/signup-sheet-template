// Local API test. Usage: [CLASS_CODE=<same code as the server>] node scripts/test.mjs [http://127.0.0.1:8788]
// Run against a LOCAL server only, on a FRESH local database (it writes test data, and the rate-limit test
// uses fake per-run IPs so repeated runs don't lock you out). Expected defaults come from site.config.json.
import { readFileSync } from 'node:fs';
const BASE = process.argv[2] || 'http://127.0.0.1:8788';
const CFG = JSON.parse(readFileSync(new URL('../site.config.json', import.meta.url), 'utf8'));
const Y = new Date().getFullYear(); // year-less dates mean this year
const CODE = process.env.CLASS_CODE || '';
// Locally, wrangler passes CF-Connecting-IP through, so every request uses a fresh fake
// IP unless a test sets one (on Cloudflare the edge sets this header; it can't be spoofed).
const rnd = () => `10.${Math.random() * 255 | 0}.${Math.random() * 255 | 0}.${Math.random() * 255 | 0}`;
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra && !cond ? '  -> ' + extra : ''}`); };
async function call(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'CF-Connecting-IP': rnd(), ...(COOKIE ? { Cookie: COOKIE } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null; const t = await r.text(); try { data = JSON.parse(t); } catch { data = t; }
  return { status: r.status, data, headers: r.headers };
}
const findEntry = (s, id) => s.items.flatMap(i => i.entries).find(e => e.id === id);

// ---- class code (only when the server has one; pass the same code in CLASS_CODE) ----
let COOKIE = '';
{
  const g = await call('GET', '/api/state');
  if (g.status === 401) {
    ok(g.data.gate === true && g.data.event_name === CFG.event.event_name && !g.data.items && !g.data.settings, 'gate: without the code, /api/state only answers {gate, event_name} (no items, no names)');
    ok((await call('POST', '/api/entries', { item_id: 1, name: 'X' })).status === 401, 'gate: a write without the code -> 401');
    for (const p of ['/api/export.csv', '/api/export.json', '/api/event-copy.json', '/api/calendar.ics?name=a&item=b']) ok((await call('GET', p)).status === 401, `gate: ${p} without the code -> 401`);
    if (!CODE) { console.log('The server has a class code: run with CLASS_CODE=<code>'); process.exit(1); }
    let u = await call('POST', '/api/unlock', { code: 'definitely-wrong' });
    ok(u.status === 403 && !u.headers.get('set-cookie') && /didn’t work/.test(u.data.error), 'gate: wrong code -> 403, no cookie');
    u = await call('POST', '/api/unlock', { code: CODE }, { Origin: 'https://evil.example' });
    ok(u.status === 403 && !u.headers.get('set-cookie'), 'gate: cross-origin unlock refused');
    const messy = ' ' + CODE.toLowerCase().replace(/-/g, ' ') + ' ';
    u = await call('POST', '/api/unlock', { code: messy });
    const sc = u.headers.get('set-cookie') || '';
    ok(u.status === 200 && /^signup_pass=[0-9a-f]{40};/.test(sc) && /HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc) && !/Secure/i.test(sc), 'gate: right code (any case/spaces/dashes) -> 200 + HttpOnly SameSite=Lax cookie (not Secure over http)', sc);
    ok(!sc.includes(CODE) && !sc.toLowerCase().includes(CODE.toLowerCase().replace(/[^a-z0-9]/g, '')), 'gate: cookie does not contain the code');
    COOKIE = sc.split(';')[0];
    ok((await call('GET', '/api/state', undefined, { Cookie: 'signup_pass=' + '0'.repeat(64) })).status === 401, 'gate: a made-up cookie -> 401');
    const ip = rnd(); const st = [];
    for (let k = 0; k < 11; k++) st.push((await call('POST', '/api/unlock', { code: 'nope' + k }, { 'CF-Connecting-IP': ip })).status);
    ok(st.slice(0, 10).every(x => x === 403) && st[10] === 429, `gate: 10 tries per 10 minutes per visitor, then 429 (${st.join(',')})`);
  } else {
    ok(g.status === 200 && g.data.code === false && !CODE, 'no class code on this server (state.code false); gate tests skipped' + (CODE ? ' — but CLASS_CODE was given!' : ''));
  }
}
const auth = () => (COOKIE ? { Cookie: COOKIE } : {});

const s0 = (await call('GET', '/api/state')).data;
ok(Array.isArray(s0.items) && s0.items.map(i => i.name).join('|') === CFG.items.map(i => i.name).join('|'), 'state loads with the items from site.config.json, in order');
ok(s0.items.map(i => i.needed).join() === CFG.items.map(i => i.spots).join(), `spots from site.config.json (${s0.items.map(i => i.needed).join()})`);
ok(s0.settings.party_date === CFG.event.party_date && s0.settings.party_time === (CFG.event.party_time || 'TBD'), 'date/time from site.config.json');
ok(['event_name', 'teacher', 'class_name', 'school', 'intro', 'banner'].every(k => s0.settings[k] === CFG.event[k]) && s0.settings.organizer_name === CFG.organizer.name && s0.settings.organizer_contact === CFG.organizer.contact && s0.settings.add_your_own === CFG.add_your_own,
  'event details + organizer + "Add your own" position from site.config.json');
ok(s0.items.every((i, k) => k === 0 || i.sort > s0.items[k - 1].sort), 'items carry a list order (sort)');
const item = s0.items[0];
ok(s0.items.every(i => i.entries.every(e => !('qty' in e))), 'state has no qty on sign-ups');
await call('PUT', `/api/items/${item.id}`, { needed: 60 }); // room for the single-entry tests below (restored at clean-up)

// add / edit / remove entry
let r = await call('POST', '/api/entries', { item_id: item.id, name: 'Test Parent', note: 'Cupcakes' });
ok(r.status === 200, 'add entry', JSON.stringify(r.data));
const added = r.data.items.find(i => i.id === item.id).entries.at(-1);
ok(added && added.name === 'Test Parent' && added.note === 'Cupcakes', 'entry saved with name + note');
r = await call('PUT', `/api/entries/${added.id}`, { name: 'Test Parent 2', note: 'Cookies' });
ok(r.status === 200 && findEntry(r.data, added.id)?.note === 'Cookies', 'edit entry');
r = await call('POST', '/api/entries', { item_id: item.id });
ok(r.status === 200 && r.data.items.find(i => i.id === item.id).entries.at(-1).name === '', 'anonymous entry (name optional)');
r = await call('DELETE', `/api/entries/${added.id}`, {});
ok(r.status === 200 && !findEntry(r.data, added.id), 'remove entry (hidden from list)');
ok(r.data.removed.some(x => x.id === added.id), 'removed entry listed under Recently removed');
r = await call('POST', `/api/entries/${added.id}/restore`, {});
ok(r.status === 200 && findEntry(r.data, added.id)?.name === 'Test Parent 2', 'restore deleted entry');

// per-sign-up quantity
r = await call('POST', '/api/entries', { item_id: item.id, name: 'Qty Parent', qty: 3 });
const q = r.data.items?.find(i => i.id === item.id).entries.at(-1);
const { q: dq0 } = await import('./_d1.mjs');
ok(r.status === 200 && q && !('qty' in q) && dq0(`SELECT qty FROM entries WHERE id = ${q.id}`)[0].qty === 1, 'qty from the client is ignored (stored as 1: one sign-up = one person)');
r = await call('PUT', `/api/entries/${q.id}`, { name: 'Qty Parent', note: '', qty: 7 });
ok(r.status === 200 && dq0(`SELECT qty FROM entries WHERE id = ${q.id}`)[0].qty === 1, 'qty ignored on edit too');
r = await call('POST', '/api/entries', { item_id: item.id, qty: 'lots' }); ok(r.status === 200, 'odd qty value does not matter');
await call('DELETE', `/api/entries/${q.id}`, {}); await call('DELETE', `/api/entries/${findEntry(r.data, r.data.created[0].id).id}`, {});

// counts
r = await call('PUT', `/api/items/${item.id}`, { needed: 9 });
ok(r.status === 200 && r.data.items.find(i => i.id === item.id).needed === 9, 'edit spots (people) count');
await call('PUT', `/api/items/${item.id}`, { needed: 60 });
for (const bad of [-1, 100, 2.5, 'abc']) {
  r = await call('PUT', `/api/items/${item.id}`, { needed: bad });
  ok(r.status === 400, `reject needed=${JSON.stringify(bad)}`);
}
r = await call('PUT', `/api/items/${item.id}`, { name: 'Renamed standard' });
ok(r.status === 200 && r.data.items.find(i => i.id === item.id).name === 'Renamed standard', 'Organizer: a standard item can be renamed (plan item 2)');
r = await call('PUT', `/api/items/${item.id}`, { name: s0.items[1].name.toUpperCase() });
ok(r.status === 400 && /already has that name/.test(r.data.error), "rename to another item's name (any case) refused");
r = await call('PUT', `/api/items/${item.id}`, { name: item.name });
ok(r.status === 200 && r.data.items.find(i => i.id === item.id).name === item.name, 'rename back');

// Other item
r = await call('POST', '/api/items', { name: 'Pumpkin stickers', needed: 2 });
const other = r.data.items?.find(i => i.name === 'Pumpkin stickers');
ok(r.status === 200 && other?.is_custom && other.needed === 2, 'add Other item');
r = await call('PUT', `/api/items/${other.id}`, { name: 'Spooky stickers', needed: 4 });
ok(r.status === 200 && r.data.items.find(i => i.id === other.id)?.name === 'Spooky stickers', 'rename + recount Other item');
r = await call('DELETE', `/api/items/${other.id}`, {});
ok(r.status === 200 && !r.data.items.find(i => i.id === other.id), 'remove Other item (soft)');
{ const std = s0.items[2];
  r = await call('DELETE', `/api/items/${std.id}`, {});
  ok(r.status === 200 && !r.data.items.find(i => i.id === std.id) && r.data.removed_items.some(i => i.id === std.id), 'Organizer: a standard item can be removed (listed under Recently removed)');
  r = await call('POST', `/api/items/${std.id}/restore`, {});
  ok(r.status === 200 && r.data.items.find(i => i.id === std.id), 'removed standard item put back'); }

// ---- Organizer: reorder (↑ ↓) ----
{
  const ids = st => st.items.map(i => i.id);
  const before = ids((await call('GET', '/api/state')).data);
  r = await call('PUT', `/api/items/${before[1]}`, { move: -1 });
  const after = ids(r.data);
  ok(r.status === 200 && after[0] === before[1] && after[1] === before[0] && after.slice(2).join() === before.slice(2).join(), 'move up: item 2 becomes item 1, the rest stay');
  r = await call('PUT', `/api/items/${before[1]}`, { move: 1 });
  ok(r.status === 200 && ids(r.data).join() === before.join(), 'move down: back to the original order');
  ok((await call('PUT', `/api/items/${before[0]}`, { move: -1 })).status === 400, 'move the first item up -> 400');
  ok((await call('PUT', `/api/items/${before.at(-1)}`, { move: 1 })).status === 400, 'move the last item down -> 400');
  ok((await call('PUT', `/api/items/${before[0]}`, { move: 2 })).status === 400, 'move must be -1 or 1');
  const n = (await call('POST', '/api/items', { name: 'Order check', needed: 1 })).data.items;
  ok(n.at(-1).name === 'Order check', 'a new item goes to the end of the list');
  await call('DELETE', `/api/items/${n.at(-1).id}`, {});
}

// ---- Organizer: event details (all fields, one save) ----
{
  const vals = { event_name: 'Winter Party', teacher: 'Mr. Okafor', class_name: 'Room 12', school: 'Example School', intro: 'Line one\nLine two', banner: 'still', organizer_name: 'Pat Example', organizer_contact: 'pat@example.com', add_your_own: 'top' };
  r = await call('PUT', '/api/settings', { values: vals });
  ok(r.status === 200 && Object.entries(vals).every(([k, v]) => r.data.settings[k] === v), 'PUT settings {values}: all event details saved at once', JSON.stringify(r.data.settings));
  ok((await call('PUT', '/api/settings', { values: { banner: 'spinning' } })).status === 400, 'banner must be animated / still / none');
  ok((await call('PUT', '/api/settings', { values: { add_your_own: 'middle' } })).status === 400, '"Add your own" must be bottom / top');
  ok((await call('PUT', '/api/settings', { values: { intro: 'i'.repeat(301) } })).status === 400, 'intro > 300 rejected');
  ok((await call('PUT', '/api/settings', { values: { organizer_contact: 'c'.repeat(101) } })).status === 400, 'organizer contact > 100 rejected');
  ok((await call('PUT', '/api/settings', { values: { event_name: 'x', nope: 'y' } })).status === 400, 'unknown field in values rejected');
  const back = Object.fromEntries(Object.keys(vals).map(k => [k, s0.settings[k]]));
  r = await call('PUT', '/api/settings', { values: back });
  ok(r.status === 200 && Object.keys(vals).every(k => r.data.settings[k] === s0.settings[k]), 'event details put back');
}

// ---- Organizer: one-tap backup + "Copy this event" ----
{
  const e1 = (await call('POST', '/api/entries', { item_id: s0.items[1].id, name: '=HYPERLINK("x")', note: 'Has, comma "quote"' })).data.created[0].id;
  const csv = await fetch(BASE + '/api/export.csv', { headers: auth() });
  const cb = new Uint8Array(await csv.arrayBuffer()); const ct = new TextDecoder('utf-8', { ignoreBOM: true }).decode(cb);
  ok(csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type')) && /attachment; filename="[a-z0-9-]+-backup-\d{4}-\d{2}-\d{2}\.csv"/.test(csv.headers.get('content-disposition')), 'backup CSV: 200, text/csv, dated file name');
  ok(ct.startsWith('\uFEFFItem,Spots,Person,Note,Signed up\r\n'), 'backup CSV: BOM + header row (opens in Excel/Numbers/Sheets)');
  ok(ct.includes(`"'=HYPERLINK(""x"")"`) && ct.includes('"Has, comma ""quote"""'), 'backup CSV: formula-looking cells neutralised, commas/quotes escaped', ct.split('\r\n').find(l => l.includes('HYPER')));
  ok(CFG.items.every(i => ct.includes(i.name)), 'backup CSV: every item listed (open ones too)');
  const js = await fetch(BASE + '/api/export.json', { headers: auth() }); const jd = await js.json();
  ok(js.status === 200 && jd.format === 'signup-backup' && Array.isArray(jd.items) && Array.isArray(jd.entries) && jd.entries.some(e => e.deleted_at), 'full backup JSON: settings, items, entries incl. removed ones');
  const jt = JSON.stringify(jd);
  ok(!/"who"|"rate"|"history"|10\.\d+\.\d+\.\d+/.test(jt), 'full backup JSON: no visitor hashes, rate rows, history or IPs');
  const cp = await fetch(BASE + '/api/event-copy.json', { headers: auth() }); const cd = await cp.json();
  ok(cp.status === 200 && cd.format === 'signup-event-copy' && cd.event.event_name === CFG.event.event_name && cd.items.length === s0.items.length && cd.items.every(i => typeof i.name === 'string' && Number.isInteger(i.spots)), '"Copy this event": event details + items (name, spots)');
  ok(!JSON.stringify(cd).includes('HYPERLINK') && !('entries' in cd) && !/code/i.test(Object.keys(cd).join()), '"Copy this event": no sign-ups, no names, no class code');
  await call('DELETE', `/api/entries/${e1}`, {});
}

// date / time
r = await call('PUT', '/api/settings', { key: 'party_date', value: 'Fri, Oct 30' });
ok(r.status === 200 && r.data.settings.party_date === 'Fri, Oct 30', 'edit date');
r = await call('PUT', '/api/settings', { key: 'party_time', value: '' });
ok(r.status === 200 && r.data.settings.party_time === 'TBD', 'blank time falls back to TBD');
r = await call('GET', '/api/state');
r = await call('PUT', '/api/settings', { key: 'admin', value: 'x' });
ok(r.status === 400, 'unknown setting rejected');

// injection is stored verbatim as text (rendered via textContent in the UI)
const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
r = await call('POST', '/api/entries', { item_id: item.id, name: evil.slice(0, 60), note: evil });
const ev = r.data.items?.find(i => i.id === item.id).entries.at(-1);
ok(r.status === 200 && ev.note === evil, 'HTML stored as plain text (not executed; see UI check)');
const evilId = ev?.id;
const sql = "x'); DROP TABLE entries; --";
r = await call('POST', '/api/entries', { item_id: item.id, name: sql });
ok(r.status === 200 && (await call('GET', '/api/state')).status === 200, 'SQL injection string harmless');

// length limits
r = await call('POST', '/api/entries', { item_id: item.id, name: 'a'.repeat(61) }); ok(r.status === 400, 'name > 60 rejected');
r = await call('POST', '/api/entries', { item_id: item.id, name: 'a'.repeat(60) }); ok(r.status === 200, 'name = 60 accepted');
r = await call('POST', '/api/entries', { item_id: item.id, note: 'b'.repeat(201) }); ok(r.status === 400, 'note > 200 rejected');
r = await call('POST', '/api/items', { name: 'c'.repeat(61), needed: 1 }); ok(r.status === 400, 'item name > 60 rejected');
r = await call('PUT', '/api/settings', { key: 'party_date', value: 'd'.repeat(61) }); ok(r.status === 400, 'date > 60 rejected');
r = await call('POST', '/api/entries', { item_id: item.id, name: { x: 1 } }); ok(r.status === 400, 'non-text name rejected');
r = await call('POST', '/api/entries', { item_id: 999999 }); ok(r.status === 404, 'unknown item rejected');

// request hygiene
let raw = await fetch(BASE + '/api/entries', { method: 'POST', headers: { 'Content-Type': 'text/plain', ...auth() }, body: '{"item_id":1}' });
ok(raw.status === 415, 'non-JSON write rejected');
raw = await fetch(BASE + '/api/entries', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', ...auth() }, body: '{"item_id":1}' });
ok(raw.status === 403, 'cross-origin write rejected');

// ---- 'Add to calendar': GET /api/calendar.ics (no DB write) ----
const { q: dqc } = await import('./_d1.mjs');
const cnt0 = dqc('SELECT (SELECT COUNT(*) FROM history) AS h, (SELECT COUNT(*) FROM entries) AS e, (SELECT COUNT(*) FROM rate) AS r')[0];
const icsGet = qs => fetch(BASE + '/api/calendar.ics?' + qs, { headers: auth() });
const lintIcs = t => {
  const errs = [];
  if (/[^\r]\n/.test(t) || !t.endsWith('\r\n')) errs.push('not CRLF');
  const lines = t.split('\r\n').slice(0, -1);
  if (lines.some(l => new TextEncoder().encode(l).length > 75)) errs.push('line > 75 octets');
  const un = t.replace(/\r\n /g, '').split('\r\n').slice(0, -1);
  const stack = [];
  for (const l of un) { if (l.startsWith('BEGIN:')) stack.push(l.slice(6)); else if (l.startsWith('END:') && stack.pop() !== l.slice(4)) errs.push('BEGIN/END mismatch ' + l); }
  if (stack.length) errs.push('unclosed ' + stack);
  for (const k of ['VERSION:2.0', 'PRODID:', 'UID:', 'DTSTAMP:', 'DTSTART', 'SUMMARY:']) if (!un.some(l => l.startsWith(k))) errs.push('missing ' + k);
  if (!un.some(l => /^DTSTAMP:\d{8}T\d{6}Z$/.test(l))) errs.push('bad DTSTAMP');
  if (!un.some(l => l.startsWith('UID:') && l.endsWith('@' + new URL(BASE).host) && !/\s/.test(l))) errs.push('bad UID');
  return { errs, un };
};
const icsName = 'Ann, "B"; C\\x <b>';
let ir = await icsGet(new URLSearchParams([['name', icsName], ['item', 'Cups'], ['item', 'Napkins; big ' + 'é'.repeat(40)]]));
let it = await ir.text(); let li = lintIcs(it);
ok(ir.status === 200 && ir.headers.get('content-type') === 'text/calendar; charset=utf-8' && new RegExp(`^attachment; filename="${CFG.event.event_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}\\.ics"$`).test(ir.headers.get('content-disposition') || ''),
  `ics: 200, Content-Type text/calendar, Content-Disposition attachment (${ir.headers.get('content-type')})`);
ok(!li.errs.length, 'ics: valid format (CRLF, folded at 75 octets, BEGIN/END, VERSION, PRODID, UID, DTSTAMP)' + (li.errs.length ? ': ' + li.errs.join('; ') : ''));
ok(li.un.includes(`DTSTART;VALUE=DATE:${Y}1030`) && li.un.includes(`DTEND;VALUE=DATE:${Y}1031`) && !li.un.some(l => l.startsWith('BEGIN:VTIMEZONE')), 'ics: time TBD -> all-day event on the page date ("Fri, Oct 30" -> Oct 30 this year)');
ok(li.un.some(l => l.startsWith('SUMMARY:') && l.includes(CFG.event.event_name)) && li.un.some(l => l === 'LOCATION:' + CFG.event.school), 'ics: title + location from the event details');
ok(li.un.some(l => l.startsWith('DESCRIPTION:Ann\\, "B"\\; C\\\\x <b> is bringing: Cups\\, Napkins\\; big é')), 'ics: name and items TEXT-escaped (, ; \\ and newlines)');
await call('PUT', '/api/settings', { key: 'party_time', value: '1:30–3 PM' });
ir = await icsGet('name=Sam&item=Plates'); li = lintIcs(await ir.text());
ok(!li.errs.length && li.un.includes(`DTSTART;TZID=America/New_York:${Y}1030T133000`) && li.un.includes(`DTEND;TZID=America/New_York:${Y}1030T150000`) && li.un.includes('TZID:America/New_York') && li.un.includes('RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU'),
  "ics: page time '1:30–3 PM' -> 13:30-15:00 America/New_York with VTIMEZONE");
await call('PUT', '/api/settings', { key: 'party_time', value: s0.settings.party_time });
ok((await icsGet('name=' + 'n'.repeat(61))).status === 400, 'ics: name over 60 characters rejected');
const cnt1 = dqc('SELECT (SELECT COUNT(*) FROM history) AS h, (SELECT COUNT(*) FROM entries) AS e, (SELECT COUNT(*) FROM rate) AS r')[0];
ok(cnt1.e === cnt0.e && cnt1.h === cnt0.h + 2, 'ics: no DB write (only the 2 time edits above are in history)');

// ---- party date parsing: never a guessed date; year-less -> this year; unreadable -> no button + 422 ----
const { parsePartyDate } = await import('../lib/ics.js');
const pdCases = { 'Thursday, October 29, 2026': [2026, 10, 29], 'October 29, 2026': [2026, 10, 29], 'Oct 29': [Y, 10, 29], 'Oct. 30th': [Y, 10, 30],
  '10/29/2026': [2026, 10, 29], '10/29': [Y, 10, 29], '11/2': [Y, 11, 2], '10/29/26': [2026, 10, 29], '29 October': [Y, 10, 29], '2026-10-29': [2026, 10, 29],
  'TBD': null, '': null, 'next week': null, '2/30/2026': null, '13/1/2026': null, 'Oct 32': null, 'Thursday': null };
const pdBad = Object.entries(pdCases).filter(([k, v]) => JSON.stringify(parsePartyDate(k)) !== JSON.stringify(v));
ok(!pdBad.length, 'parsePartyDate: M/D/YYYY, M/D, M/D/YY, "Oct 29", "October 29, 2026", weekday forms, ISO; year-less -> this year; unreadable/impossible -> null', JSON.stringify(pdBad));
const dateCase = async (value, expectYmd) => {
  await call('PUT', '/api/settings', { key: 'party_date', value });
  await new Promise(r => setTimeout(r, 3200)); // /api/state memo
  const st = (await call('GET', '/api/state')).data, r = await call('GET', '/api/calendar.ics?name=Sam&item=Cups');
  if (expectYmd === null) return st.calendar === false && r.status === 422 && /calendar date/.test(r.data.error) && !/text\/calendar/.test(r.headers.get('content-type'));
  return st.calendar === true && r.status === 200 && r.data.includes(`DTSTART;VALUE=DATE:${expectYmd}`);
};
ok(await dateCase('10/30/2026', '20261030'), 'ics: date "10/30/2026" -> 2026-10-30 (state.calendar true)');
ok(await dateCase('Oct 28', `${Y}1028`), 'ics: year-less "Oct 28" -> Oct 28 this year');
ok(await dateCase('11/2', `${Y}1102`), 'ics: year-less "11/2" -> Nov 2 this year');
ok(await dateCase('Thursday, October 29, 2026', '20261029'), 'ics: "Thursday, October 29, 2026" -> 2026-10-29');
ok(await dateCase('Sometime next week', null), 'ics: unreadable date -> 422 (no guessed Oct 29), state.calendar false so the page hides the button');
ok(await dateCase('TBD', null), 'ics: date TBD -> 422');
await call('PUT', '/api/settings', { key: 'party_date', value: s0.settings.party_date });

// ---- Undo / Put back re-check the spots (same transaction) -> 409, never overfill ----
{
  const it1 = (await call('POST', '/api/items', { name: 'Undo full ' + Date.now(), needed: 1 })).data.items.at(-1);
  const cr = async body => { const x = await call('POST', '/api/entries', body); if (!x.data.created) console.log('   (debug)', it1.name, x.status, JSON.stringify(x.data.error)); return x.data.created[0].id; };
  const a = await cr({ item_id: it1.id, name: 'First' });
  await call('DELETE', `/api/entries/${a}`, {});
  const b = await cr({ item_id: it1.id, name: 'Took it' });
  const live1 = () => dqc(`SELECT COUNT(*) AS n FROM entries WHERE item_id = ${it1.id} AND deleted_at IS NULL`)[0].n;
  let r = await call('POST', `/api/entries/${a}/restore`, {});
  ok(r.status === 409 && /just got covered by someone else\. Nothing was saved/.test(r.data.error) && live1() === 1, 'Undo/Put back of a sign-up on a full item -> 409 "just got covered", no overfill', JSON.stringify(r.data));
  r = await call('POST', `/api/entries/${a}/restore`, {}, { 'X-Test-Skip-Precheck': '1' });
  ok(r.status === 409 && live1() === 1 && dqc(`SELECT deleted_at FROM entries WHERE id = ${a}`)[0].deleted_at && !dqc(`SELECT COUNT(*) AS n FROM history WHERE tbl = 'entries' AND row_id = '${a}' AND action = 'restore'`)[0].n,
    'restore guard inside the transaction (precheck skipped): 409, entry stays removed, no history row');
  await call('DELETE', `/api/entries/${b}`, {});
  r = await call('POST', `/api/entries/${a}/restore`, {});
  ok(r.status === 200 && live1() === 1, 'Put back works again once the spot is free');
  // item put back with its sign-ups: refused if that would overfill (organizer lowered spots before removing)
  const it2 = (await call('POST', '/api/items', { name: 'Item back ' + Date.now(), needed: 2 })).data.items.at(-1);
  await call('POST', '/api/entries', { item_id: it2.id, name: 'P1' }); await call('POST', '/api/entries', { item_id: it2.id, name: 'P2' });
  await call('PUT', `/api/items/${it2.id}`, { needed: 1 });
  await call('DELETE', `/api/items/${it2.id}`, {});
  r = await call('POST', `/api/items/${it2.id}/restore`, {});
  ok(r.status === 409 && dqc(`SELECT deleted_at FROM items WHERE id = ${it2.id}`)[0].deleted_at && !dqc(`SELECT COUNT(*) AS n FROM entries WHERE item_id = ${it2.id} AND deleted_at IS NULL`)[0].n,
    'Put back of an item whose sign-ups no longer fit -> 409, item and sign-ups stay removed');
  const it3 = (await call('POST', '/api/items', { name: 'Item ok ' + Date.now(), needed: 2 })).data.items.at(-1);
  await call('POST', '/api/entries', { item_id: it3.id, name: 'P3' }); await call('DELETE', `/api/items/${it3.id}`, {});
  r = await call('POST', `/api/items/${it3.id}/restore`, {});
  ok(r.status === 200 && dqc(`SELECT COUNT(*) AS n FROM entries WHERE item_id = ${it3.id} AND deleted_at IS NULL`)[0].n === 1, 'Put back of an item that fits still restores it with its sign-ups');
  for (const id of [it1.id, it3.id]) await call('DELETE', `/api/items/${id}`, {});
}

// headers / noindex
const page = await fetch(BASE + '/');
const html = await page.text();
ok(/noindex/.test(page.headers.get('x-robots-tag') || ''), 'X-Robots-Tag on page');
ok(/<meta name="robots" content="noindex/.test(html), 'meta robots noindex');
ok(/frame-ancestors 'none'/.test(page.headers.get('content-security-policy') || '') && !/unsafe-inline/.test(page.headers.get('content-security-policy')), 'CSP (no unsafe-inline, frame-ancestors none)');
ok(page.headers.get('x-content-type-options') === 'nosniff', 'nosniff on page');
ok(!/<script>[^<]/.test(html), 'no inline scripts in page');
const api = await call('GET', '/api/state');
ok(/noindex/.test(api.headers.get('x-robots-tag') || '') && api.headers.get('x-content-type-options') === 'nosniff', 'API security headers');
ok(/Disallow: \//.test(await (await fetch(BASE + '/robots.txt')).text()), 'robots.txt Disallow /');

// clean up test rows
for (const e of (await call('GET', '/api/state')).data.items.flatMap(i => i.entries)) {
  if (['Qty Parent', 'Test Parent 2', '', 'a'.repeat(60), sql, evil.slice(0, 60)].includes(e.name)) await call('DELETE', `/api/entries/${e.id}`, {});
}
await call('PUT', `/api/items/${item.id}`, { needed: item.needed });
for (const e of dq0("SELECT id FROM entries WHERE deleted_at IS NULL AND name LIKE 'Bulk %' OR (deleted_at IS NULL AND name = 'Idem Parent')")) await call('DELETE', `/api/entries/${e.id}`, {});
await call('PUT', '/api/settings', { key: 'party_date', value: s0.settings.party_date });
await call('PUT', '/api/settings', { key: 'party_time', value: s0.settings.party_time });

// ---- new in fix round ----
const sleep = ms => new Promise(r => setTimeout(r, ms));
const W = (ip, extra = {}) => ({ 'CF-Connecting-IP': ip, ...extra });
const put = h => call('PUT', '/api/settings', { key: 'party_time', value: 'TBD' }, h);
const toNextWindow = async sec => { const t = Date.now() / 1000; await sleep(((sec - t % sec) + 0.2) * 1000); };

// idempotent retries
const rq = 'test-' + Math.random().toString(36).slice(2, 12);
r = await call('POST', '/api/entries', { item_id: item.id, name: 'Idem Parent' }, { 'X-Req-Id': rq });
r = await call('POST', '/api/entries', { item_id: item.id, name: 'Idem Parent' }, { 'X-Req-Id': rq });
const idem = r.data.items.find(i => i.id === item.id).entries.filter(e => e.name === 'Idem Parent');
ok(r.status === 200 && idem.length === 1, 'retried write with same X-Req-Id applied once');
await call('DELETE', `/api/entries/${idem[0].id}`, {});

// write then immediate read is fresh (state cache is refreshed on write)
await call('PUT', '/api/settings', { key: 'party_time', value: 'Cache check' });
ok((await call('GET', '/api/state')).data.settings.party_time === 'Cache check', 'GET after write is fresh');
await call('PUT', '/api/settings', { key: 'party_time', value: '' });

// Other item removal takes its sign-ups; putting it back brings them back
r = await call('POST', '/api/items', { name: 'Cascade item', needed: 3 });
const ci = r.data.items.find(i => i.name === 'Cascade item');
await call('POST', '/api/entries', { item_id: ci.id, name: 'Cascade A' });
await call('POST', '/api/entries', { item_id: ci.id, name: 'Cascade B' });
r = await call('POST', '/api/entries', { item_id: ci.id, name: 'Cascade gone' });
const gone = r.data.items.find(i => i.id === ci.id).entries.find(e => e.name === 'Cascade gone');
await call('DELETE', `/api/entries/${gone.id}`, {});
r = await call('DELETE', `/api/items/${ci.id}`, {});
const ri = r.data.removed_items.find(x => x.id === ci.id);
ok(ri && ri.entry_count === 2 && !r.data.items.some(i => i.id === ci.id), 'removed Other item listed with its 2 sign-ups');
r = await call('POST', `/api/entries/${gone.id}/restore`, {});
ok(r.status === 400, 'cannot put back a sign-up whose item is removed');
r = await call('POST', `/api/items/${ci.id}/restore`, {});
const back = r.data.items.find(i => i.id === ci.id);
ok(back && back.entries.map(e => e.name).sort().join() === 'Cascade A,Cascade B', 'put back Other item restores exactly its sign-ups');
await call('DELETE', `/api/items/${ci.id}`, {});

// Recently removed shows far more than 20
const bulkItem = r.data.items[2];
for (let i = 0; i < 25; i++) {
  const a = await call('POST', '/api/entries', { item_id: bulkItem.id, name: 'Bulk ' + i });
  await call('DELETE', `/api/entries/${a.data.items.find(x => x.id === bulkItem.id).entries.at(-1).id}`, {});
}
r = await call('GET', '/api/state');
ok(r.data.removed.filter(x => x.name.startsWith('Bulk ')).length >= 25, `Recently removed not capped at 20 (${r.data.removed.length} shown)`);

// ---- batch sign-up (POST /api/batch) ----
const { q: dq } = await import('./_d1.mjs');
const counts = () => dq('SELECT (SELECT COUNT(*) FROM entries) AS e, (SELECT COUNT(*) FROM items) AS i, (SELECT COUNT(*) FROM history) AS h')[0];
const tag = Math.random().toString(36).slice(2, 7);
const items = [];
for (let k = 0; k < 9; k++) { const rr = await call('POST', '/api/items', { name: `T${k} ${tag}`, needed: 60 }); items.push(rr.data.items.find(i => i.name === `T${k} ${tag}`)); }
const [I0, I1, I2, I3, I4, I5] = items;
const B = (body, h = {}) => call('POST', '/api/batch', body, h);
const reqB = 'batch-' + tag + '-0001';
const evilName = `<img src=x onerror=alert(1)> Bat ${tag}`;
r = await B({ name: evilName, note: 'Batch note', rows: [{ item_id: I0.id, qty: 2 }, { item_id: I1.id, note: 'gluten-free' }], others: [{ name: `Glow sticks ${tag}`, qty: 3 }] }, { 'X-Req-Id': reqB });
const gi = r.data.items?.find(i => i.name === `Glow sticks ${tag}`);
ok(r.status === 200 && r.data.created?.length === 3, 'batch: 2 rows + 1 new Other item saved in one request', JSON.stringify(r.data).slice(0, 300));
ok(gi && gi.is_custom && gi.needed === 1 && gi.entries.length === 1, "batch: 'Add your own' item created with 1 spot, taken by this person");
const cr = r.data.created || [];
ok(cr.map(c => c.item_id).join() === [I0.id, I1.id, gi?.id].join() && cr.every(c => findEntry(r.data, c.id)?.name === evilName), 'batch: created ids returned in submit order; name stored exactly as typed (HTML is text)');
ok(findEntry(r.data, cr[0]?.id)?.note === 'Batch note' && findEntry(r.data, cr[1]?.id)?.note === 'gluten-free' && findEntry(r.data, cr[2]?.id)?.note === 'Batch note' && dq(`SELECT MAX(qty) AS m FROM entries WHERE id IN (${cr.map(c => c.id)})`)[0].m === 1,
  "batch: 'Anything to add?' note stored on each entry (a row note overrides); qty ignored");
const hb = dq(`SELECT tbl, action, who FROM history WHERE req = '${reqB}'`);
ok(hb.length === 4 && hb.filter(x => x.tbl === 'entries' && x.action === 'create').length === 3 && hb.filter(x => x.tbl === 'items').length === 1 && hb.every(x => /^[0-9a-f]{24}$/.test(x.who)), 'batch: every new row in history (hashed visitor, request id)');
let c0 = counts();
r = await B({ name: evilName, note: 'Batch note', rows: [{ item_id: I0.id, qty: 2 }, { item_id: I1.id, note: 'gluten-free' }], others: [{ name: `Glow sticks ${tag}`, qty: 3 }] }, { 'X-Req-Id': reqB });
let c1 = counts();
ok(r.status === 200 && r.data.replayed && r.data.created.map(x => x.id).join() === cr.map(x => x.id).join() && c1.e === c0.e && c1.i === c0.i && c1.h === c0.h, 'batch: retry with the same request id is not applied twice, returns the same ids');
c0 = counts();
r = await B({ name: 'Dedupe ' + tag, others: [{ name: `  GLOW sticks ${tag} ` }] }); c1 = counts();
ok(r.status === 409 && /just got covered/.test(r.data.error) && c1.i === c0.i && c1.e === c0.e, "batch: 'Add your own' with the name of a covered item -> 'just got covered', no duplicate item");
await call('PUT', `/api/items/${gi.id}`, { needed: 2 });
r = await B({ name: 'Dedupe ' + tag, others: [{ name: `  GLOW sticks ${tag} ` }] });
ok(r.status === 200 && r.data.items.filter(i => i.name.toLowerCase() === `glow sticks ${tag}`).length === 1 && r.data.created[0].item_id === gi?.id, 'batch: same name as an item with a free spot joins it (no duplicate item)');

// per-row errors: nothing written
c0 = counts();
r = await B({ name: 'Bad ' + tag, rows: [{ item_id: I2.id }, { item_id: 987654 }, { item_id: 'abc' }, { item_id: I2.id }], others: [{ name: '' }, { name: 'x'.repeat(61) }] });
c1 = counts();
const idx = (r.data.rows || []).map(e => e.kind + e.index).sort().join();
ok(r.status === 400 && idx === 'other0,other1,row1,row2,row3' && (r.data.rows || []).every(e => e.error), `batch: per-row errors (${idx})`, JSON.stringify(r.data));
ok(c1.e === c0.e && c1.i === c0.i && c1.h === c0.h, 'batch: one bad row -> nothing written (all or nothing)');
// atomic rollback inside the database: a statement fails mid-batch (local test hook)
c0 = counts();
r = await B({ name: 'Rollback ' + tag, rows: [{ item_id: I2.id }, { item_id: I3.id }, { item_id: I4.id }], others: [{ name: `Rollback item ${tag}` }] }, { 'X-Test-Fail-After': '3' });
c1 = counts();
ok(r.status === 409 && c1.e === c0.e && c1.i === c0.i && c1.h === c0.h, `batch: DB failure mid-batch rolls everything back (status ${r.status})`);
ok(!r.data.items && /Nothing was saved/.test(r.data.error || ''), 'batch: clear message on rollback');
// slots: an item is covered when it has as many people as spots
const mk = async (name, needed) => (await call('POST', '/api/items', { name, needed })).data.items.find(i => i.name === name);
const one = await mk(`Last spot ${tag}`, 1), roomy = await mk(`Roomy ${tag}`, 60);
r = await B({ name: 'First ' + tag, rows: [{ item_id: one.id }] });
c0 = counts();
r = await B({ name: 'Second ' + tag, rows: [{ item_id: roomy.id }, { item_id: one.id }] }); c1 = counts();
ok(r.status === 409 && /Last spot .* just got covered/.test(r.data.error) && /Nothing was saved/.test(r.data.error) && c1.e === c0.e && c1.h === c0.h,
  `slots: a covered item is refused with 'just got covered', the rest of the batch is not saved (${r.status})`, r.data.error);
r = await call('POST', '/api/entries', { item_id: one.id, name: 'Single ' + tag });
ok(r.status === 409 && /just got covered/.test(r.data.error), 'slots: single sign-up on a covered item refused too');
// the guard inside the transaction (pre-check skipped by a local-only test hook) catches the race
c0 = counts();
r = await B({ name: 'Racer ' + tag, rows: [{ item_id: roomy.id }, { item_id: one.id }] }, { 'X-Test-Skip-Precheck': '1' }); c1 = counts();
ok(r.status === 409 && /just got covered/.test(r.data.error) && c1.e === c0.e && c1.h === c0.h, `slots: in-transaction guard rolls back the whole batch (${r.status})`);
// two parents, same last spot, same moment: exactly one wins, the other gets a clear message and nothing partial
let raceOk = true;
for (let k = 0; k < 4; k++) {
  const last = await mk(`Race ${k} ${tag}`, 1);
  const [ra1, ra2] = await Promise.all([B({ name: `Par A${k} ${tag}`, rows: [{ item_id: roomy.id }, { item_id: last.id }] }), B({ name: `Par B${k} ${tag}`, rows: [{ item_id: roomy.id }, { item_id: last.id }] })]);
  const st = [ra1.status, ra2.status].sort().join(), loser = ra1.status === 200 ? `Par B${k} ${tag}` : `Par A${k} ${tag}`;
  const loserRows = dq(`SELECT COUNT(*) AS n FROM entries WHERE name = '${loser}'`)[0].n, onLast = dq(`SELECT COUNT(*) AS n FROM entries WHERE item_id = ${last.id} AND deleted_at IS NULL`)[0].n;
  const msg = (ra1.status === 409 ? ra1 : ra2).data.error || '';
  if (!(st === '200,409' && loserRows === 0 && onLast === 1 && /just got covered/.test(msg))) { raceOk = false; console.log('   race', k, st, loserRows, onLast, msg); }
}
ok(raceOk, 'slots: two parents race for the last spot (4 rounds): one wins, the other gets "just got covered", nothing partial');

// caps
const many = Array.from({ length: 16 }, (_, k) => ({ item_id: items[k % items.length].id }));
r = await B({ name: 'Cap', rows: many });
ok(r.status === 400 && /At most 15/.test(r.data.error), 'batch: more than 15 rows rejected');
r = await B({ name: 'Cap', others: Array.from({ length: 9 }, (_, k) => ({ name: `Cap other ${tag} ${k}` })) });
ok(r.status === 400 && /more than 8 new items\. 8 is the max for one sign-up\. Nothing was saved\./.test(r.data.error), 'batch: 9 new Other items rejected (cap 8), friendly message');
{ // 8 new items in one sign-up: accepted, 8 separate items with 1 sign-up each (8 rows: within 15/batch, 40 rows/10 min, 25 live)
  const n0 = (await call('GET', '/api/state')).data.items.length;
  r = await B({ name: 'Cap8 ' + tag, others: Array.from({ length: 8 }, (_, k) => ({ name: `Cap8 item ${tag} ${k}` })) });
  await new Promise(res => setTimeout(res, 3200));
  const st = (await call('GET', '/api/state')).data, mine = st.items.filter(i => i.name.startsWith(`Cap8 item ${tag}`));
  ok(r.status === 200 && r.data.created.length === 8 && mine.length === 8 && mine.every(i => i.entries.length === 1 && i.entries[0].name === 'Cap8 ' + tag) && st.items.length === n0 + 8,
    'batch: 8 new Other items accepted as 8 separate items, one sign-up each', JSON.stringify(r.data).slice(0, 200));
  for (const i of mine) await call('DELETE', '/api/items/' + i.id, {});
}
r = await B({ name: 'Empty' });
ok(r.status === 400 && /at least one/.test(r.data.error), 'batch: empty batch rejected');
r = await call('POST', '/api/batch', { name: 'Big', rows: [{ item_id: I0.id, note: 'n'.repeat(17000) }] });
ok(r.status === 413, 'batch: body over 16 KB rejected');
// one batch = ONE request for the burst limit (its rows count toward the 10-minute limit, tested below)
await toNextWindow(10);
const bip1 = rnd(); const bst = [];
bst.push((await B({ name: 'Rate ' + tag, rows: [I0, I1, I2, I3, I4].map(i => ({ item_id: i.id })) }, W(bip1))).status);
for (let i = 0; i < 5; i++) bst.push((await put(W(bip1))).status);
ok(bst.slice(0, 5).every(x => x === 200) && bst[5] === 429, `burst: a batch of 5 rows counts as one request (${bst.join(",")})`);
// two parents submit at the same moment onto the same items: both land, nothing overwritten
c0 = counts();
const [p1, p2] = await Promise.all([
  B({ name: 'Concurrent A ' + tag, rows: [{ item_id: I5.id }, { item_id: I4.id }], others: [{ name: `New A ${tag}` }] }),
  B({ name: 'Concurrent B ' + tag, rows: [{ item_id: I5.id }, { item_id: I4.id }], others: [{ name: `New B ${tag}` }] }),
]);
c1 = counts();
const fin = (await call('GET', '/api/state')).data;
const onI5 = fin.items.find(i => i.id === I5.id).entries.map(e => e.name);
ok(p1.status === 200 && p2.status === 200 && onI5.includes('Concurrent A ' + tag) && onI5.includes('Concurrent B ' + tag) && c1.e - c0.e === 6, `two concurrent batches both saved (${c1.e - c0.e} new sign-ups)`);
ok([...p1.data.created, ...p2.data.created].every(c => findEntry(fin, c.id)), 'concurrent batches: every returned id is live');

// burst limit: 5 writes / 10 s per visitor
await toNextWindow(10);
let st = []; const bip = rnd();
for (let i = 0; i < 6; i++) st.push((await put(W(bip))).status);
r = await put(W(bip));
ok(st.slice(0, 5).every(x => x === 200) && st[5] === 429, `burst: 5 allowed, 6th blocked (${st.join(',')})`);
const ra = Number(r.headers.get('retry-after'));
ok(ra >= 1 && ra <= 10 && /few seconds/.test(r.data.error), `burst 429 has Retry-After ${ra}s + message`);

// IPv6: counted per /64; IPv4 per address
await toNextWindow(10);
const p6 = `2001:db8:${(Math.random() * 65535 | 0).toString(16)}:${(Math.random() * 65535 | 0).toString(16)}`;
st = []; for (let i = 1; i <= 6; i++) st.push((await put(W(`${p6}::${i.toString(16)}`))).status);
ok(st.slice(0, 5).every(x => x === 200) && st[5] === 429, `IPv6: 6 addresses in one /64 share a budget (${st.join(',')})`);
ok((await put(W(`${p6.replace(/:[^:]+$/, ':ffff')}::1`))).status === 200, 'IPv6: a different /64 is separate');
const v4 = rnd().replace(/\.\d+$/, ''); st = []; for (let i = 1; i <= 6; i++) st.push((await put(W(`${v4}.${i}`))).status);
ok(st.every(x => x === 200), 'IPv4: neighbouring addresses are separate');

// 10-minute limit: 40 single writes allowed (paced under the burst limit), 41st blocked
const lip = rnd(); let n = 0, got429 = false;
if (600 - (Date.now() / 1000) % 600 < 120) { console.log('  (waiting for a fresh 10-minute window…)'); await toNextWindow(600); }
await toNextWindow(10);
while (n < 50 && !got429) {
  for (let k = 0; k < 5 && !got429; k++) { r = await put(W(lip)); n++; got429 = r.status === 429; }
  if (!got429) await toNextWindow(10);
}
ok(got429 && n === 41 && /few minutes/.test(r.data.error), `10-min limit: 40 single writes allowed, #41 blocked (blocked at #${n})`);

// ---- 10-minute limit counts ROWS (a batch counts each sign-up) ----
const nine = items.slice(0, 9).map(i => ({ item_id: i.id }));
const freeUp = async nm => { for (const e of dq(`SELECT id FROM entries WHERE deleted_at IS NULL AND name = '${nm}'`)) await call('DELETE', `/api/entries/${e.id}`, {}); }; // other visitors remove them
const liveBy = nm => dq(`SELECT COUNT(*) AS n FROM entries WHERE deleted_at IS NULL AND name = '${nm}'`)[0].n;
if (600 - (Date.now() / 1000) % 600 < 150) { console.log('  (waiting for a fresh 10-minute window…)'); await toNextWindow(600); }
await toNextWindow(10);
const rowip = rnd(), rowNm = 'Rows ' + tag, rs = [];
for (let k = 0; k < 4; k++) { rs.push((await B({ name: rowNm, rows: nine }, W(rowip))).status); if (k < 3) await freeUp(rowNm); }
c0 = counts();
r = await B({ name: rowNm, rows: nine.slice(0, 5) }, W(rowip)); c1 = counts();
ok(rs.every(x => x === 200) && r.status === 429 && /Nothing was saved/.test(r.data.error) && /min/.test(r.data.error) && Number(r.headers.get('retry-after')) > 12,
  `row limit: 4 batches of 9 = 36 rows ok, a 5-row batch (41) refused with a friendly message (${rs.join(',')},${r.status})`, r.data.error);
ok(c1.e === c0.e && c1.h === c0.h, 'row limit: refused batch saved nothing');
await toNextWindow(10);
r = await B({ name: rowNm, rows: nine.slice(0, 4) }, W(rowip));
ok(r.status === 200, `row limit: a 4-row batch still fits (40 rows; the refused batch used none) (${r.status})`, JSON.stringify(r.data.error));
r = await call('POST', '/api/entries', { item_id: I0.id, name: rowNm }, W(rowip));
ok(r.status === 429 && /few minutes/.test(r.data.error), `row limit: then a single sign-up (row 41) is refused (${r.status})`);

// ---- cap: 25 live sign-ups per visitor; removing one frees a slot ----
await toNextWindow(10);
const capip = rnd(), capNm = 'Cap ' + tag, cs = [];
cs.push((await B({ name: capNm, rows: nine }, W(capip))).status, (await B({ name: capNm, rows: nine }, W(capip))).status);
c0 = counts();
r = await B({ name: capNm, rows: nine.slice(0, 8) }, W(capip)); c1 = counts();
ok(cs.every(x => x === 200) && r.status === 429 && /the most is 25/.test(r.data.error) && /Nothing was saved/.test(r.data.error) && c1.e === c0.e && c1.h === c0.h,
  `cap: 18 live + 8 more refused whole, nothing saved (${cs.join(',')},${r.status})`, r.data.error);
r = await B({ name: capNm, rows: nine.slice(0, 7) }, W(capip));
ok(r.status === 200 && liveBy(capNm) === 25, `cap: 7 more fits exactly (25 live)`);
r = await call('POST', '/api/entries', { item_id: I0.id, name: capNm }, W(capip));
ok(r.status === 429 && /already have 25/.test(r.data.error), `cap: a single sign-up at 25 is refused (${r.status})`, r.data.error);
await toNextWindow(10);
const oneOfMine = dq(`SELECT id FROM entries WHERE deleted_at IS NULL AND name = '${capNm}' LIMIT 1`)[0].id;
ok((await call('DELETE', `/api/entries/${oneOfMine}`, {}, W(capip))).status === 200, 'cap: remove one of my sign-ups');
r = await call('POST', '/api/entries', { item_id: I0.id, name: capNm }, W(capip));
ok(r.status === 200 && liveBy(capNm) === 25, `cap: removing one frees a slot (${r.status})`);
// two batches at once can't slip past the cap together (checked inside each transaction)
await toNextWindow(10);
const parip = rnd(), parNm = 'Par ' + tag;
await B({ name: parNm, rows: nine }, W(parip)); await B({ name: parNm, rows: nine }, W(parip));
const pr = await Promise.all([B({ name: parNm, rows: nine.slice(0, 5) }, W(parip)), B({ name: parNm, rows: nine.slice(4, 9) }, W(parip))]);
ok(pr.map(x => x.status).sort().join() === '200,429' && liveBy(parNm) === 23, `cap: two parallel 5-row batches at 18 live -> one saved, one refused (${pr.map(x => x.status)}, live ${liveBy(parNm)})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
