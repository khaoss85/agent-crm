// @ts-check
/**
 * Browser proof for the backoffice assistant panel (BO-F4-04, backlog:27dde5f048ee):
 * the real `admin-assistant.js` panel plus the real `styles.css` render inside
 * a real Chromium, once at a desktop viewport and once on a phone viewport.
 * The harness opens the panel on the clienti screen, runs the
 * "Chi devo ricontattare?" suggestion (answers carry record sources with
 * `#/` hrefs plus the "Traccia di esecuzione") and then the segnali
 * suggestion, so the PNG shows sources, trace and the "Cronologia" of the
 * conserved session history. Each run writes a PNG of the painted panel and
 * reports its byte size and pixel dimensions; the phone run additionally
 * asserts, from inside the page, that nothing scrolls sideways under 390px.
 *
 * The Chromium lookup mirrors scripts/site-shots.js (CHROMIUM_BIN, then the
 * Playwright headless-shell caches). Sandbox-less Linux executors (this lane:
 * unprivileged user namespaces disabled) refuse Chromium's zygote bootstrap,
 * so the runnable probe below retries once with --no-sandbox and the render
 * runs reuse the winning flags: the painted pixels come from the same binary
 * over loopback only, never from a fake. Where no binary exists the test
 * skips with its reason instead of faking a pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

function readDirSafe(directory) {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

function findChromium() {
  const candidates = [
    process.env.CHROMIUM_BIN,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  const bases = [
    join(homedir(), '.cache', 'ms-playwright'),
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
  ];
  for (const base of bases) {
    for (const entry of readDirSafe(base)) {
      for (const suffix of [
        ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell'],
        ['chrome-headless-shell-mac-x64', 'chrome-headless-shell'],
        ['chrome-linux', 'headless_shell'],
      ]) {
        const path = join(base, entry, ...suffix);
        if (existsSync(path)) return path;
      }
    }
  }
  return null;
}

const CHROMIUM = findChromium();

/**
 * A present binary is not a runnable one: sandboxed executors and bare
 * images refuse Chromium's sandbox bootstrap, so every launch dies before
 * painting. Probe once with a blank page, retrying once without the sandbox
 * where the OS forbids it: only an exit-0 HTML dump counts as runnable.
 * The render runs reuse the winning flags.
 */
