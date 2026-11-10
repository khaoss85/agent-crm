// Minimal CDP driver over the repo's own bo:shots harness (loopback, demo fixtures only).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = process.env.REPO;
const { harnessHtml } = await import(join(REPO, 'scripts', 'bo-shots.js'));
const publicDir = join(REPO, 'apps', 'admin', 'public');
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon', '.webp': 'image/webp', '.jpg': 'image/jpeg' };

// The harness as bo:shots serves it, with two changes for interaction: the shell
// gets the real window (Esc / focus trap, like app.js), and each fixture client
// is exposed as window.__client so the probe can record requests.
export function page(name) {
  let html = harnessHtml(name, publicDir);
  html = html.replace('win: null,', 'win: window,');
  html = html.replace(/const client = \{/g, 'const client = window.__client = {');
  // the app passes the active space to the scheda (composer and offer need it)
  html = html.replace('createCustomerCardView({ doc: document,', "createCustomerCardView({ spaceId: 'spazio-demo', doc: document,");
  return html;
}

export function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = /^\/m-([a-z-]+)\.html$/.exec(url.pathname);
    if (m) { try { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page(m[1])); } catch (e) { res.writeHead(500); res.end(String(e)); } return; }
    const rel = normalize(url.pathname.replace(/^\/+/, ''));
    const file = join(publicDir, rel);
    const ext = rel.includes('.') ? `.${rel.split('.').pop()}` : '';
    if (rel === '' || rel.startsWith('..') || !file.startsWith(publicDir + sep) || !existsSync(file)) { res.writeHead(404); res.end('no'); return; }
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' }); res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

export async function launch() {
  const dir = mkdtempSync(join(process.env.SCRATCH ?? tmpdir(), 'prof-'));
  const child = spawn(process.env.CHROMIUM_BIN, ['--headless', '--disable-gpu', '--hide-scrollbars', '--disable-background-networking', `--user-data-dir=${dir}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    child.stderr.on('data', (c) => { buf += c; const m = /DevTools listening on (ws:\S+)/.exec(buf); if (m) resolve(m[1]); });
    setTimeout(() => reject(new Error('no devtools ' + buf.slice(-400))), 30000);
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); } });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { id += 1; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params) => send(method, params, sessionId);
  await s('Page.enable'); await s('Runtime.enable');
  const api = {
    s,
    async viewport(width, height, phone) {
      await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: phone });
      await s('Emulation.setTouchEmulationEnabled', { enabled: phone, maxTouchPoints: phone ? 5 : 1 });
      await s('Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: phone ? 'none' : 'hover' }, { name: 'pointer', value: phone ? 'coarse' : 'fine' }] });
    },
    async eval(expr) {
      const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
      return r.result.value;
    },
    async goto(url, ready) {
      await s('Page.navigate', { url });
      for (let i = 0; i < 200; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        try { const t = await api.eval('document.title'); if (t === ready) return; } catch {}
      }
      throw new Error('not ready ' + url + ' title=' + await api.eval('document.title'));
    },
    async shot(file, full = false) {
      const params = { format: 'png' };
      if (full) { const h = await api.eval('Math.max(document.documentElement.scrollHeight, innerHeight)'); const w = await api.eval('innerWidth'); params.clip = { x: 0, y: 0, width: w, height: h, scale: 1 }; params.captureBeyondViewport = true; }
      const { data } = await s('Page.captureScreenshot', params);
      writeFileSync(file, Buffer.from(data, 'base64'));
    },
    async tap(selectorExpr) {
      const box = await api.eval(`(() => { const n = ${selectorExpr}; if (!n) return null; n.scrollIntoView({block:'center'}); const r = n.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height, hit: (document.elementFromPoint(r.x + r.width/2, r.y + r.height/2) === n || n.contains(document.elementFromPoint(r.x + r.width/2, r.y + r.height/2))) }; })()`);
      if (!box) throw new Error('tap: not found ' + selectorExpr);
      await s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }] });
      await s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await new Promise((r) => setTimeout(r, 300));
      return box;
    },
    async key(key, code, keyCode) {
      const text = key === 'Enter' ? '\r' : (key === ' ' ? ' ' : undefined);
      await s('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, text });
      await s('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
      await new Promise((r) => setTimeout(r, 200));
    },
    async type(text) { await s('Input.insertText', { text }); await new Promise((r) => setTimeout(r, 150)); },
    close() { try { ws.close(); } catch {} child.kill('SIGKILL'); },
  };
  return api;
}

// Generic layout measure: viewport, page scroll width, right-overflowing
// elements not clipped by a scroll container inside the viewport, content
// top, topbar box, smallest visible form-field font size.
export const MEASURE = `(() => {
  const vw = innerWidth;
  const rect = (sel) => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }; };
  const visible = (n) => { const cs = getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden') return false; const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const offenders = [];
  for (const n of document.querySelectorAll('body *')) {
    if (n.closest('#probe, #bodiag, script, style')) continue;
    if (!visible(n)) continue;
    const r = n.getBoundingClientRect();
    if (r.right <= vw + 0.5) continue;
    let p = n.parentElement, clipped = false;
    while (p && p !== document.body) { const cs = getComputedStyle(p); if (/(auto|scroll|hidden|clip)/.test(cs.overflowX)) { const pr = p.getBoundingClientRect(); if (pr.right <= vw + 0.5) { clipped = true; break; } } p = p.parentElement; }
    if (!clipped && !(n.parentElement && offenders.some((o) => o.node.contains(n)))) offenders.push({ node: n, desc: n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).join('.') : '') + ' right=' + Math.round(r.right) });
  }
  const fields = [...document.querySelectorAll('#view-module input, #view-module textarea, #view-module select, .bo-topbar input, body > * input, body > * textarea')].filter(visible).filter((n) => !['checkbox','radio','hidden','file','range'].includes((n.type||'').toLowerCase()));
  const sizes = fields.map((n) => parseFloat(getComputedStyle(n).fontSize));
  const vm = document.getElementById('view-module');
  const firstChild = vm ? [...vm.children].find(visible) : null;
  return {
    vw, vh: innerHeight, docScrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth,
    horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - vw),
    offenders: offenders.slice(0, 8).map((o) => o.desc), offenderCount: offenders.length,
    topbar: rect('.bo-topbar'), viewModuleTop: vm ? Math.round(vm.getBoundingClientRect().top) : null,
    contentTop: firstChild ? Math.round(firstChild.getBoundingClientRect().top) : null,
    crumb: (() => { const n = document.querySelector('.bo-crumb'); if (!n) return null; const r = n.getBoundingClientRect(); return { text: n.textContent, visible: visible(n), inViewport: r.top >= 0 && r.bottom <= innerHeight && r.right <= vw, truncated: n.scrollWidth > n.clientWidth + 1 }; })(),
    sidebar: rect('.bo-sidebar'), sidebarVisibleInViewport: (() => { const n = document.querySelector('.bo-sidebar'); if (!n || !visible(n)) return false; const r = n.getBoundingClientRect(); return r.right > 0 && r.left < vw; })(),
    menuToggle: rect('.bo-menu-toggle'), menuExpanded: document.querySelector('.bo-menu-toggle')?.getAttribute('aria-expanded') ?? null,
    fieldCount: fields.length, minFieldFontPx: sizes.length ? Math.min(...sizes) : null,
    fieldsUnder16: fields.filter((n) => parseFloat(getComputedStyle(n).fontSize) < 16).map((n) => (n.name || n.className || n.tagName) + ':' + getComputedStyle(n).fontSize).slice(0, 8),
  };
})()`;
