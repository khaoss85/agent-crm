// @ts-check
/**
 * Browser proof for the backoffice Sequenze view (screen 10): the real
 * `admin-sequenze.js` module plus the real `styles.css` render the elenco
 * with state and counted metrics plus the dettaglio with day+channel steps
 * inside a real Chromium, once at a desktop viewport and once on a phone
 * viewport. The harness opens the first sequence, asks for its write (the
 * second ask appears, then it cancels: no POST ever leaves the fixture),
 * so the PNG shows elenco + dettaglio and the probe proves the confirm
 * step. The phone run additionally asserts, from inside the page, that
 * nothing scrolls sideways under 700px.
 *
 * The Chromium lookup mirrors scripts/site-shots.js (CHROMIUM_BIN, then the
 * Playwright headless-shell caches). Where no binary exists the test skips
 * with its reason instead of faking a pass: the CI runner is the Mac that
 * carries the cache, so the gate still sees a real browser.
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
 * A present binary is not a runnable one: sandboxed executors (and bare
 * CI images) carry the Playwright cache while the OS refuses Chromium's
 * Mach bootstrap, so every launch dies before painting. Probe once with a
 * blank page: only an exit-0 HTML dump counts as runnable. Anywhere else
 * the tests skip with their reason instead of faking a pass or failing the
 * gate for the environment — the Mac CI runner that carries the cache runs
 * them for real and writes the PNGs there.
 */
