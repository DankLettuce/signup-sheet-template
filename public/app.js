// Class sign-up front end (template): one tap per item, one sign-up per person. Event details, items, the
// "Add your own" position and the banner all come from the server (organizer-editable), nothing is hardcoded.
// All user text is rendered with textContent or input.value only. User data never goes into innerHTML.
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  let state = null, lastFocus = null, sheetGen = 0, sheetOnClose = null, lastError = null, sheetModal = false;
  const draft = { bringer: null, note: '' };   // confirm sheet text, kept in memory until a sign-up succeeds
  const L = { name: 60, note: 200, itemName: 60, setting: 60, countMax: 99, batchRows: 15, batchOthers: 8, maxItems: 40 };

  // ---------- this phone (localStorage; falls back to memory if storage is blocked) ----------
  const mem = {};
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); if (v !== null) return JSON.parse(v); } catch (_) {} return k in mem ? mem[k] : d; },
    set(k, v) { mem[k] = v; try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
  };
  const myName = () => { const n = store.get('hs-name', ''); return typeof n === 'string' ? n : ''; };   // prefilled on the confirm step
  const mineIds = () => { const a = store.get('hs-mine', []); return Array.isArray(a) ? a.filter(Number.isInteger) : []; };
  const addMine = ids => store.set('hs-mine', [...new Set([...mineIds(), ...ids])]);
  const dropMine = ids => store.set('hs-mine', mineIds().filter(x => !ids.includes(x)));
  const isOrg = () => store.get('hs-org', false) === true;                                             // Organizer mode, per phone
  const selected = new Set();   // item ids tapped "I'm bringing this"
  const expanded = new Set();   // covered items opened to show who

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function art(cls) { const s = el('span', cls); s.setAttribute('aria-hidden', 'true'); return s; }
  const isHelp = it => /helper/i.test(it.name);
  const filledOf = it => it.entries.length;                 // one sign-up = one person
  const covered = it => filledOf(it) >= it.needed;
  const lc = it => it.is_custom ? it.name : it.name.charAt(0).toLowerCase() + it.name.slice(1);
  const andList = a => a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' & ' + a[a.length - 1];
  const shortDate = d => { const m = String(d).match(/^([A-Za-z]+),?\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})/); return m ? `${m[1]}, ${m[2]} ${m[3]}` : d; };

  let toastTimer;
  // toast(msg, isError, action?) — action = { label, run } shows a button (e.g. Undo).
  function toast(msg, isError, action) {
    const t = $('#toast');
    t.replaceChildren(el('span', null, msg));
    if (action) {
      const b = el('button', 'toast-btn', action.label); b.type = 'button';
      b.addEventListener('click', () => { t.classList.remove('show'); action.run(); });
      t.append(b);
    }
    t.classList.toggle('error', !!isError); t.classList.toggle('has-action', !!action); t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), action ? 7000 : isError ? 6000 : 2800);
  }

  // ---------- network ----------
  // Writes run one at a time through a queue (never dropped). Each write has a request
  // id, so a retry after a lost response is not applied twice by the server. Network
  // failures retry with backoff; a short rate-limit wait (Retry-After) retries too.
  // A refresh (GET) never blocks a write, and a stale refresh never overwrites newer data.
  let writeSeq = 0, applied = 0, queue = Promise.resolve();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rid = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  function setBusy(on) { document.body.classList.toggle('busy', on); }

  async function refresh() {
    const seenAt = applied;
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (res.status === 401) { let d = null; try { d = await res.json(); } catch (_) {} if (d && d.gate) showGate(d.event_name); return null; }
      if (!res.ok) return null;
      const data = await res.json();
      if (applied !== seenAt) return null; // a write landed meanwhile; its result is newer
      setState(data); return data;
    } catch (_) { if (!state) toast('Could not load the list. Check your connection and pull to refresh.', true); return null; }
  }
  function setState(data) { state = data; if (data.limits) Object.assign(L, data.limits); render(); }

  function api(method, path, body) {
    if (method === 'GET') return refresh();
    const job = queue.then(() => send(method, path, body || {}));
    queue = job.catch(() => {});
    return job;
  }
  async function send(method, path, body) {
    const id = rid(), seq = ++writeSeq; setBusy(true);
    try {
      for (let attempt = 0; ; attempt++) {
        let res, data = null;
        try {
          res = await fetch('/api/' + path, { method, cache: 'no-store',
            headers: { 'Content-Type': 'application/json', 'X-Req-Id': id }, body: JSON.stringify(body) });
          try { data = await res.json(); } catch (_) {}
        } catch (_) { // offline / connection dropped
          if (attempt < 3) { if (attempt === 0) toast('Connection trouble — still trying to save…', true); await sleep(1000 * 2 ** attempt); continue; }
          toast('Could not save — no connection. Your typing is kept; please try again.', true); return null;
        }
        if (res.status === 429) {
          const wait = Number(res.headers.get('Retry-After') || 0);
          if (wait > 0 && wait <= 12 && attempt < 3) { await sleep(wait * 1000 + 300); continue; }
        }
        if (res.status >= 500 && attempt < 2) { await sleep(1000 * 2 ** attempt); continue; }
        if (res.status === 401 && data && data.gate) { lastError = { status: 401, data }; showGate(); return null; }
        if (!res.ok) { lastError = { status: res.status, data }; toast((data && data.error) || 'Something went wrong. Please try again.', true); return null; }
        lastError = null; applied = seq;
        if (data && Array.isArray(data.created)) addMine(data.created.map(c => c.id)); // this phone's sign-ups
        setState(data); return data;
      }
    } finally { if (seq === writeSeq) setBusy(false); }
  }

  // ---------- page ----------
  function pills(it) {
    const ul = el('ul', 'who');
    for (const e of it.entries) {
      const li = el('li'), b = el('button', 'pill' + (mineSet.has(e.id) ? ' is-mine' : ''));
      b.type = 'button';
      b.setAttribute('aria-label', `Edit or remove sign-up: ${e.name || 'Someone'}`);
      b.append(el('span', 'pill-name' + (e.name ? '' : ' anon'), e.name || 'Someone'));
      if (e.note) b.append(el('small', null, e.note));
      b.addEventListener('click', () => entrySheet(it, e));
      li.append(b); ul.append(li);
    }
    return ul;
  }
  function orgLinks(it, card) {
    if (!isOrg()) return;
    const o = el('div', 'org-row');
    const spots = el('button', 'mini-link', `Spots: ${it.needed}`); spots.type = 'button';
    spots.setAttribute('aria-label', `Change how many people for ${it.name}`);
    spots.addEventListener('click', () => itemSheet(it));
    const ed = el('button', 'mini-link', 'Rename / remove'); ed.type = 'button';
    ed.setAttribute('aria-label', `Rename or remove ${it.name}`);
    ed.addEventListener('click', () => itemSheet(it));
    o.append(spots, ed);
    const idx = state.items.indexOf(it), last = state.items.length - 1;   // state.items is in list order (sort, id)
    for (const [dir, sym, word] of [[-1, '↑', 'up'], [1, '↓', 'down']]) {
      const b = el('button', 'mini-link mv', sym); b.type = 'button'; b.dataset.move = word;
      b.setAttribute('aria-label', `Move ${it.name} ${word}`);
      b.disabled = dir < 0 ? idx <= 0 : idx >= last;
      b.addEventListener('click', async () => {
        b.disabled = true;
        if (await api('PUT', 'items/' + it.id, { move: dir })) { const n = document.querySelector(`[data-item="${it.id}"] [data-move="${word}"]`); if (n && !n.disabled) n.focus({ preventScroll: true }); }
        else b.disabled = false;
      });
      o.append(b);
    }
    card.append(o);
  }

  function renderItem(it) {
    const filled = filledOf(it), left = Math.max(0, it.needed - filled);
    if (covered(it)) { // one line; tap to show who (not selectable)
      const card = el('section', 'card covered'); card.dataset.item = it.id;
      const open = expanded.has(it.id);
      const b = el('button', 'cov-line'); b.type = 'button'; b.id = 'cov-' + it.id;
      b.setAttribute('aria-expanded', String(open));
      b.append(el('span', 'cov-name', it.name), el('span', 'cov-state', '— covered ✓'));
      b.addEventListener('click', () => { open ? expanded.delete(it.id) : expanded.add(it.id); render(); const n = document.getElementById(b.id); if (n) n.focus({ preventScroll: true }); });
      card.append(b);
      if (open && it.entries.length) card.append(pills(it));
      orgLinks(it, card);   // Organizer mode: controls show on covered items too (folded or not)
      return card;
    }
    const on = selected.has(it.id);
    const card = el('section', 'card pickable' + (on ? ' on' : '')); card.dataset.item = it.id;
    const t = el('button', 'toggle'); t.type = 'button'; t.id = 'tog-' + it.id;
    t.setAttribute('aria-pressed', String(on));
    const tx = el('span', 'tog-text');
    tx.append(el('span', 'tog-name', it.name), el('span', 'tog-slots', `${left} of ${it.needed} spot${it.needed === 1 ? '' : 's'} open`));
    tx.append(el('span', 'tog-state', on ? (isHelp(it) ? '✓ I’m helping' : '✓ I’m bringing this') : (isHelp(it) ? 'Tap to help' : 'Tap to bring this')));
    t.append(tx, art('tick'));
    t.addEventListener('click', () => { on ? selected.delete(it.id) : selected.add(it.id); render(); const n = document.getElementById(t.id); if (n) n.focus({ preventScroll: true }); });
    card.append(t);
    if (it.entries.length) card.append(pills(it));
    orgLinks(it, card);
    return card;
  }

  // Undo / Put back: the server re-checks the spots in the same transaction as the restore. If the item filled up
  // meanwhile it answers 409 'just got covered' (nothing restored); refresh so the list shows it covered.
  const restoreMsgs = new Map(); // 'e12' / 'i3' -> message shown under that Recently removed row
  async function restoreReq(path) {
    const d = await api('POST', path);
    if (!d && lastError && lastError.status === 409) { const msg = lastError.data.error; await refresh(); toast(msg, true); return { covered: msg }; }
    return d;
  }
  function renderRemoved() {
    const box = $('#removed'), ul = $('#removed-list');
    const items = state.removed_items || [], ents = state.removed || [];
    ul.replaceChildren();
    box.hidden = !items.length && !ents.length;
    $('#removed-count').textContent = items.length + ents.length ? ` (${items.length + ents.length})` : '';
    const add = (key, text, label, run) => {
      const li = el('li'); li.append(el('span', 'removed-text', text));
      const b = el('button', 'btn-text small', 'Put back'); b.type = 'button';
      b.setAttribute('aria-label', 'Put back: ' + label);
      b.addEventListener('click', async () => {
        b.disabled = true; b.textContent = 'Saving…';
        const r = await run();
        if (r && r.covered) { restoreMsgs.set(key, r.covered); render(); return; }
        if (r) restoreMsgs.delete(key); else { b.disabled = false; b.textContent = 'Put back'; }
      });
      li.append(b);
      if (restoreMsgs.has(key)) li.append(el('p', 'row-msg', restoreMsgs.get(key)));
      ul.append(li);
    };
    for (const r of items) {
      const n = r.entry_count;
      add('i' + r.id, `Item: ${r.name}${n ? ` (with ${n} sign-up${n > 1 ? 's' : ''})` : ''}`, r.name,
        async () => { const ok = await restoreReq(`items/${r.id}/restore`); if (ok && !ok.covered) toast('Item put back with its sign-ups.'); return ok; });
    }
    for (const r of ents) {
      const label = `${r.name || 'Someone'} — ${r.item_name}`;
      add('e' + r.id, label + (r.note ? ' (' + r.note + ')' : ''), label,
        async () => { const ok = await restoreReq(`entries/${r.id}/restore`); if (ok && !ok.covered) toast('Put back. Thanks!'); return ok; });
    }
  }

  let mineSet = new Set();
  function render() {
    if (!state) return;
    for (const id of [...selected]) { const it = state.items.find(i => i.id === id); if (!it || covered(it)) selected.delete(id); }
    const liveEntries = new Set(state.items.flatMap(i => i.entries.map(e => e.id)));
    const gone = mineIds().filter(id => !liveEntries.has(id));
    if (gone.length) dropMine(gone); // removed or no longer exists: drop it (Undo re-adds)
    mineSet = new Set(mineIds());
    const org = isOrg();
    document.body.classList.toggle('org', org);
    $('#org-bar').hidden = !org; $('#edit-when').hidden = !org;
    $('#org-toggle').setAttribute('aria-pressed', String(org)); $('#org-toggle').textContent = org ? 'Organizer mode: on' : 'Organizer';
    renderEvent(org);
    let f = 0, n = 0;
    for (const it of state.items) { n += it.needed; f += Math.min(filledOf(it), it.needed); }
    $('#overall-text').textContent = `${f} of ${n} spots filled`;
    $('#overall-bar').style.width = (n ? Math.round(f / n * 100) : 0) + '%';
    renderSummary();
    renderMine();
    // open items first; otherwise the server's stable order (sort, id). Organizer mode shows the true list order so ↑ ↓ make sense.
    const ordered = org ? state.items : [...state.items.filter(i => !covered(i)), ...state.items.filter(covered)];
    $('#list').replaceChildren(...ordered.map(renderItem));
    renderRemoved();
    updateBar();
  }

  // ---------- event details (header, title, intro, banner, contact, "Add your own" position) ----------
  // "Ms. Rivera’s 2nd Grade" / "Mr. Jones’ Class" / "2nd Grade" (any part may be blank)
  const classLabel = s => [s.teacher ? s.teacher + (/s$/i.test(s.teacher) ? '’' : '’s') : '', s.class_name].filter(Boolean).join(' ');
  function renderEvent(org) {
    const s = state.settings;
    const w = classLabel(s);
    $('#ev-who').textContent = w; $('#ev-who').hidden = !w;
    $('#ev-name').textContent = s.event_name || 'Sign-Up';
    $('#ev-school').textContent = s.school || ''; $('#ev-school').hidden = !s.school;
    document.title = `${s.event_name || 'Sign-Up'} Sign-Up${w ? ' · ' + w : ''}`;
    $('#party-date').textContent = s.party_date || 'TBD';
    $('#party-time').textContent = 'Time: ' + (s.party_time || 'TBD');
    $('#ev-intro').textContent = s.intro || ''; $('#ev-intro').hidden = !s.intro;
    const c = [s.organizer_name, s.organizer_contact].filter(Boolean);
    $('#ev-contact').textContent = c.length ? 'Questions? ' + c.join(' · ') : ''; $('#ev-contact').hidden = !c.length;
    setBanner(s.banner || 'animated');
    // "Add your own" goes after the list (and after the items already signed up) unless the organizer picked "top"
    const own = $('#own'), list = $('#list');
    if ((s.add_your_own || 'bottom') === 'top') { if (own.nextElementSibling !== list) list.before(own); }
    else if (list.nextElementSibling !== own) list.after(own);
    own.classList.toggle('own-bottom', s.add_your_own !== 'top');
    $('#org-code-state').textContent = state.code ? 'Class code: on (people need the code from your email).' : 'Class code: off (anyone with the link can open it).';
  }

  // ---------- class code (only when the site has one) ----------
  let gateShown = false;
  function showGate(eventName) {
    if (eventName) { $('#gate-event').textContent = eventName; document.title = eventName + ' Sign-Up'; }
    if (gateShown) return;
    gateShown = true; closeSheet();
    $('#main').hidden = true; $('#multibar').hidden = true; document.body.classList.remove('has-multibar');
    $('#gate').hidden = false; $('#gate-code').focus();
  }
  $('#gate-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const code = $('#gate-code').value.trim(), msg = $('#gate-msg'), go = $('#gate-go');
    if (!code) { msg.textContent = 'Please type the class code.'; $('#gate-code').focus(); return; }
    go.disabled = true; go.textContent = 'Checking…'; msg.textContent = '';
    try {
      const res = await fetch('/api/unlock', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      let d = null; try { d = await res.json(); } catch (_) {}
      if (res.ok) {
        gateShown = false; $('#gate').hidden = true; $('#main').hidden = false; $('#gate-code').value = '';
        await refresh(); return;
      }
      msg.textContent = (d && d.error) || 'That code didn’t work. Please try again.';
      $('#gate-code').select();
    } catch (_) { msg.textContent = 'No connection. Please try again.'; }
    finally { go.disabled = false; go.textContent = 'Open the sign-up'; }
  });

  // ---------- 'You're bringing …' line (only once this phone has signed up) ----------
  const myEntries = () => state.items.flatMap(it => it.entries.filter(e => mineSet.has(e.id)).map(e => ({ it, e })));
  function renderMine() {
    const mine = myEntries();
    $('#mine').hidden = !mine.length;
    $('#mine-text').textContent = mine.length ? `You’re bringing ${andList([...new Set(mine.map(x => lc(x.it)))])}` : '';
  }
  $('#mine-edit').addEventListener('click', () => {
    const mine = myEntries();
    openSheet({
      title: 'Your sign-ups',
      build: f => {
        const ul = el('ul', 'mine-list');
        for (const { it, e } of mine) {
          const li = el('li', 'mine-row');
          const t = el('span', 'mine-t'); t.append(el('b', null, it.name), document.createTextNode(' · ' + (e.name || 'Someone')));
          const b = el('button', 'btn-text small', 'Remove'); b.type = 'button';
          b.setAttribute('aria-label', 'Remove my sign-up for ' + it.name);
          let removed = false;
          b.addEventListener('click', async () => {
            b.disabled = true;
            if (!removed) {
              if (await api('DELETE', 'entries/' + e.id)) { removed = true; li.classList.add('gone'); b.textContent = 'Undo'; b.setAttribute('aria-label', 'Undo: put back ' + it.name); toast(`Removed ${it.name}.`); }
            } else {
              const r = await restoreReq(`entries/${e.id}/restore`);
              if (r && r.covered) { b.remove(); li.append(el('p', 'row-msg', r.covered)); return; }
              if (!r) { b.disabled = false; return; }
              removed = false; addMine([e.id]); render(); li.classList.remove('gone'); b.textContent = 'Remove'; b.setAttribute('aria-label', 'Remove my sign-up for ' + it.name); toast('Put back. Thanks!'); }
            b.disabled = false;
          });
          li.append(t, b); ul.append(li);
        }
        f.append(ul, el('p', 'help', 'Removing frees the spot for someone else. You can also tap any name on the list.'));
      },
      confirm: 'Done', onSubmit: async () => true, noCancel: true,
    });
  });

  // ---------- 'Add your own' (boxes; typing in the last one adds a blank one below; each filled box = one new item) ----------
  let ownSeq = 0;
  const ownInputs = () => [...document.querySelectorAll('#own-rows .own-input')];
  const clean = v => v.replace(/\s+/g, ' ').trim();
  const ownNames = () => { const seen = new Set(), out = [];   // filled boxes, in order; empty ones ignored, repeats once
    for (const i of ownInputs()) { const v = clean(i.value); if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); } }
    return out; };
  function ownRow() {
    const row = el('div', 'own-row'), n = ++ownSeq;
    const i = el('input', 'input own-input'); i.type = 'text'; i.maxLength = L.itemName; i.id = 'own-item-' + n; i.name = 'own-item-' + n;
    i.placeholder = ownSeq === 1 ? 'Something not on the list?' : 'Another one?';
    // no contact AutoFill / autocorrect over item names
    for (const [k, v] of [['autocomplete', 'off'], ['autocorrect', 'off'], ['autocapitalize', 'sentences'], ['spellcheck', 'false'], ['enterkeyhint', 'done']]) i.setAttribute(k, v);
    i.setAttribute('aria-label', 'Your own item');
    const x = el('button', 'own-x', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Remove this item'); x.hidden = true;
    x.addEventListener('click', () => { const all = ownInputs(), k = all.indexOf(i); row.remove(); syncOwn();
      const rest = ownInputs(); (rest[Math.min(k, rest.length - 1)] || rest[0]).focus({ preventScroll: true }); });
    i.addEventListener('input', () => syncOwn());
    i.addEventListener('blur', () => setTimeout(syncOwn, 0));
    row.append(i, x);
    return row;
  }
  // Keep exactly one blank box at the end (none at the cap); drop other blank boxes unless one is being typed in.
  function syncOwn() {
    const box = $('#own-rows');
    for (const i of ownInputs().slice(0, -1)) if (!clean(i.value) && document.activeElement !== i) i.closest('.own-row').remove();
    const ins = ownInputs(), filled = ins.filter(i => clean(i.value)).length;
    const last = ins[ins.length - 1];
    if ((!last || clean(last.value)) && filled < L.batchOthers) box.append(ownRow());
    for (const i of ownInputs()) i.nextSibling.hidden = !clean(i.value);
    if (!ownInputs().length) box.append(ownRow());
    updateBar(); ownInView();
  }
  function resetOwn() { $('#own-rows').replaceChildren(); ownSeq = 0; $('#own-rows').append(ownRow()); updateBar(); }
  resetOwn();
  $('label.own-label').addEventListener('click', e => { e.preventDefault(); const f = ownInputs()[0]; if (f) f.focus(); });

  // The sticky bar hides while a text field ON THE LIST has focus (it would float over the field above the iPhone keyboard),
  // and comes back shortly after focus leaves (the delay lets a tap on the bar land).
  let typingTimer = null;
  const listField = t => t && t.matches && t.matches('input[type=text], input:not([type]), textarea') && !t.closest('#sheet');
  document.addEventListener('focusin', e => { if (listField(e.target)) { clearTimeout(typingTimer); document.body.classList.add('typing'); } });
  document.addEventListener('focusout', e => { if (!listField(e.target)) return; clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { if (!listField(document.activeElement)) document.body.classList.remove('typing'); }, 150); });

  function updateBar() {
    const own = ownNames(), st = $('#own-state'), atCap = own.length >= L.batchOthers;
    $('#own').classList.toggle('on', own.length > 0);
    st.classList.toggle('cap', atCap);
    st.textContent = atCap ? `That’s ${L.batchOthers} new items, the max for one sign-up.`
      : own.length > 1 ? `✓ ${own.length} added. They go in with your sign-up.` : own.length ? '✓ Selected. It goes in with your sign-up.' : '';
    const n = selected.size + own.length, bar = $('#multibar');
    bar.hidden = n === 0; document.body.classList.toggle('has-multibar', n > 0);
    const go = $('#multi-go');
    if (!go.disabled) go.textContent = `${n} item${n === 1 ? '' : 's'} · Sign me up`;
  }
  $('#multi-clear').addEventListener('click', () => { selected.clear(); resetOwn(); render(); });
  $('#multi-go').addEventListener('click', () => confirmSheet());

  // ---------- confirm step: name (remembered) + 'Anything to add?' -> one batch ----------
  function confirmSheet() {
    const its = state.items.filter(i => selected.has(i.id)), own = ownNames().slice(0, L.batchOthers);
    const names = [...its.map(i => i.name), ...own];
    if (!names.length) return;
    if (names.length > L.batchRows) { toast(`Please pick at most ${L.batchRows} items at a time.`, true); return; }
    openSheet({
      title: names.length === 1 ? 'Who’s bringing this?' : 'Who’s bringing these?',
      build: f => {
        // The name box comes right under the title and is focused on open. Its visible label is "Your name (shown on the list)"
        // (template plan item 4). Its name/id avoid the word "name" and autocomplete is off, so iPhone Safari is less likely to
        // offer "AutoFill Contact" over it (check on a real iPhone).
        const who = textInput('bringer', draft.bringer !== null ? draft.bringer : myName(), L.name, 'e.g. Sam R.');
        who.id = 'f-bringer'; who.classList.add('who-input');
        const wl = el('label', 'f who-label', 'Your name (shown on the list)'); wl.htmlFor = 'f-bringer'; wl.id = 'who-label';
        who.setAttribute('autocomplete', 'off'); who.setAttribute('autocorrect', 'off'); who.setAttribute('autocapitalize', 'words');
        who.setAttribute('spellcheck', 'false'); who.setAttribute('enterkeyhint', 'done'); who.setAttribute('aria-labelledby', 'who-label');
        who.setAttribute('aria-describedby', 'who-help'); who.required = true;
        const help = el('div', 'help who-help', 'Other families see it next to what you’re bringing. Saved on this phone.'); help.id = 'who-help';
        const picks = el('p', 'picks');
        const edit = el('button', 'mini-link', 'Edit'); edit.type = 'button'; edit.id = 'picks-edit'; edit.setAttribute('aria-label', 'Edit your picks');
        edit.addEventListener('click', closeSheet);   // back to the list; the picks stay selected
        picks.append(el('span', 'picks-text', names.join(' · ')), edit);
        f.append(wl, who, help, picks);
        const note = textInput('note', draft.note, L.note, 'e.g. nut-free, or what time you can help', true);
        f.append(field('Anything to add?', true, note));
        f.addEventListener('input', () => { draft.bringer = who.value; draft.note = note.value; });
      },
      modal: true,   // an outside tap or Escape doesn't close it (only ✕ / Edit), so typed text isn't lost
      confirm: `I’ll bring ${names.length} item${names.length === 1 ? '' : 's'}`, noCancel: true,
      onSubmit: async f => {
        const name = f.elements.bringer.value.replace(/\s+/g, ' ').trim().slice(0, L.name);
        if (!name) { toast('Please type your name.', true); f.elements.bringer.focus(); return false; }
        store.set('hs-name', name);
        const data = await api('POST', 'batch', { name, note: f.elements.note.value, rows: its.map(i => ({ item_id: i.id })), others: own.map(name => ({ name })) });
        if (!data) {
          if (lastError && lastError.status === 409) { closeSheet(); await refresh(); toast(lastError.data.error, true); } // just got covered: list refreshed
          return false;
        }
        selected.clear(); resetOwn(); render(); draft.bringer = null; draft.note = '';
        setTimeout(() => thanks(name, names), 0);
        return true;
      },
    });
  }
  function thanks(name, names) {
    const href = '/api/calendar.ics?' + new URLSearchParams([['name', name], ...names.map(n => ['item', n])]).toString();
    openSheet({
      title: `Thanks, ${name}!`,
      build: f => {
        f.append(el('p', 'thanks-text', `You’re bringing ${andList(names)} on ${shortDate(state.settings.party_date)}.`));
        if (state.calendar) { // only when the party date is a real date (the .ics endpoint answers 422 otherwise)
          const a = el('a', 'btn btn-secondary cal', 'Add to calendar'); a.href = href; a.id = 'add-cal';
          f.append(a);
        }
      },
      confirm: 'Done', onSubmit: async () => true, noCancel: true,
    });
  }

  // Read-only 'Already signed up' digest: one line per item with sign-ups, names only.
  function renderSummary() {
    const box = $('#summary'), ul = $('#summary-list');
    const lines = [];
    for (const it of state.items) {
      if (!it.entries.length) continue;
      const li = el('li');
      li.append(el('span', 'sum-item', it.name + ':'), document.createTextNode(' '), el('span', 'sum-who', it.entries.map(e => e.name || 'Someone').join(', ')));
      lines.push(li);
    }
    ul.replaceChildren(...lines);
    box.hidden = !lines.length;
  }

  // ---------- Organizer mode (no password; this phone only) ----------
  const setOrg = on => { store.set('hs-org', on); render(); toast(on ? 'Organizer mode on: event details and items can be changed.' : 'Organizer mode off.'); };
  $('#org-toggle').addEventListener('click', () => setOrg(!isOrg()));
  $('#org-off').addEventListener('click', () => setOrg(false));

  // ---------- bottom sheet ----------
  function field(labelText, optional, control, help) {
    const wrap = el('div', 'field');
    const lab = el('label', 'f', labelText);
    if (optional) lab.append(' ', el('span', null, '(optional)'));
    control.id = 'f-' + control.name; lab.htmlFor = control.id;
    wrap.append(lab, control);
    if (help) wrap.append(el('div', 'help', help));
    return wrap;
  }
  function textInput(name, value, max, placeholder, multiline) {
    const i = el(multiline ? 'textarea' : 'input', 'input');
    i.name = name; i.value = value || ''; i.maxLength = max; if (placeholder) i.placeholder = placeholder;
    if (multiline) i.rows = 3; else i.type = 'text';
    return i;
  }
  function stepper(name, value, min, max, labelText) {
    const wrap = el('div', 'field');
    const lab = el('label', 'f', labelText);
    const box = el('div', 'stepper');
    const minus = el('button', null, '−'), plus = el('button', null, '+');
    minus.type = plus.type = 'button';
    minus.setAttribute('aria-label', 'Less'); plus.setAttribute('aria-label', 'More');
    const inp = el('input'); inp.name = name; inp.type = 'number'; inp.inputMode = 'numeric';
    inp.min = min; inp.max = max; inp.value = value; inp.id = 'f-' + name; lab.htmlFor = inp.id;
    const clamp = v => Math.max(min, Math.min(max, Number.isFinite(v) ? Math.round(v) : min));
    const set = v => { inp.value = clamp(v); inp.dispatchEvent(new Event('input', { bubbles: true })); sync(); };
    const sync = () => { const v = Number(inp.value); minus.disabled = v <= min; plus.disabled = v >= max; };
    minus.addEventListener('click', () => set(Number(inp.value) - 1));
    plus.addEventListener('click', () => set(Number(inp.value) + 1));
    inp.addEventListener('change', () => set(Number(inp.value)));
    sync();
    box.append(minus, inp, plus); wrap.append(lab, box);
    return wrap;
  }

  function openSheet({ title, icon, chip, build, confirm, onSubmit, danger, onClose, noCancel, modal }) {
    sheetModal = !!modal;
    if (sheetOnClose) { const f = sheetOnClose; sheetOnClose = null; f(); }
    sheetOnClose = onClose || null;
    lastFocus = document.activeElement;
    const gen = ++sheetGen;
    $('#sheet-title').textContent = title;
    const ico = $('#sheet-ico'); ico.hidden = !icon; if (icon) ico.dataset.icon = icon; else delete ico.dataset.icon;
    const form = $('#sheet-form'); form.replaceChildren();
    const scroll = el('div', 'sheet-scroll'); form.append(scroll);
    if (chip) { const cw = el('div'); cw.id = 'sheet-chip'; cw.append(chip); scroll.append(cw); }
    build(scroll);
    const ok = el('button', 'btn btn-primary confirm'); ok.type = 'submit';
    const setOk = () => { if (!ok.disabled && sheetGen === gen) ok.textContent = typeof confirm === 'function' ? confirm(form) : confirm; };
    setOk(); form.oninput = setOk;
    const cancel = el('button', 'btn btn-text', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', closeSheet);
    let d = null;
    // While a save runs: buttons disabled + "Saving…" so taps are never lost or doubled.
    const saving = async (btn, label, fn) => {
      if (ok.disabled) return;
      const prev = btn.textContent;
      ok.disabled = true; if (d) d.disabled = true; btn.textContent = label; btn.setAttribute('aria-busy', 'true');
      let done = false;
      try { done = await fn(); } finally {
        ok.disabled = false; if (d) d.disabled = false; btn.removeAttribute('aria-busy');
        btn.textContent = prev; setOk(); // buttons belong to this sheet only; setOk no-ops if another sheet opened
      }
      if (done && !$('#sheet').hidden && sheetGen === gen) closeSheet();
    };
    if (danger) {
      d = el('button', 'btn btn-danger', danger.text); d.type = 'button';
      d.addEventListener('click', () => saving(d, 'Removing…', danger.run));
      scroll.append(d);
    }
    const actions = el('div', 'sheet-actions'); actions.append(ok); if (!noCancel) actions.append(cancel); form.append(actions);
    form.onsubmit = ev => { ev.preventDefault(); saving(ok, 'Saving…', () => onSubmit(form)); };
    $('#scrim').hidden = false; $('#sheet').hidden = false;
    document.body.classList.add('sheet-open');
    fitSheet();
    // Focus in the same tap (not in a later frame), so iPhone Safari opens the keyboard.
    const first = form.querySelector('input, textarea'); if (first) first.focus({ preventScroll: true });
    requestAnimationFrame(() => { $('#sheet').classList.add('open'); });
  }
  function closeSheet() {
    if (sheetOnClose) { const f = sheetOnClose; sheetOnClose = null; f(); }
    $('#sheet').classList.remove('open'); $('#sheet').hidden = true; $('#scrim').hidden = true;
    document.body.classList.remove('sheet-open');
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  }
  $('#sheet-close').addEventListener('click', closeSheet);
  $('#scrim').addEventListener('click', () => { if (!sheetModal) closeSheet(); });
  document.addEventListener('keydown', e => {
    if ($('#sheet').hidden) return;
    if (e.key === 'Escape' && !sheetModal) closeSheet();
    if (e.key === 'Tab') { // keep focus inside the sheet
      const f = [...$('#sheet').querySelectorAll('button:not([disabled]), input, textarea, a[href]')];
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  });

  function entrySheet(it, entry) {
    openSheet({
      title: 'Edit sign-up for ' + it.name,
      build: f => {
        f.append(field('Your name (shown on the list)', true, textInput('name', entry.name, L.name, ''), 'Other families see it next to the item.'));
        f.append(field('Note', true, textInput('note', entry.note, L.note, 'e.g. nut-free, or what time you can help', true)));
      },
      confirm: 'Save changes',
      onSubmit: async f => {
        const ok = await api('PUT', 'entries/' + entry.id, { name: f.elements.name.value, note: f.elements.note.value });
        if (ok) toast('Updated. Thank you!');
        return !!ok;
      },
      danger: { text: 'Remove this sign-up', run: async () => {
        const ok = await api('DELETE', 'entries/' + entry.id);
        if (ok) toast('Sign-up removed.', false, { label: 'Undo', run: async () => {
          { const r = await restoreReq(`entries/${entry.id}/restore`); if (r && !r.covered) toast('Put back. Thanks!'); }
        } });
        return !!ok;
      } },
    });
  }

  function itemSheet(it) { // Organizer mode only
    openSheet({
      title: 'Edit ' + it.name,
      build: f => {
        f.append(field('Item name', false, textInput('iname', it.name, L.itemName, 'Item name')));
        f.append(stepper('needed', it.needed, 1, L.countMax, 'How many people?'));
      },
      confirm: 'Save',
      onSubmit: async f => {
        const body = { needed: Number(f.elements.needed.value) };
        if (f.elements.iname.value.replace(/\s+/g, ' ').trim() !== it.name) body.name = f.elements.iname.value;
        const ok = await api('PUT', 'items/' + it.id, body);
        if (ok) toast('Saved.');
        return !!ok;
      },
      danger: { text: 'Remove this item', run: async () => {
        if (!confirm(`Remove “${it.name}” and its sign-ups from the list?`)) return false;
        const ok = await api('DELETE', 'items/' + it.id);
        if (ok) toast('Item removed.', false, { label: 'Undo', run: async () => {
          { const r = await restoreReq(`items/${it.id}/restore`); if (r && !r.covered) toast('Item put back with its sign-ups.'); }
        } });
        return !!ok;
      } },
    });
  }

  // Organizer: all event details in one sheet (PUT settings {values}; unchanged fields are skipped by the server)
  const DETAILS = [
    ['event_name', 'Event name', 'e.g. Halloween Party'], ['teacher', 'Teacher', 'e.g. Ms. Rivera'], ['class_name', 'Class', 'e.g. 2nd Grade'],
    ['school', 'School', ''], ['party_date', 'Date', 'e.g. Friday, October 30, 2026'], ['party_time', 'Time', 'e.g. 1:30–3 PM'],
    ['intro', 'Message at the top', ''], ['organizer_name', 'Organizer name', ''], ['organizer_contact', 'Organizer email or phone', ''],
  ];
  function detailsSheet() {
    const s = state ? state.settings : {};
    const lim = (state && state.setting_limits) || {};
    openSheet({
      title: 'Event details',
      build: f => {
        for (const [k, label, ph] of DETAILS) {
          const tbd = k === 'party_date' || k === 'party_time';
          const v = s[k] === 'TBD' && tbd ? '' : (s[k] || '');
          const i = textInput('s_' + k, v, (lim[k] && lim[k].max) || (k === 'intro' ? 300 : k === 'organizer_contact' ? 100 : L.setting), ph, k === 'intro');
          i.setAttribute('autocomplete', 'off');
          f.append(field(label, k !== 'event_name', i, tbd ? 'Leave blank to show “TBD”.' : k === 'organizer_contact' ? 'Shown at the bottom of the page.' : undefined));
        }
        const pick = (name, label, opts, cur) => {
          const sel = el('select', 'input'); sel.name = name;
          for (const [v, t] of opts) { const o = el('option', null, t); o.value = v; o.selected = v === cur; sel.append(o); }
          f.append(field(label, false, sel));
        };
        pick('s_banner', 'Banner', [['animated', 'Moving picture'], ['still', 'Still picture'], ['none', 'No picture']], s.banner || 'animated');
        pick('s_add_your_own', '“Add your own” box', [['bottom', 'Below the list'], ['top', 'Above the list']], s.add_your_own || 'bottom');
      },
      confirm: 'Save',
      onSubmit: async f => {
        const values = {};
        for (const [k] of DETAILS) values[k] = f.elements['s_' + k].value;
        values.banner = f.elements.s_banner.value; values.add_your_own = f.elements.s_add_your_own.value;
        if (!values.event_name.trim()) { toast('Please type an event name.', true); f.elements.s_event_name.focus(); return false; }
        const ok = await api('PUT', 'settings', { values });
        if (ok) toast('Saved.');
        return !!ok;
      },
    });
  }
  $('#edit-when').addEventListener('click', detailsSheet);
  $('#org-details').addEventListener('click', detailsSheet);
  $('#org-add').addEventListener('click', () => {
    openSheet({
      title: 'Add an item',
      build: f => {
        const i = textInput('iname', '', L.itemName, 'e.g. Paper towels'); i.setAttribute('autocomplete', 'off');
        f.append(field('Item name', false, i), stepper('needed', 1, 1, L.countMax, 'How many people?'));
      },
      confirm: 'Add',
      onSubmit: async f => {
        if (!f.elements.iname.value.trim()) { toast('Please type an item name.', true); f.elements.iname.focus(); return false; }
        const ok = await api('POST', 'items', { name: f.elements.iname.value, needed: Number(f.elements.needed.value) });
        if (ok) toast('Item added at the end of the list.');
        return !!ok;
      },
    });
  });

  // Keep the sheet (and its button) above the on-screen keyboard: dock it to the VISUAL viewport. On iPhone the keyboard
  // shrinks visualViewport (and may scroll it), not the layout viewport that position: fixed uses, so the sheet's bottom
  // edge goes to visualViewport.offsetTop + height (--vvb) and its max-height to the visible height (--vvh); only the
  // fields scroll inside it.
  function fitSheet() {
    const vv = window.visualViewport; if (!vv) return;
    const sheet = $('#sheet'), root = document.documentElement;
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    sheet.style.setProperty('--vvb', Math.round(vv.offsetTop + vv.height) + 'px');
    sheet.style.setProperty('--vvh', Math.round(vv.height) + 'px');
    sheet.style.setProperty('--kb', kb + 'px');
    root.style.setProperty('--kb', kb + 'px'); // sticky multi-select bar
    root.classList.toggle('kb-open', kb > 80);
    const a = document.activeElement;   // keep the focused field in view inside the sheet's scroll area
    if (a && !sheet.hidden && a.closest('.sheet-scroll')) a.scrollIntoView({ block: 'nearest' });
    else ownInView();
  }
  // Typing in 'Add your own' with the keyboard up: scroll the page so the box and its "Selected" hint sit above the keyboard.
  function ownInView() {
    const vv = window.visualViewport, a = document.activeElement;
    if (!vv || !a || !a.closest || !a.closest('#own') || !$('#sheet').hidden) return;
    const st = $('#own-state'), r = a.getBoundingClientRect(), hint = st.textContent ? st.getBoundingClientRect() : r;
    const top = vv.offsetTop + 8, bottom = vv.offsetTop + vv.height - 20;   // the hint gets some room above the keyboard
    if (r.top < top) window.scrollBy(0, r.top - top);
    else if (hint.bottom > bottom) window.scrollBy(0, Math.min(hint.bottom - bottom, r.top - top));
  }
  if (window.visualViewport) {
    document.documentElement.classList.add('has-vv');
    window.visualViewport.addEventListener('resize', fitSheet); window.visualViewport.addEventListener('scroll', fitSheet); fitSheet();
  }

  // ---------- banner loop (decorative video over the still; index.html "BANNER") ----------
  // Event setting "banner": animated (default), still (never loads the video), none (no picture).
  let bannerMode = null, bannerStill = () => {}, bannerStart = () => {};
  function setBanner(mode) {
    if (mode === bannerMode) return;
    bannerMode = mode;
    const wrap = document.querySelector('.banner-wrap'); if (!wrap) return;
    wrap.hidden = mode === 'none';
    if (mode === 'animated') bannerStart(); else bannerStill();
  }
  // Sources are only filled in when motion is OK: never under prefers-reduced-motion or Save-Data. Any failure (load error,
  // blocked autoplay, e.g. iPhone Low Power Mode) falls back to the still, which is the box underneath, so nothing shifts.
  (() => {
    const wrap = document.querySelector('.banner-wrap'), v = wrap && wrap.querySelector('video.banner-video');
    if (!v) return;
    const srcs = [...v.querySelectorAll('source[data-src]')];
    const rm = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const saveData = () => !!(navigator.connection && navigator.connection.saveData);
    let on = false;
    const still = () => {
      on = false; wrap.classList.remove('is-playing'); wrap.classList.add('is-still');
      try { v.pause(); } catch (_) {}
      if (srcs.some(x => x.hasAttribute('src'))) { srcs.forEach(x => x.removeAttribute('src')); v.load(); }   // stop any download
    };
    const play = () => { const r = v.play(); if (r && r.catch) r.catch(() => { if (on) still(); }); };
    const start = () => {
      if ((rm && rm.matches) || saveData() || bannerMode !== 'animated') { still(); return; }
      on = true; wrap.classList.remove('is-still'); v.muted = true;
      srcs.forEach(x => x.setAttribute('src', x.dataset.src)); v.load(); play();
    };
    v.addEventListener('playing', () => { if (on) wrap.classList.add('is-playing'); });
    v.addEventListener('error', () => { if (on) still(); });
    if (srcs.length) srcs[srcs.length - 1].addEventListener('error', () => { if (on) still(); });   // every source failed
    document.addEventListener('visibilitychange', () => { if (!on) return; if (document.hidden) v.pause(); else play(); });
    if (rm) { const ch = () => (rm.matches ? still() : (!on && start())); rm.addEventListener ? rm.addEventListener('change', ch) : rm.addListener && rm.addListener(ch); }
    bannerStill = still; bannerStart = () => { if (!on) start(); };
    still();   // waits for the event settings (setBanner) before loading any video
  })();

  // Refresh when the tab comes back into view (other parents may have signed up).
  document.addEventListener('visibilitychange', () => { if (!document.hidden && $('#sheet').hidden) api('GET', 'state'); });
  api('GET', 'state');
})();