function chromiumFlags(binary) {
  if (!binary) return null;
  const probe = (extra) => {
    try {
      const out = spawnSync(binary, ['--headless', '--disable-gpu', '--dump-dom', ...extra, 'about:blank'], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      return out.status === 0 && String(out.stdout ?? '').includes('<html');
    } catch {
      return false;
    }
  };
  if (probe([])) return [];
  if (probe(['--no-sandbox'])) return ['--no-sandbox'];
  return null;
}

const CHROMIUM_FLAGS = chromiumFlags(CHROMIUM);
const SHOTS_SKIP = CHROMIUM_FLAGS === null ? 'Chromium binary missing or unrunnable here (set CHROMIUM_BIN); the Mac CI runner produces the PNGs' : false;

const CONVS = {
  items: [
    {
      id: 'conv-1', status: 'open', channel: 'whatsapp', remoteHandle: '+39 333 000 0001',
      subjectResource: 'contact', subjectId: 'contact-9', subjectLabel: 'Marco Rossi',
      updatedAt: '2026-10-20T08:00:00.000Z', openedAt: '2026-10-19T08:00:00.000Z',
    },
    {
      id: 'conv-2', status: 'open', channel: 'instagram', remoteHandle: '@sara.b',
      subjectResource: 'contact', subjectId: 'contact-7', subjectLabel: 'Sara Bianchi',
      updatedAt: '2026-10-20T09:00:00.000Z', openedAt: '2026-10-19T09:00:00.000Z',
    },
    { id: 'conv-3', status: 'closed', channel: 'email', remoteHandle: 'luigi@example.it', updatedAt: '2026-10-18T08:00:00.000Z' },
  ],
};

const SIGNALS = {
  items: [
    { id: 'sig-1', leadId: 'lead-a', signalType: 'pricing-page-visited', observedAt: '2026-10-20T07:00:00.000Z' },
    { id: 'sig-2', leadId: 'lead-a', signalType: 'demo-requested', observedAt: '2026-10-20T08:00:00.000Z' },
    { id: 'sig-3', leadId: 'lead-b', signalType: 'pricing-page-visited', observedAt: '2026-10-20T08:30:00.000Z' },
  ],
};

const ROWS = [
  {
    resource: 'contact', id: 'c1', name: 'Marco Rossi',
    company: { id: 'co1', name: 'Palestra Esempio' }, email: 'marco@palestra-esempio.it',
    phone: { value: '+393331234567', system: 'whatsapp' }, channels: ['whatsapp'],
    status: { value: 'cliente', reason: 'signed business on record: orders' },
    lastContactAt: '2026-10-20T09:00:00.000Z', lastContactChannel: 'whatsapp',
    offerValueCents: 120000, offerCurrency: 'EUR',
    nextStep: { title: 'Prova gratuita', dueAt: '2026-10-22', overdue: false },
    budget: { available: true, value: '200/mese', source: { resource: 'contact', id: 'c1' }, reason: null },
  },
  {
    resource: 'contact', id: 'c2', name: 'Anna Bianchi',
    company: null, email: 'anna@esempio.it', phone: null, channels: ['instagram'],
    status: { value: 'contatto', reason: 'no signed business on record' },
    lastContactAt: null, lastContactChannel: null,
    offerValueCents: null, offerCurrency: null, nextStep: null,
    budget: { available: false, value: null, source: null, reason: 'nessun budget estratto per questo cliente' },
  },
  {
    resource: 'contact', id: 'c3', name: 'Luca Verdi',
    company: { id: 'co2', name: 'Studio Aurora' }, email: 'luca@studioaurora.it',
    phone: { value: '+393339876543', system: 'phone' }, channels: ['phone'],
    status: { value: 'contatto', reason: 'no signed business on record' },
    lastContactAt: '2026-10-19T16:30:00.000Z', lastContactChannel: 'phone',
    offerValueCents: null, offerCurrency: null, nextStep: null,
    budget: { available: false, value: null, source: null, reason: 'nessun budget estratto per questo cliente' },
  },
];

const MENUS = {
  views: [
    { id: 'tutti', label: 'Tutti', count: 3 },
    { id: 'ricontattare-oggi', label: 'Da ricontattare oggi', count: 1 },
    { id: 'nuovi-lead', label: 'Nuovi lead', count: 1 },
    { id: 'clienti-attivi', label: 'Clienti attivi', count: 1 },
    { id: 'rinnovi-30-giorni', label: 'Rinnovi entro 30 giorni' },
  ],
  sorts: [
    { id: 'recent', label: 'Ultimo contatto' },
    { id: 'name', label: 'Nome A-Z' },
    { id: 'value', label: 'Valore offerta' },
    { id: 'status', label: 'Stato' },
  ],
  columns: [
    { id: 'canali', label: 'Canali', always: false, ai: false, def: true },
    { id: 'stato', label: 'Stato', always: false, ai: false, def: true },
    { id: 'ultimo', label: 'Ultimo contatto', always: false, ai: false, def: true },
    { id: 'prossimo', label: 'Prossimo passo', always: false, ai: false, def: true },
  ],
  pageSizes: [10, 25, 50],
};

const FIXTURE_SCRIPT = `
import { buildShellNav as buildHarnessShellNav, createShellView } from './admin-shell.js';
import { createCustomerListView } from './admin-clienti.js';
import { createAssistantPanel } from './admin-assistant.js';
const CONVS = ${JSON.stringify(CONVS)};
const SIGNALS = ${JSON.stringify(SIGNALS)};
const ROWS = ${JSON.stringify(ROWS)};
const MENUS = ${JSON.stringify(MENUS)};
// The same shell the other screens photograph: sidebar plus topbar with the
// demo composition, so the panel opens over a real backoffice screen.
const shellView = createShellView({
  doc: document,
  sidebar: document.getElementById('boSidebar'),
  topbar: document.getElementById('boTopbar'),
  spaces: [{ id: 'locale', name: 'Studio Aurora', initials: 'SA' }],
  user: { name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' },
  screenId: 'clienti',
  screenLabel: 'Clienti',
  navigate: () => {},
  notify: () => {},
  onLogout: () => {},
  onPickSpace: () => {},
  win: null,
});
shellView.update({
  items: buildHarnessShellNav({
    pipelines: [{ name: 'vendite', label: 'Vendite' }],
    customerDataAvailable: true,
    sequencesAvailable: true,
  }),
  activeScreenId: 'clienti',
  aiScreenId: null,
  screenLabel: 'Clienti',
  clientCount: 3,
  clientCountExact: true,
  fixCount: 2,
});
await Promise.all([
  document.fonts.load('400 14px "Bricolage Grotesque"', 'Studio Aurora Clienti'),
  document.fonts.load('700 14px "Bricolage Grotesque"', 'Studio Aurora Clienti'),
  document.fonts.load('400 12px "Spline Sans Mono"', 'STUDIO AURORA / CLIENTI 0123456789'),
]).catch(() => {});
await document.fonts.ready.catch(() => {});
const viewClient = {
  async request(path) {
    if (path === '/api/schema') return { customerListContract: 1 };
    return { customerListContract: 1, items: ROWS, total: ROWS.length, page: 1, pageSize: 10, pages: 1, totalIsExact: true, ...MENUS };
  },
};
const store = { map: new Map(), getItem(k) { return this.map.get(k) ?? null; }, setItem(k, v) { this.map.set(k, v); } };
await createCustomerListView({ doc: document, mount: document.getElementById('view-module'), client: viewClient, storage: store, notify: () => {} }).render();
// The panel reads the same record surfaces the unit tests prove: open
// threads for the ricontattare answer, behavioral signals for the segnali
// one. Unknown paths throw, so the backend probe stays dry-run.
const panelClient = {
  async request(path) {
    if (path === '/api/modules/conversation/records?limit=50') return CONVS;
    if (path === '/api/modules/behavioral-signal/records?limit=100') return SIGNALS;
    throw new Error('no such module (' + path + ')');
  },
};
const panel = createAssistantPanel({ doc: document, mount: document.getElementById('boAssistant'), client: panelClient, navigate: () => {}, notify: () => {} });
await panel.open('clienti');
const clickSuggestion = (title) => [...document.querySelectorAll('.bo-assistant-suggestion')].find((b) => b.textContent.includes(title)).click();
const settle = async (ready) => {
  for (let i = 0; i < 100; i += 1) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the assistant panel did not settle');
};
clickSuggestion('Chi devo ricontattare?');
await settle(() => document.querySelectorAll('#boAssistant .bo-assistant-trace-read').length >= 1);
clickSuggestion('Quali lead mostrano segnali caldi?');
await settle(() => document.querySelectorAll('#boAssistant .bo-assistant-history-open').length === 2);
const links = [...document.querySelectorAll('#boAssistant .bo-assistant-source-link')].map((a) => a.getAttribute('href'));
document.getElementById('probe').textContent = JSON.stringify({
  suggestions: document.querySelectorAll('#boAssistant .bo-assistant-suggestion').length,
  sourcesHeading: document.getElementById('boAssistant').textContent.includes('Fonti'),
  traceHeading: document.getElementById('boAssistant').textContent.includes('Traccia di esecuzione'),
  historyHeading: document.getElementById('boAssistant').textContent.includes('Cronologia'),
  historyEntries: document.querySelectorAll('#boAssistant .bo-assistant-history-open').length,
  traceReads: document.querySelectorAll('#boAssistant .bo-assistant-trace-read').length,
  sourceLinks: links.length,
  sourceHrefsRecord: links.filter((href) => typeof href === 'string' && (href.startsWith('#/modules/') || href.startsWith('#/customer-card/'))).length,
  customers: document.getElementById('view-module').textContent.includes('Marco Rossi'),
  scrollWidth: document.documentElement.scrollWidth,
  innerWidth: window.innerWidth,
});
document.title = 'assistente-ready';
`;

function harnessHtml() {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<link rel="stylesheet" href="/styles.css"></head>`
    + `<body><main class="bo-shell">`
    + `<aside class="bo-sidebar" id="boSidebar" aria-label="Navigazione backoffice"></aside>`
    + `<div class="bo-main"><div class="bo-topbar" id="boTopbar"></div>`
    + `<section id="view-module" aria-live="polite"></section></div></main>`
    + `<aside class="bo-assistant-slot" id="boAssistant" aria-label="Assistente AI"></aside>`
    + `<div id="probe" hidden></div>`
    + `<script type="module">${FIXTURE_SCRIPT}</script></body></html>`;
}

/** @param {string} file */
function pngSize(file) {
  const bytes = readFileSync(file);
  assert.ok(bytes.length > 8, 'the shot is not empty');
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'the shot is a PNG');
  return { bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * The browser must run WITHOUT blocking this process: the fixture server
 * lives on the same event loop, so a synchronous spawn would starve it and
 * the page could never load. Async spawn keeps the loop free to serve.
 * @param {Array<string>} args
 * @param {number} timeoutMs
 */
function runChromium(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(CHROMIUM, [...CHROMIUM_FLAGS, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`chromium timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function runBrowser({ width, height }) {
  const dir = new URL('../apps/admin/public/', import.meta.url);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://shot.test');
    if (url.pathname === '/harness.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(harnessHtml());
      return;
    }
    const file = join(dir.pathname, url.pathname.slice(1));
    if (url.pathname.endsWith('.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(readFileSync(file, 'utf8'));
      return;
    }
    if (url.pathname.endsWith('.css')) {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      res.end(readFileSync(file, 'utf8'));
      return;
    }
    res.writeHead(404);
    res.end('no');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'the shot server listens');
  const port = address.port;
  const page = `http://127.0.0.1:${port}/harness.html`;
  // Prove the fixture serves before launching anything, so a browser-env
  // failure can never disguise itself as a passing render.
  const served = await fetch(page).then((response) => response.text());
  assert.ok(served.includes('admin-assistant.js'), 'the harness serves the real panel module');
  const out = join(mkdirTmp(), `assistente-${width}x1600.png`);
  try {
    const run = await runChromium([
      '--headless',
      `--screenshot=${out}`,
      `--window-size=${width},1600`,
      '--virtual-time-budget=8000',
      '--hide-scrollbars',
      '--disable-background-networking',
      page,
    ], 120000);
    assert.equal(run.status, 0, `chromium exits 0 (stderr: ${(run.stderr ?? '').slice(-500)})`);
    const dom = await runChromium([
      '--headless', '--dump-dom',
      `--window-size=${width},1600`,
      '--virtual-time-budget=8000',
      '--disable-background-networking',
      page,
    ], 120000);
    assert.equal(dom.status, 0, 'the probe run exits 0');
    return { out, dom: dom.stdout };
  } finally {
    server.close();
  }
}

function mkdirTmp() {
  const dir = join(tmpdir(), 'accordo-assistente-shots');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readProbe(dom) {
  const probeHtml = dom.match(/<div id="probe"[^>]*>(.*?)<\/div>/)?.[1] ?? '';
  return JSON.parse(probeHtml.replace(/&quot;/g, '"'));
}

function assertProbeFields(probe) {
  assert.ok(probe.suggestions >= 2, `the panel lists its screen suggestions (${probe.suggestions})`);
  assert.equal(probe.sourcesHeading, true, 'the answer names its sources (Fonti)');
  assert.equal(probe.traceHeading, true, 'the answer shows its execution trace (Traccia di esecuzione)');
  assert.equal(probe.historyHeading, true, 'the session history is inspectable (Cronologia)');
  assert.equal(probe.historyEntries, 2, 'both answers are conserved in the history');
  assert.ok(probe.traceReads >= 1, `the displayed answer traces its reads (${probe.traceReads})`);
  assert.ok(probe.sourceLinks >= 2, `the displayed answer cites records (${probe.sourceLinks})`);
  assert.equal(probe.sourceHrefsRecord, probe.sourceLinks, 'every citation opens its record of origin (#/modules/ or #/customer-card/)');
  assert.equal(probe.customers, true, 'the screen behind the panel paints the clienti rows');
}

test('the assistant answers with sources and an inspectable trace: desktop PNG', { skip: SHOTS_SKIP }, async () => {
  const { out, dom } = await runBrowser({ width: 1440, height: 1800 });
  assert.ok(dom.includes('<title>assistente-ready</title>'), 'the harness module ran to completion in the page');
  const shot = pngSize(out);
  assert.equal(shot.width, 1440, 'the PNG is the desktop viewport');
  assert.ok(shot.bytes > 20000, `the panel paints real pixels (${shot.bytes} bytes)`);
  assertProbeFields(readProbe(dom));
  console.log(`assistente desktop PNG: ${out} (${shot.width}x${shot.height}, ${shot.bytes} bytes)`);
});

test('the assistant answers with sources and an inspectable trace: phone PNG without sideways scroll', { skip: SHOTS_SKIP }, async () => {
  const { out, dom } = await runBrowser({ width: 390, height: 1600 });
  const shot = pngSize(out);
  assert.equal(shot.width, 390, 'the PNG is the phone viewport');
  assert.ok(shot.bytes > 10000, `the panel paints real pixels (${shot.bytes} bytes)`);
  assert.ok(dom.includes('<title>assistente-ready</title>'), 'the harness module ran to completion in the page');
  const probe = readProbe(dom);
  assertProbeFields(probe);
  assert.ok(probe.scrollWidth <= 390, `no horizontal overflow at 390px (scrollWidth ${probe.scrollWidth})`);
  console.log(`assistente phone PNG: ${out} (${shot.width}x${shot.height}, ${shot.bytes} bytes)`);
});