function chromiumRuns(binary) {
  if (!binary) return false;
  try {
    const probe = spawnSync(binary, ['--headless', '--disable-gpu', '--dump-dom', 'about:blank'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    return probe.status === 0 && String(probe.stdout ?? '').includes('<html');
  } catch {
    return false;
  }
}

const CHROMIUM_RUNS = chromiumRuns(CHROMIUM);
const SHOTS_SKIP = CHROMIUM_RUNS ? false : 'Chromium binary missing or unrunnable here (set CHROMIUM_BIN); the Mac CI runner produces the PNGs';

const SEQUENCES = [
  { id: 7, sourceKey: 'seq-bentornato', spaceId: 'presti', name: 'Bentornato in palestra', status: 'draft' },
  { id: 8, sourceKey: 'seq-promemoria', spaceId: 'presti', name: 'Promemoria appuntamento', status: 'active' },
];

const STEPS = [
  { id: 1, sequenceSourceKey: 'seq-bentornato', spaceId: 'presti', stepOrder: 0, dayOffset: 0, channel: 'whatsapp', templateName: 'Ciao, ci manchi', templateLanguage: 'it', templateVars: '["name"]' },
  { id: 2, sequenceSourceKey: 'seq-bentornato', spaceId: 'presti', stepOrder: 1, dayOffset: 2, channel: 'email', templateName: 'Ritroviamoci', templateLanguage: 'it', templateVars: '["name"]' },
];

const ENROLLMENTS = [
  { id: 11, sequenceSourceKey: 'seq-bentornato', spaceId: 'presti', subjectLabel: 'Giulia Rossi', status: 'active', currentStep: 0, nextDueAt: '2026-10-26T09:00:00.000Z' },
  { id: 12, sequenceSourceKey: 'seq-bentornato', spaceId: 'presti', subjectLabel: 'Marco Bianchi', status: 'stopped-replied', currentStep: 1, nextDueAt: null },
];

const SENDS = [
  { id: 21, sequenceSourceKey: 'seq-bentornato', spaceId: 'presti', status: 'sent' },
  { id: 22, sequenceSourceKey: 'seq-bentornato', spaceId: 'presti', status: 'waiting-approval' },
];

const FIXTURE_SCRIPT = `
import { createSequenzeView } from './admin-sequenze.js';
const SEQUENCES = ${JSON.stringify(SEQUENCES)};
const STEPS = ${JSON.stringify(STEPS)};
const ENROLLMENTS = ${JSON.stringify(ENROLLMENTS)};
const SENDS = ${JSON.stringify(SENDS)};
const client = {
  async request(path) {
    if (path === '/api/schema') return { domains: { sequences: { sequencesContract: 1 } } };
    if (path.includes('/sequence-step/')) return { items: STEPS.filter((s) => path.includes(encodeURIComponent(s.sequenceSourceKey)) || !path.includes('filter.sequenceSourceKey')) };
    if (path.includes('/sequence-enrollment/')) return { items: ENROLLMENTS };
    if (path.includes('/sequence-send/')) return { items: SENDS };
    if (path.includes('/sequence/')) return { items: SEQUENCES };
    throw new Error('unexpected ' + path);
  },
};
const view = createSequenzeView({
  doc: document,
  mount: document.getElementById('mount'),
  client,
  spaceId: () => 'presti',
});
await view.renderSequenze();
await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 100));
document.querySelector('button[data-open]').click();
await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 100));
document.querySelector('button[data-action]').click();
await new Promise((r) => setTimeout(r, 100));
const probe = {
  rows: document.querySelectorAll('.bo-seq-row').length,
  names: [...document.querySelectorAll('.bo-seq-name')].map((n) => n.textContent),
  detail: document.querySelectorAll('.bo-seq-section h3')[1] ? document.querySelectorAll('.bo-seq-section h3')[1].textContent : null,
  steps: document.querySelectorAll('.bo-seq-step').length,
  firstDay: document.querySelector('.bo-seq-day') ? document.querySelector('.bo-seq-day').textContent : null,
  firstChannel: document.querySelector('.bo-seq-channel') ? document.querySelector('.bo-seq-channel').textContent : null,
  confirm: document.querySelector('.bo-seq-confirm') ? document.querySelector('.bo-seq-confirm').textContent : null,
  scrollWidth: document.documentElement.scrollWidth,
  innerWidth: window.innerWidth,
};
document.getElementById('probe').textContent = JSON.stringify(probe);
document.title = 'sequenze-ready';
`;

function harnessHtml() {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<link rel="stylesheet" href="/styles.css"></head>`
    + `<body><div id="mount"></div><div id="probe"></div>`
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
    const child = spawn(CHROMIUM, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
  // The browser reads the fixture from this process: prove the fixture
  // serves before launching anything, so a browser-env failure can never
  // disguise itself as a passing render.
  const served = await fetch(page).then((response) => response.text());
  assert.ok(served.includes('admin-sequenze.js'), 'the harness serves the real view module');
  const out = join(mkdirTmp(), `seq-elenco-dettaglio-${width}x${height}.png`);
  try {
    const run = await runChromium([
      '--headless',
      `--screenshot=${out}`,
      `--window-size=${width},${height}`,
      '--virtual-time-budget=8000',
      '--hide-scrollbars',
      page,
    ], 120000);
    assert.equal(run.status, 0, `chromium exits 0 (stderr: ${(run.stderr ?? '').slice(-500)})`);
    const dom = await runChromium([
      '--headless', '--dump-dom',
      `--window-size=${width},${height}`,
      '--virtual-time-budget=8000',
      page,
    ], 120000);
    assert.equal(dom.status, 0, 'the probe run exits 0');
    return { out, dom: dom.stdout };
  } finally {
    server.close();
  }
}

function mkdirTmp() {
  const dir = join(tmpdir(), 'accordo-seq-shots');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readProbe(dom) {
  const probeHtml = dom.match(/<div id="probe">(.*?)<\/div>/)?.[1] ?? '';
  return JSON.parse(probeHtml.replace(/&quot;/g, '"'));
}

test('the sequenze elenco and dettaglio render in a real browser: desktop PNG', { skip: SHOTS_SKIP }, async () => {
  const { out, dom } = await runBrowser({ width: 1280, height: 900 });
  assert.ok(dom.includes('<title>sequenze-ready</title>'), 'the harness module ran to completion in the page');
  const shot = pngSize(out);
  assert.equal(shot.width, 1280, 'the PNG is the desktop viewport');
  assert.ok(shot.bytes > 20000, `the elenco paints real pixels (${shot.bytes} bytes)`);
  const probe = readProbe(dom);
  assert.equal(probe.rows, 2, 'the elenco lists both sequences');
  assert.ok(probe.names.includes('Bentornato in palestra'), 'the elenco names the draft sequence');
  assert.equal(probe.detail, 'Bentornato in palestra', 'opening a row paints its dettaglio');
  assert.equal(probe.steps, 2, 'the dettaglio lists both day+channel steps');
  assert.equal(probe.firstDay, 'Subito', 'the first step names its day');
  assert.equal(probe.firstChannel, 'WhatsApp · Ciao, ci manchi', 'the first step names its channel and title');
  assert.ok(probe.confirm?.includes('Attivare questa sequenza?'), `the write asks twice (${probe.confirm})`);
  console.log(`sequenze desktop PNG: ${out} (${shot.width}x${shot.height}, ${shot.bytes} bytes)`);
});

test('the sequenze elenco and dettaglio render in a real browser: phone PNG without sideways scroll', { skip: SHOTS_SKIP }, async () => {
  const { out, dom } = await runBrowser({ width: 390, height: 844 });
  const shot = pngSize(out);
  assert.equal(shot.width, 390, 'the PNG is the phone viewport');
  assert.ok(shot.bytes > 12000, `the elenco paints real pixels (${shot.bytes} bytes)`);
  assert.ok(dom.includes('<title>sequenze-ready</title>'), 'the harness module ran to completion in the page');
  const probe = readProbe(dom);
  assert.equal(probe.rows, 2, 'the phone elenco lists both sequences');
  assert.equal(probe.detail, 'Bentornato in palestra', 'the phone dettaglio opens');
  assert.ok(probe.scrollWidth <= 390, `no horizontal overflow at 390px (scrollWidth ${probe.scrollWidth})`);
  console.log(`sequenze phone PNG: ${out} (${shot.width}x${shot.height}, ${shot.bytes} bytes)`);
});
