// @ts-check
/**
 * Browser proof for the backoffice skill detail (BO-F4-02,
 * backlog:c73c6ec83643): the real `admin-skill-detail.js` view plus the real
 * `styles.css` render inside a real Chromium, once at a desktop viewport and
 * once on a phone viewport. The harness opens the detail of `debug-crm-run`
 * on demo catalog data (active in the space, with a Prova preview), so the
 * PNG shows the six-step cycle, the activatable rules, the real kernel
 * definition, the example with its trace, the used connectors and the
 * copyable coding-agent prompt. Each run writes a PNG of the painted detail
 * and reports its byte size and pixel dimensions; the phone run additionally
 * asserts, from inside the page, that nothing scrolls sideways under 390px.
 *
 * The Chromium lookup mirrors scripts/site-shots.js (CHROMIUM_BIN, then the
 * Playwright headless-shell caches). Where no binary exists the test skips
 * with its reason instead of faking a pass: the Mac CI runner produces the
 * PNGs.
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

const UNITS = [
  {
    name: 'skill:debug-crm-run', kind: 'skill', label: 'Diagnosi',
    blurb: 'Diagnosi di un workflow fallito da tracce e audit.',
    requires: { tier: 'any-project', command: 'crm app inspect' },
    degradesTo: 'nothing — this skill already reaches the project only through commands, the trace API and MCP tools',
  },
];

const FIXTURE_SCRIPT = `
import { buildShellNav as buildHarnessShellNav, createShellView } from './admin-shell.js';
import { createSkillDetailView } from './admin-skill-detail.js';
const UNITS = ${JSON.stringify(UNITS)};
const shellView = createShellView({
  doc: document,
  sidebar: document.getElementById('boSidebar'),
  topbar: document.getElementById('boTopbar'),
  spaces: [{ id: 'locale', name: 'Studio Aurora', initials: 'SA' }],
  user: { name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' },
  screenId: 'impostazioni',
  screenLabel: 'Dettaglio skill',
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
  activeScreenId: 'impostazioni',
  aiScreenId: null,
  screenLabel: 'Dettaglio skill',
  clientCount: 3,
  clientCountExact: true,
  fixCount: 2,
});
await Promise.all([
  document.fonts.load('400 14px "Bricolage Grotesque"', 'Studio Aurora Diagnosi'),
  document.fonts.load('700 14px "Bricolage Grotesque"', 'Studio Aurora Diagnosi'),
  document.fonts.load('400 12px "Spline Sans Mono"', 'STUDIO AURORA / DETTAGLIO 0123456789'),
]).catch(() => {});
await document.fonts.ready.catch(() => {});
const client = {
  async request(path) {
    if (path === '/api/space-packages/catalog') return { units: UNITS };
    if (path.startsWith('/api/modules/space-package/records')) {
      return { items: [{ unit: 'skill:debug-crm-run', status: 'active' }] };
    }
    if (path.startsWith('/api/space-packages/preview')) {
      return { headline: 'Canali: 1 riga. La Prova non scrive nulla.', counts: [{ module: 'channel-connection', count: 1 }], uncomposed: [], writes: 0 };
    }
    throw new Error('unexpected request ' + path);
  },
};
const storage = { getItem: () => 'locale', setItem: () => {}, removeItem: () => {} };
const view = createSkillDetailView({ doc: document, mount: document.getElementById('view-module'), client, navigate: () => {}, storage, toast: () => {} });
await view.render('debug-crm-run');
document.getElementById('probe').textContent = JSON.stringify({
  head: document.getElementById('view-module').textContent.includes('Skill · Diagnosi'),
  cycle: document.getElementById('view-module').textContent.includes('Ciclo di lavoro'),
  definition: document.getElementById('view-module').textContent.includes('Nel tuo progetto Accordo'),
  example: document.getElementById('view-module').textContent.includes('Esempio con traccia'),
  connectors: document.getElementById('view-module').textContent.includes('Connettori usati'),
  prompt: document.getElementById('view-module').textContent.includes('bundle verify'),
  copy: document.querySelectorAll('#view-module button[data-action="copy-prompt"]').length,
  sections: document.querySelectorAll('#view-module [data-section]').length,
  scrollWidth: document.documentElement.scrollWidth,
  innerWidth: window.innerWidth,
});
document.title = 'dettaglio-skill-ready';
`;

function harnessHtml() {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<link rel="stylesheet" href="/styles.css"></head>`
    + `<body><main class="bo-shell">`
    + `<aside class="bo-sidebar" id="boSidebar" aria-label="Navigazione backoffice"></aside>`
    + `<div class="bo-main"><div class="bo-topbar" id="boTopbar"></div>`
    + `<section id="view-module" aria-live="polite"></section></div></main>`
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
  assert.ok(served.includes('admin-skill-detail.js'), 'the harness serves the real detail module');
  const out = join(mkdirTmp(), `dettaglio-skill-${width}x${height}.png`);
  try {
    const run = await runChromium([
      '--headless',
      `--screenshot=${out}`,
      `--window-size=${width},${height}`,
      '--virtual-time-budget=8000',
      '--hide-scrollbars',
      '--disable-background-networking',
      page,
    ], 120000);
    assert.equal(run.status, 0, `chromium exits 0 (stderr: ${(run.stderr ?? '').slice(-500)})`);
    const dom = await runChromium([
      '--headless', '--dump-dom',
      `--window-size=${width},${height}`,
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
  const dir = join(tmpdir(), 'accordo-skill-detail-shots');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readProbe(dom) {
  const probeHtml = dom.match(/<div id="probe"[^>]*>(.*?)<\/div>/)?.[1] ?? '';
  return JSON.parse(probeHtml.replace(/&quot;/g, '"'));
}

function assertProbeFields(probe) {
  assert.equal(probe.head, true, 'the detail heads the Diagnosi skill');
  assert.equal(probe.cycle, true, 'the six-step cycle paints');
  assert.equal(probe.definition, true, 'the real kernel definition paints');
  assert.equal(probe.example, true, 'the example with its trace paints');
  assert.equal(probe.connectors, true, 'the used connectors paint');
  assert.equal(probe.prompt, true, 'the copyable coding-agent prompt paints');
  assert.equal(probe.copy, 1, 'the prompt carries its copy button');
  assert.equal(probe.sections, 7, 'all seven sections paint');
}

test('the skill detail shows the real format and its prompt: desktop PNG', { skip: SHOTS_SKIP }, async () => {
  const { out, dom } = await runBrowser({ width: 1440, height: 1800 });
  assert.ok(dom.includes('<title>dettaglio-skill-ready</title>'), 'the harness module ran to completion in the page');
  const shot = pngSize(out);
  assert.equal(shot.width, 1440, 'the PNG is the desktop viewport');
  assert.ok(shot.bytes > 20000, `the detail paints real pixels (${shot.bytes} bytes)`);
  assertProbeFields(readProbe(dom));
  console.log(`dettaglio-skill desktop PNG: ${out} (${shot.width}x${shot.height}, ${shot.bytes} bytes)`);
});

test('the skill detail shows the real format and its prompt: phone PNG without sideways scroll', { skip: SHOTS_SKIP }, async () => {
  const { out, dom } = await runBrowser({ width: 390, height: 1600 });
  const shot = pngSize(out);
  assert.equal(shot.width, 390, 'the PNG is the phone viewport');
  assert.ok(shot.bytes > 10000, `the detail paints real pixels (${shot.bytes} bytes)`);
  assert.ok(dom.includes('<title>dettaglio-skill-ready</title>'), 'the harness module ran to completion in the page');
  const probe = readProbe(dom);
  assertProbeFields(probe);
  assert.ok(probe.scrollWidth <= 390, `no horizontal overflow at 390px (scrollWidth ${probe.scrollWidth})`);
  console.log(`dettaglio-skill phone PNG: ${out} (${shot.width}x${shot.height}, ${shot.bytes} bytes)`);
});
