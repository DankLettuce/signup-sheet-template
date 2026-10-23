// Phone-width browser check (390 x 844) with puppeteer-core + an installed Chrome. LOCAL server only; writes test data.
//   CLASS_CODE=BOO-123 ORGANIZER_PASSWORD=<same as the server> node scripts/ui-check.mjs [http://127.0.0.1:8788]
// Run it on its OWN fresh local database (it fills every item to check where "Add your own" sits).
// puppeteer-core is not a project dependency: `npm i --no-save puppeteer-core` (or set PPTR_DIR to a folder that has it).
// Chrome: CHROME=/path/to/chrome (default /usr/bin/google-chrome). Screenshots go to /tmp/ui-check-*.png.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const BASE = process.argv[2] || 'http://127.0.0.1:8788';
const CODE = process.env.CLASS_CODE || '';
const ORG_PW = process.env.ORGANIZER_PASSWORD || '';
if (!ORG_PW) { console.log('Run with ORGANIZER_PASSWORD=<same as the server>.'); process.exit(1); }
const CFG = JSON.parse(readFileSync(new URL('../site.config.json', import.meta.url), 'utf8'));
const req = createRequire(process.env.PPTR_DIR ? process.env.PPTR_DIR.replace(/\/?$/, '/') : import.meta.url);
const puppeteer = req('puppeteer-core');
let pass = 0, fail = 0;
const ok = (c, n, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x && !c ? '  -> ' + x : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const p = await browser.newPage();
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/401|403|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const vis = sel => p.$eval(sel, n => !n.closest('[hidden]') && n.getBoundingClientRect().height > 0).catch(() => false);
  const txt = sel => p.$eval(sel, n => n.textContent.trim()).catch(() => null);
  const shot = name => p.screenshot({ path: `/tmp/ui-check-${name}.png`, fullPage: false });
  const setField = async (sel, v) => { await p.waitForSelector('#sheet.open'); await sleep(250); await p.$eval(sel, (n, v) => { n.focus(); n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); }, v); };
  const tapConfirm = async () => { await p.waitForSelector('#sheet.open .confirm:not([disabled])'); await sleep(250); await p.$eval('#sheet .confirm', b => b.click()); };
  const noHScroll = () => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  await p.goto(BASE + '/', { waitUntil: 'networkidle0' });
  if (CODE) {
    await p.waitForSelector('#gate:not([hidden])', { timeout: 5000 });
    ok(await vis('#gate-code') && !(await vis('#list')), 'class code screen shows first; the list is hidden');
    ok(await txt('#gate-event') === CFG.event.event_name, 'class code screen shows the event name');
    ok(!(await p.content()).includes('Snacks/treats') || !(await vis('#list')), 'no items or names on the page before the code');
    await shot('1-gate');
    await p.type('#gate-code', 'WRONG-999'); await p.click('#gate-go');
    await p.waitForFunction(() => document.querySelector('#gate-msg').textContent.length > 0, { timeout: 5000 });
    ok(/didn’t work/.test(await txt('#gate-msg')) && await vis('#gate'), 'wrong code: refused with a message, still on the code screen');
    await shot('2-gate-wrong');
    await p.click('#gate-code', { clickCount: 3 }); await p.type('#gate-code', CODE.toLowerCase());
    await p.click('#gate-go');
    await p.waitForSelector('#gate[hidden]', { timeout: 5000 });
    ok(true, 'right code (typed in lower case): the sign-up opens');
    const ck = (await p.cookies()).find(c => c.name === 'signup_pass');
    ok(ck && ck.httpOnly && ck.sameSite === 'Lax', 'pass cookie is HttpOnly + SameSite=Lax');
    await p.reload({ waitUntil: 'networkidle0' });
    ok(!(await vis('#gate')) && await vis('#list'), 'after a reload the code is not asked again (cookie)');
  }
  await p.waitForSelector('#list .card');
  ok(await txt('#ev-name') === CFG.event.event_name, 'header: event name from the settings');
  ok((await txt('#ev-who')).includes(CFG.event.teacher) && (await txt('#ev-who')).includes(CFG.event.class_name), 'header: teacher + class');
  ok(await txt('#ev-school') === CFG.event.school && await txt('#party-date') === CFG.event.party_date, 'header: school + date');
  ok((await p.title()).startsWith(CFG.event.event_name), 'page title from the settings');
  ok((await txt('#ev-contact')).includes(CFG.organizer.name), 'organizer contact in the footer');
  // "Add your own" sits between the open items and the claimed (covered) ones: at the bottom when nothing is claimed,
  // moving up as items fill. Checked on screen positions at 390 px with 0, some and all items claimed.
  const placement = () => p.evaluate(() => {
    const L = document.querySelector('#list'), O = document.querySelector('#own'), C = document.querySelector('#list-covered');
    const vis = n => !n.closest('[hidden]') && n.getBoundingClientRect().height > 0, r = n => n.getBoundingClientRect();
    return { open: L.querySelectorAll('.card').length, covered: C.querySelectorAll('.card').length, listVis: vis(L), covVis: vis(C), ownVis: vis(O),
      afterOpen: !vis(L) || r(O).top >= r(L).bottom - 1, beforeCovered: !vis(C) || r(O).bottom <= r(C).top + 1 };
  });
  const ownShot = async name => { await p.$eval('#own', n => n.scrollIntoView({ block: 'center' })); await sleep(200); await shot(name); await p.evaluate(() => window.scrollTo(0, 0)); };
  let pl = await placement();
  ok(pl.ownVis && pl.open === CFG.items.length && pl.covered === 0 && !pl.covVis && pl.afterOpen, '0 claimed: "Add your own" is at the bottom, below every item', JSON.stringify(pl));
  await ownShot('3a-own-0-claimed');
  ok(await noHScroll(), 'no sideways scrolling at 390 px');
  await shot('3-list');

  // sign up for the first open item
  const first = await p.$('#list .card.pickable .toggle');
  const itemName = await first.$eval('.tog-name', n => n.textContent);
  await first.click();
  await p.waitForSelector('#multibar:not([hidden])');
  await p.click('#multi-go');
  await p.waitForSelector('#sheet:not([hidden]) #f-bringer');
  ok(await txt('#who-label') === 'Your name (shown on the list)', 'name box label: "Your name (shown on the list)"');
  ok(await p.$eval('#f-bringer', n => n.getAttribute('autocomplete') === 'off' && !/name/i.test(n.name + n.id)), 'name box: autocomplete off, no "name" in its id/name');
  const whoAttrs = sel => p.$eval(sel, n => JSON.stringify(['autocomplete', 'autocorrect', 'autocapitalize', 'spellcheck'].map(a => n.getAttribute(a)).concat(n.required)));
  const signupAttrs = await whoAttrs('#f-bringer');
  await sleep(500); await shot('4-confirm');
  await p.type('#f-bringer', 'Casey Example');
  await tapConfirm();
  await p.waitForFunction(() => /Thanks, Casey Example/.test(document.querySelector('#sheet-title').textContent), { timeout: 8000 });
  ok(true, 'sign-up saved; thank-you sheet shown');
  await tapConfirm(); await sleep(300);
  ok((await txt('#summary-list')).includes('Casey Example') && (await txt('#summary-list')).includes(itemName), '"Already signed up" shows the new sign-up');

  // Edit sheet (QA round 1 items 3, 8, 9): same name box as sign-up, name required, toast never over the Save button
  await p.$$eval('button[aria-label^="Edit or remove sign-up"]', bs => bs.find(b => /Casey Example/.test(b.getAttribute('aria-label'))).click());
  await p.waitForSelector('#sheet:not([hidden]) #f-bringer-edit');
  ok(await whoAttrs('#f-bringer-edit') === signupAttrs && await p.$eval('#f-bringer-edit', n => !/name/i.test(n.name + n.id)),
    `edit sheet name box: same autocomplete/autocorrect/autocapitalize/spellcheck/required as the sign-up box, no "name" in its id/name (${signupAttrs})`);
  ok(!(await p.$eval('label[for="f-bringer-edit"]', l => l.textContent)).includes('optional'), 'edit sheet: the name is not marked optional');
  await setField('#f-bringer-edit', '   ');
  await tapConfirm(); await sleep(450);
  const overlap = () => p.evaluate(() => {
    const t = document.querySelector('#toast').getBoundingClientRect(), b = document.querySelector('#sheet .confirm').getBoundingClientRect();
    return { shown: document.querySelector('#toast').classList.contains('show'), text: document.querySelector('#toast').textContent, hit: !(t.bottom <= b.top || t.top >= b.bottom || t.right <= b.left || t.left >= b.right), inView: t.top >= 0 && t.bottom <= window.innerHeight };
  });
  const o1 = await overlap();
  ok(o1.shown && /type your name/.test(o1.text) && !(await p.$eval('#sheet', n => n.hidden)), 'edit sheet: a blank name is refused ("Please type your name."), sheet stays open', JSON.stringify(o1));
  ok(o1.shown && !o1.hit && o1.inView, 'toast does not cover the sheet\'s Save button (and is on screen)', JSON.stringify(o1));
  await shot('4b-edit-toast');
  await setField('#f-bringer-edit', 'Casey Example');
  await tapConfirm();
  await p.waitForSelector('#sheet[hidden]', { timeout: 5000 });
  ok((await txt('#summary-list')).includes('Casey Example'), 'edit sheet: saving with the name works');

  // Fill items through the API (each sign-up from its own made-up IP, like different parents), then reload.
  const fill = ids => p.evaluate(async ids => {
    const st = await (await fetch('/api/state')).json(), out = [];
    for (const it of st.items.filter(i => ids === 'all' || ids.includes(i.id))) {
      for (let k = it.entries.length; k < it.needed; k++) {
        const ip = `10.77.${Math.random() * 255 | 0}.${Math.random() * 255 | 0}`;
        out.push((await fetch('/api/entries', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify({ item_id: it.id, name: `Filler Parent ${it.id}-${k}` }) })).status);
      }
    }
    return out;
  }, ids);
  const ids = await p.evaluate(async () => (await (await fetch('/api/state')).json()).items.filter(i => i.needed === 1).map(i => i.id));
  let fs = await fill(ids.slice(0, 2));
  await p.reload({ waitUntil: 'networkidle0' }); await p.waitForSelector('#own');
  pl = await placement();
  ok(fs.every(x => x === 200) && pl.open === CFG.items.length - 2 && pl.covered === 2 && pl.listVis && pl.covVis && pl.afterOpen && pl.beforeCovered, 'some claimed: "Add your own" sits between the open items and the claimed ones', JSON.stringify({ fs, pl }));
  ok(await noHScroll(), 'some claimed: no sideways scrolling at 390 px');
  await ownShot('3b-own-some-claimed');
  fs = await fill('all');
  await p.reload({ waitUntil: 'networkidle0' }); await p.waitForSelector('#own');
  pl = await placement();
  ok(fs.every(x => x === 200) && pl.open === 0 && !pl.listVis && pl.covered === CFG.items.length && pl.ownVis && pl.beforeCovered, 'all claimed: "Add your own" is at the top, above every claimed item (empty open list hidden)', JSON.stringify({ fs, pl }));
  ok(await noHScroll(), 'all claimed: no sideways scrolling at 390 px');
  await ownShot('3c-own-all-claimed');

  // Organizer page: needs the organizer password (the class code is not enough)
  ok(await p.evaluate(async () => (await fetch('/api/export.csv')).status) === 401, 'with only the class code, the backup download is refused (401)');
  await p.click('#org-toggle');
  await p.waitForSelector('#sheet:not([hidden]) input[type="password"]');
  ok(!(await vis('#org-bar')) && await p.$eval('#sheet input[type="password"]', n => n.getAttribute('autocomplete') === 'current-password'), 'Organizer: a password prompt shows first (organizer page still hidden)');
  await sleep(500); await shot('5a-org-password');
  await setField('#sheet input[type="password"]', 'not-the-password'); await tapConfirm();
  await p.waitForFunction(() => document.querySelector('#toast').classList.contains('show') && /didn’t work/.test(document.querySelector('#toast').textContent), { timeout: 5000 });
  ok(!(await vis('#org-bar')) && !(await p.$eval('#sheet', n => n.hidden)), 'Organizer: wrong password refused, organizer page still hidden');
  await setField('#sheet input[type="password"]', ORG_PW); await tapConfirm();
  await p.waitForSelector('#sheet[hidden]', { timeout: 5000 });
  const oc = (await p.cookies()).find(c => c.name === 'signup_org');
  ok(oc && oc.httpOnly && oc.sameSite === 'Strict', 'Organizer: right password -> organizer cookie (HttpOnly, SameSite=Strict)');
  await sleep(200);
  ok(await vis('#org-bar') && await vis('#org-details') && await vis('#org-add') && await vis('#org-backup') && !(await p.$('#org-copy')), 'Organizer page: Event details, Add an item, Back up the list (no Copy this event)');
  ok(/Class code: (on|off)/.test(await txt('#org-code-state')) && (await txt('#org-code-state')).includes(CODE ? 'on' : 'off'), 'Organizer page says whether the class code is on');
  const names = () => p.$$eval('#list .card', cs => cs.map(c => (c.querySelector('.tog-name, .cov-name') || {}).textContent));
  const n0 = await names();
  ok(n0.join('|') === CFG.items.map(i => i.name).join('|'), 'Organizer mode lists items in their true order (covered ones not moved to the end)');
  const rows = await p.$$eval('#list .card .org-row', rs => rs.map(r => [...r.querySelectorAll('button')].map(b => b.textContent.trim())));
  ok(rows.length === n0.length && rows.every(r => r.some(t => t.startsWith('Spots')) && r.includes('Rename / remove') && r.includes('↑') && r.includes('↓')), 'every item has Spots, Rename / remove, ↑, ↓');
  await p.$eval('#list .card:nth-child(2) [data-move="up"]', b => b.click());
  await p.waitForFunction(n => document.querySelector('#list .card .tog-name, #list .card .cov-name').textContent === n, { timeout: 5000 }, n0[1]).catch(() => {});
  ok((await names())[0] === n0[1], '↑ moves an item up', await txt('#toast'));
  await p.$eval('#list .card:nth-child(1) [data-move="down"]', b => b.click());
  await p.waitForFunction(n => document.querySelector('#list .card .tog-name, #list .card .cov-name').textContent === n, { timeout: 5000 }, n0[0]);
  ok((await names()).join('|') === n0.join('|'), '↓ moves it back');
  await shot('5-organizer');

  // Event details sheet
  await p.click('#org-details');
  await p.waitForSelector('#sheet:not([hidden]) #f-s_event_name');
  const fields = await p.$$eval('#sheet-form [name^="s_"]', ns => ns.map(n => n.name));
  ok(['event_name', 'teacher', 'class_name', 'school', 'party_date', 'party_time', 'intro', 'organizer_name', 'organizer_contact', 'banner'].every(k => fields.includes('s_' + k)), 'Event details: every field editable (date, time, teacher, class, banner, …)');
  await sleep(500); await shot('6-details');
  await setField('#f-s_party_time', '1:30–3 PM');
  await p.select('#f-s_banner', 'none');
  await tapConfirm();
  await p.waitForSelector('#sheet[hidden]', { timeout: 5000 });
  ok(await txt('#party-time') === 'Time: 1:30–3 PM' && !(await vis('.banner-wrap')), 'saved: new time shows, banner "No picture" hides the banner');
  await p.click('#org-details'); await p.waitForSelector('#sheet:not([hidden]) #f-s_party_time');
  await setField('#f-s_party_time', '');
  await p.select('#f-s_banner', CFG.event.banner);
  await tapConfirm(); await p.waitForSelector('#sheet[hidden]');
  ok(await txt('#party-time') === 'Time: TBD' && await vis('.banner-wrap'), 'put back: time TBD, banner shown again');

  // Add an item
  await p.click('#org-add'); await p.waitForSelector('#sheet:not([hidden]) #f-iname');
  await setField('#f-iname', 'Paper towels'); await tapConfirm(); await p.waitForSelector('#sheet[hidden]');
  ok((await names()).at(-1) === 'Paper towels', 'Add an item: new item at the end');
  // Backup + copy links answer with files
  const dl = await p.evaluate(async () => Promise.all(['/api/export.csv', '/api/export.json'].map(async u => { const r = await fetch(u); return [r.status, r.headers.get('content-disposition')]; })));
  ok(dl.every(([s, d]) => s === 200 && /attachment/.test(d || '')), 'Back up the list / Full backup file download files', JSON.stringify(dl));
  // remove the test item again (Rename / remove sheet)
  await p.$$eval('#list .card', cs => { const c = cs.find(x => (x.querySelector('.tog-name, .cov-name') || {}).textContent === 'Paper towels'); c.querySelector('.org-row button:nth-child(2)').click(); });
  await p.waitForSelector('#sheet:not([hidden]) .btn-danger');
  p.once('dialog', d => d.accept());
  await sleep(300); await p.$eval('#sheet .btn-danger', b => b.click()); await p.waitForSelector('#sheet[hidden]');
  ok(!(await names()).includes('Paper towels'), 'Rename / remove: item removed');
  await p.$eval('#org-off', b => b.click()); await sleep(600);
  ok(!(await vis('#org-bar')) && !(await p.cookies()).some(c => c.name === 'signup_org'), 'Organizer mode off (organizer cookie cleared)');
  ok(await p.evaluate(async () => (await fetch('/api/export.csv')).status) === 401, 'after turning it off, organizer actions are refused again');
  ok(await noHScroll(), 'still no sideways scrolling');
  ok(!errors.length, 'no page errors', errors.join(' | '));
} finally { await browser.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
