// Phone (390x844, mobile, touch, hover:none) interaction probes on the bo:shots harness.
import { launch, serve, MEASURE } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
const OUT = process.env.OUT; mkdirSync(OUT, { recursive: true });
const server = await serve(); const port = server.address().port;
const b = await launch();
const R = {};
const log = (k, v) => { R[k] = v; console.log(k, JSON.stringify(v)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Recording stub layered over the fixture client: every request is logged;
// writes and the reads the composer/offer/booking need get demo answers.
const STUB = `(() => {
  window.__req = [];
  const c = window.__client; const orig = c.request.bind(c);
  c.request = async (path, options = {}) => {
    const method = String(options.method ?? 'GET').toUpperCase();
    const body = options.body == null ? null : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    const entry = { method, path, body: body ? body.slice(0, 400) : null }; window.__req.push(entry);
    let answer;
    if (path.startsWith('/api/connectors')) answer = { connectors: [{ channel: 'email', status: 'active', connectionKey: 'gmail-1', account: 'studio@palestra-esempio.it' }, { channel: 'whatsapp', status: 'active', connectionKey: 'wa-1', account: '+390000000000' }] };
    else if (path === '/api/profile') answer = { profile: {} };
    else if (path.startsWith('/api/catalog/products')) answer = { products: [{ sku: 'taglio', name: 'Taglio', priceCents: 2500, currency: 'EUR', active: true }] };
    else if (path === '/api/customer-hub/messages' && method === 'POST') answer = { channel: 'email', to: 'demo@example.test', jobId: 'job-1' };
    else if (path === '/api/opportunities' && method === 'POST') answer = { opportunity: { id: 'opp-new', title: 'Offerta demo', status: 'open' }, id: 'opp-new' };
    else if (path === '/api/appointments/confirm') { const claim = JSON.parse(body || '{}'); answer = { decision: 'booked', appointment: { id: 'appt-new', ...claim } }; }
    else if (path === '/api/appointments/propose') answer = { decision: 'draft' };
    if (answer !== undefined) { entry.answer = JSON.stringify(answer).slice(0, 200); return answer; }
    try { const a = await orig(path, options); entry.answer = 'fixture'; return a; } catch (e) { entry.error = String(e.message || e); throw e; }
  };
  return true;
})()`;

const textBtn = (label, scope = 'document') => `[...${scope}.querySelectorAll('button, a, [role=button], label')].find((n) => n.offsetParent !== null && n.textContent.trim().startsWith(${JSON.stringify(label)}))`;

async function open(name) {
  await b.viewport(390, 844, true);
  await b.goto(`http://127.0.0.1:${port}/m-${name}.html`, `${name}-ready`);
  await sleep(300);
  await b.eval(STUB);
}

try {
  // ---------- 4419cc25e2df: compact bar + menu at 390 ----------
  for (const name of ['oggi', 'clienti', 'cliente', 'calendario']) {
    await open(name);
    const m = await b.eval(MEASURE);
    log(`4419:${name}:bar`, { vw: m.vw, topbarH: m.topbar?.h, contentTop: m.contentTop, crumb: m.crumb?.text, crumbVisible: m.crumb?.inViewport && !m.crumb?.truncated, toggle: m.menuToggle, sidebarShownWhenClosed: m.sidebarVisibleInViewport });
  }
  await open('oggi');
  await b.shot(`${OUT}/4419-oggi-390-menu-chiuso.png`);
  const t1 = await b.tap(`document.querySelector('.bo-menu-toggle')`);
  let st = await b.eval(`({ expanded: document.querySelector('.bo-menu-toggle').getAttribute('aria-expanded'), drawer: document.querySelector('.bo-sidebar').classList.contains('bo-drawer-open'), role: document.querySelector('.bo-sidebar').getAttribute('role'), inView: (() => { const r = document.querySelector('.bo-sidebar').getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; })(), active: (document.querySelector('.bo-sidebar .bo-nav-item.active') || {}).textContent || null, focus: document.activeElement && document.activeElement.closest('.bo-sidebar') ? 'inside-drawer' : (document.activeElement || {}).className })`);
  log('4419:tap-open', { tapTarget: { w: t1.w, h: t1.h, hit: t1.hit }, ...st });
  await sleep(400);
  await b.shot(`${OUT}/4419-oggi-390-menu-aperto.png`);
  // tap the toggle again: is it still reachable above the drawer?
  const reach = await b.eval(`(() => { const t = document.querySelector('.bo-menu-toggle'); const r = t.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { toggleOnTop: hit === t || t.contains(hit), hitIs: hit ? hit.className : null }; })()`);
  log('4419:toggle-reachable-when-open', reach);
  if (reach.toggleOnTop) {
    await b.tap(`document.querySelector('.bo-menu-toggle')`);
  } else {
    // tap the backdrop area to the right of the drawer
    await b.s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 380, y: 700 }] });
    await b.s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(300);
  }
  st = await b.eval(`({ expanded: document.querySelector('.bo-menu-toggle').getAttribute('aria-expanded'), drawer: document.querySelector('.bo-sidebar').classList.contains('bo-drawer-open') })`);
  log('4419:tap-close', st);
  // keyboard: focus toggle, Enter opens, Esc closes and refocuses toggle
  await b.eval(`(document.querySelector('.bo-menu-toggle').focus(), true)`);
  await b.key('Enter', 'Enter', 13);
  st = await b.eval(`({ expanded: document.querySelector('.bo-menu-toggle').getAttribute('aria-expanded'), drawer: document.querySelector('.bo-sidebar').classList.contains('bo-drawer-open'), focusInDrawer: !!(document.activeElement && document.activeElement.closest('.bo-sidebar')) })`);
  log('4419:enter-open', st);
  await b.key('Escape', 'Escape', 27);
  st = await b.eval(`({ expanded: document.querySelector('.bo-menu-toggle').getAttribute('aria-expanded'), drawer: document.querySelector('.bo-sidebar').classList.contains('bo-drawer-open'), focusOnToggle: document.activeElement === document.querySelector('.bo-menu-toggle') })`);
  log('4419:esc-close', st);

  // ---------- d7c78e9cdf53: scheda message, offer; calendar booking by tap ----------
  await open('cliente');
  await b.tap(textBtn('Scrivi'));
  await sleep(800);
  let comp = await b.eval(`(() => { const p = document.querySelector('.bo-scheda-composer'); if (!p) return null; const r = p.getBoundingClientRect(); const f = [...p.querySelectorAll('textarea, input:not([type=radio]):not([type=checkbox])')].filter(n => n.getClientRects().length > 0); return { box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], fields: f.map(n => (n.name || n.tagName) + ':' + getComputedStyle(n).fontSize), overflow: document.documentElement.scrollWidth - innerWidth, vw: innerWidth, sendText: ([...p.querySelectorAll('button.primary')].map(x => x.textContent)) }; })()`);
  log('d7c78:composer-open', comp);
  await b.shot(`${OUT}/d7c78-scheda-390-composer.png`);
  await b.tap(`document.querySelector('.bo-scheda-composer textarea')`);
  await b.type('Ciao, ti confermo la prova di giovedì.');
  await sleep(200);
  await b.tap(`[...document.querySelectorAll('.bo-scheda-composer button.primary')].find(n => n.textContent.startsWith('Invia'))`);
  await sleep(1200);
  let reqs = await b.eval(`window.__req.filter(r => r.method !== 'GET')`);
  const toast = await b.eval(`[...document.querySelectorAll('[role=status], .toast, .bo-toast')].map(n => n.textContent.trim()).filter(Boolean).slice(0,3)`);
  log('d7c78:message-sent', { writes: reqs, toast });
  await b.shot(`${OUT}/d7c78-scheda-390-dopo-invio.png`);

  await open('cliente');
  await b.tap(textBtn('Nuova offerta'));
  await sleep(800);
  comp = await b.eval(`(() => { const p = [...document.querySelectorAll('[aria-label="Nuova offerta"]')].find(n => n.getClientRects().length > 0); if (!p) return null; const r = p.getBoundingClientRect(); const f = [...p.querySelectorAll('textarea, input:not([type=radio]):not([type=checkbox]), select')].filter(n => n.getClientRects().length > 0); return { box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], fields: f.map(n => (n.name || n.getAttribute('aria-label') || n.tagName) + ':' + getComputedStyle(n).fontSize), overflow: document.documentElement.scrollWidth - innerWidth, vw: innerWidth, buttons: [...p.querySelectorAll('button')].map(x => x.textContent.trim()).filter(Boolean) }; })()`);
  log('d7c78:offer-open', comp);
  await b.shot(`${OUT}/d7c78-scheda-390-offerta.png`);
  // fill title and value by touch + typing
  const fillers = await b.eval(`(() => { const p = [...document.querySelectorAll('[aria-label="Nuova offerta"]')].find(n => n.getClientRects().length > 0); return [...p.querySelectorAll('input:not([type=radio]):not([type=checkbox]):not([type=date]), textarea')].filter(n => n.getClientRects().length > 0).map((n, i) => { n.setAttribute('data-probe', 'f' + i); return { i, name: n.name, label: n.getAttribute('aria-label') || (n.labels && n.labels[0] ? n.labels[0].textContent : ''), placeholder: n.placeholder }; }); })()`);
  log('d7c78:offer-fields', fillers);
  for (const f of fillers) {
    const label = `${f.name} ${f.label} ${f.placeholder}`.toLowerCase();
    let text = null;
    if (/titolo|title|nome/.test(label)) text = 'Pacchetto 10 lezioni';
    else if (/valore|value|importo|€|euro/.test(label)) text = '250';
    else if (/referente|owner|segue/.test(label)) text = 'Elena Rinaldi';
    if (text) { await b.tap(`document.querySelector('[data-probe=${f.i ? 'f' + f.i : 'f0'}]')`); await b.type(text); }
  }
  await b.tap(`[...document.querySelectorAll('[aria-label="Nuova offerta"] button')].find(n => n.textContent.trim() === 'Crea offerta')`);
  await sleep(1200);
  reqs = await b.eval(`window.__req.filter(r => r.method !== 'GET')`);
  const offerNote = await b.eval(`[...document.querySelectorAll('[aria-label="Nuova offerta"] .field-error, [aria-label="Nuova offerta"] [role=status], [role=status], .toast')].map(n => n.textContent.trim()).filter(Boolean).slice(0, 4)`);
  log('d7c78:offer-sent', { writes: reqs, notes: offerNote });
  await b.shot(`${OUT}/d7c78-scheda-390-dopo-offerta.png`);

  await open('calendario');
  const cal = await b.eval(`(() => { const confirms = [...document.querySelectorAll('.cal-slots button')].filter(n => n.textContent === 'Conferma'); const grid = document.querySelector('.cal-grid, .cal-week, .cal-wrap'); const g = grid ? grid.getBoundingClientRect() : null; return { confirms: confirms.length, firstConfirm: confirms[0] ? (() => { const r = confirms[0].getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })() : null, draggable: document.querySelectorAll('[draggable=true]').length, overflow: document.documentElement.scrollWidth - innerWidth, vw: innerWidth, grid: g ? [Math.round(g.width)] : null }; })()`);
  log('d7c78:calendar-before', cal);
  await b.tap(`[...document.querySelectorAll('.cal-slots button')].find(n => n.textContent === 'Conferma')`);
  await sleep(1200);
  reqs = await b.eval(`window.__req.filter(r => r.method !== 'GET')`);
  const calNote = await b.eval(`[...document.querySelectorAll('.cal-note, [role=status], .lede, p')].map(n => n.textContent.trim()).filter(t => /Prenot|Confermat|Registrat|Fissat/.test(t)).slice(0, 4)`);
  log('d7c78:calendar-booked', { writes: reqs, notes: calNote, overflowAfter: await b.eval('document.documentElement.scrollWidth - innerWidth') });
  await b.shot(`${OUT}/d7c78-calendario-390-dopo-conferma.png`, true);
} finally {
  b.close(); server.close();
  writeFileSync(`${OUT}/interaction-measures.json`, JSON.stringify(R, null, 2));
}
