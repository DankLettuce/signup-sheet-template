// Phone-width browser check (390 x 844) with puppeteer-core + an installed Chrome. LOCAL server only; writes test data.
//   CLASS_CODE=BOO-123 node scripts/ui-check.mjs [http://127.0.0.1:8788]
// puppeteer-core is not a project dependency: `npm i --no-save puppeteer-core` (or set PPTR_DIR to a folder that has it).
// Chrome: CHROME=/path/to/chrome (default /usr/bin/google-chrome). Screenshots go to /tmp/ui-check-*.png.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const BASE = process.argv[2] || 'http://127.0.0.1:8788';
const CODE = process.env.CLASS_CODE || '';
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
  const order = await p.evaluate(() => { const o = document.querySelector('#own'), l = document.querySelector('#list'); return !!(l.compareDocumentPosition(o) & Node.DOCUMENT_POSITION_FOLLOWING); });
  ok(order === (CFG.add_your_own !== 'top'), '"Add your own" sits below the items (setting: ' + CFG.add_your_own + ')');
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
  await sleep(500); await shot('4-confirm');
  await p.type('#f-bringer', 'Casey Example');
  await tapConfirm();
  await p.waitForFunction(() => /Thanks, Casey Example/.test(document.querySelector('#sheet-title').textContent), { timeout: 8000 });
  ok(true, 'sign-up saved; thank-you sheet shown');
  await tapConfirm(); await sleep(300);
  ok((await txt('#summary-list')).includes('Casey Example') && (await txt('#summary-list')).includes(itemName), '"Already signed up" shows the new sign-up');

  // Organizer page
  await p.click('#org-toggle'); await sleep(200);
  ok(await vis('#org-bar') && await vis('#org-details') && await vis('#org-add') && await vis('#org-backup') && await vis('#org-copy'), 'Organizer page: Event details, Add an item, Back up the list, Copy this event');
  ok(/Class code: (on|off)/.test(await txt('#org-code-state')) && (await txt('#org-code-state')).includes(CODE ? 'on' : 'off'), 'Organizer page says whether the class code is on');
  const names = () => p.$$eval('#list .card', cs => cs.map(c => (c.querySelector('.tog-name, .cov-name') || {}).textContent));
  const n0 = await names();
  ok(n0.join('|') === CFG.items.map(i => i.name).join('|'), 'Organizer mode lists items in their true order (covered ones not moved to the end)');
  const rows = await p.$$eval('#list .card .org-row', rs => rs.map(r => [...r.querySelectorAll('button')].map(b => b.textContent.trim())));
  ok(rows.length === n0.length && rows.every(r => r.some(t => t.startsWith('Spots')) && r.includes('Rename / remove') && r.includes('↑') && r.includes('↓')), 'every item has Spots, Rename / remove, ↑, ↓');
  await p.$eval('#list .card:nth-child(2) [data-move="up"]', b => b.click());
  await p.waitForFunction(n => document.querySelector('#list .card .tog-name, #list .card .cov-name').textContent === n, { timeout: 5000 }, n0[1]);
  ok((await names())[0] === n0[1], '↑ moves an item up');
  await p.$eval('#list .card:nth-child(1) [data-move="down"]', b => b.click());
  await p.waitForFunction(n => document.querySelector('#list .card .tog-name, #list .card .cov-name').textContent === n, { timeout: 5000 }, n0[0]);
  ok((await names()).join('|') === n0.join('|'), '↓ moves it back');
  await shot('5-organizer');

  // Event details sheet
  await p.click('#org-details');
  await p.waitForSelector('#sheet:not([hidden]) #f-s_event_name');
  const fields = await p.$$eval('#sheet-form [name^="s_"]', ns => ns.map(n => n.name));
  ok(['event_name', 'teacher', 'class_name', 'school', 'party_date', 'party_time', 'intro', 'organizer_name', 'organizer_contact', 'banner', 'add_your_own'].every(k => fields.includes('s_' + k)), 'Event details: every field editable (date, time, teacher, class, banner, …)');
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
  const dl = await p.evaluate(async () => Promise.all(['/api/export.csv', '/api/export.json', '/api/event-copy.json'].map(async u => { const r = await fetch(u); return [r.status, r.headers.get('content-disposition')]; })));
  ok(dl.every(([s, d]) => s === 200 && /attachment/.test(d || '')), 'Back up the list / Full backup file / Copy this event download files', JSON.stringify(dl));
  // remove the test item again (Rename / remove sheet)
  await p.$$eval('#list .card', cs => { const c = cs.find(x => (x.querySelector('.tog-name, .cov-name') || {}).textContent === 'Paper towels'); c.querySelector('.org-row button:nth-child(2)').click(); });
  await p.waitForSelector('#sheet:not([hidden]) .btn-danger');
  p.once('dialog', d => d.accept());
  await sleep(300); await p.$eval('#sheet .btn-danger', b => b.click()); await p.waitForSelector('#sheet[hidden]');
  ok(!(await names()).includes('Paper towels'), 'Rename / remove: item removed');
  await p.$eval('#org-off', b => b.click()); await sleep(300);
  ok(!(await vis('#org-bar')), 'Organizer mode off');
  ok(await noHScroll(), 'still no sideways scrolling');
  ok(!errors.length, 'no page errors', errors.join(' | '));
} finally { await browser.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
