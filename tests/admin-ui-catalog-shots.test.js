// @ts-check
/**
 * Browser proof for BO-F6-02: the component catalog, the Oggi frame and the
 * Personalizzazione (Connettori) view render every control with the `ui-*`
 * system classes, at a desktop and a phone viewport, in a real Chromium.
 * The harness serves the real view modules plus the real `styles.css` and
 * drives them with demo data, so the PNGs show the system as the operator
 * sees it. Each run writes its PNG and reports byte size and dimensions;
 * the phone run additionally asserts, from inside the page, that nothing
 * scrolls sideways under 700px and that no rendered control lacks a system
 * class.
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

const TASK_OPEN = {
  id: 'task-1',
  status: 'open',
  title: 'Richiama per il preventivo',
  subjectResource: 'lead',
  subjectId: 'lead-1',
  subjectOwner: 'host',
  subjectLabel: 'Giulia Romano',
  dueAt: '2026-10-19T00:00:00.000Z',
  openedAt: '2026-10-18T08:00:00.000Z',
};
const APPT_TODAY = {
  id: 'appt-1',
  status: 'booked',
  subjectResource: 'lead',
  subjectId: 'lead-1',
  subjectOwner: 'host',
  subjectLabel: 'Giulia Romano',
  startsAt: '2026-10-19T08:00:00.000Z',
  notes: 'Vuole la scheda con i prezzi del pacchetto.',
};

const FIXTURE_SCRIPT = `
const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'catalog';
if (view === 'catalog') {
  const { createUiCatalogView } = await import('./admin-ui-catalog.js');
  createUiCatalogView({ doc: document, mount: document.getElementById('mount') }).render();
} else if (view === 'oggi') {
  const { createOggiView } = await import('./admin-oggi.js');
  const client = {
    async request(path) {
      if (path === '/api/schema') return { domains: { work: {}, appointments: {} } };
      if (path.startsWith('/api/modules/work-task/records')) return { items: [${JSON.stringify(TASK_OPEN)}] };
      if (path.startsWith('/api/modules/appointment/records')) return { items: [${JSON.stringify(APPT_TODAY)}] };
      return { items: [] };
    },
  };
  const oggi = createOggiView({ doc: document, mount: document.getElementById('mount'), client });
  await oggi.render({ spaceName: 'Studio Aurora', userName: 'Elena', links: [], now: new Date('2026-10-19T07:00:00.000Z') });
} else if (view === 'personalizzazione') {
  const { createPersonalizzazioneView } = await import('./admin-personalizzazione.js');
  const client = { async request() { return { items: [] }; } };
  const personalizzazione = createPersonalizzazioneView({
    doc: document, mount: document.getElementById('mount'), client, navigate: () => {},
  });
  await personalizzazione.render();
  const tab = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Connettori');
  if (tab) tab.click();
  await new Promise((r) => setTimeout(r, 200));
}
await new Promise((r) => setTimeout(r, 300));
const raw = [...document.querySelectorAll('button,select,input,textarea')]
  .filter((n) => !String(n.className ?? '').split(/\\s+/).some((c) => c === 'ui' || c.startsWith('ui-')))
  .map((n) => n.tagName.toLowerCase() + '.' + String(n.className ?? '').split(/\\s+/).join('.'));
const probe = {
  ready: document.title,
  sections: document.querySelectorAll('.ui-section').length,
  controls: document.querySelectorAll('button,select,input,textarea').length,
  raw,
  scrollWidth: document.documentElement.scrollWidth,
};
document.getElementById('probe').textContent = JSON.stringify(probe);
document.title = view + '-ready';
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

function mkdirTmp() {
  const dir = join(tmpdir(), 'accordo-ui-shots');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readProbe(dom) {
  const probeHtml = dom.match(/<div id="probe">(.*?)<\/div>/)?.[1] ?? '';
  return JSON.parse(probeHtml.replace(/&quot;/g, '"'));
}

async function runBrowser({ view, width, height }) {
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
  const page = `http://127.0.0.1:${port}/harness.html?view=${view}`;
  const served = await fetch(page).then((response) => response.text());
  assert.ok(served.includes('admin-ui-catalog.js'), 'the harness serves the real catalog module');
  const out = join(mkdirTmp(), `ui-${view}-${width}x${height}.png`);
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

for (const view of ['catalog', 'oggi', 'personalizzazione']) {
  test(`the ${view} view paints with system controls: desktop PNG`, { skip: SHOTS_SKIP }, async () => {
    const { out, dom } = await runBrowser({ view, width: 1440, height: 900 });
    assert.ok(dom.includes(`<title>${view}-ready</title>`), 'the harness module ran to completion in the page');
    const shot = pngSize(out);
    assert.equal(shot.width, 1440, 'the PNG is the desktop viewport');
    assert.ok(shot.bytes > 20000, `the view paints real pixels (${shot.bytes} bytes)`);
    const probe = readProbe(dom);
    assert.ok(probe.controls > 0, 'the view renders controls');
    assert.deepEqual(probe.raw, [], `no control without a ui-* class (${probe.raw.join(', ')})`);
    console.log(`ui ${view} desktop PNG: ${out} (${shot.width}x${shot.height}, ${shot.bytes} bytes)`);
  });

  test(`the ${view} view paints with system controls: phone PNG without sideways scroll`, { skip: SHOTS_SKIP }, async () => {
    const { out, dom } = await runBrowser({ view, width: 390, height: 844 });
    assert.ok(dom.includes(`<title>${view}-ready</title>`), 'the harness module ran to completion in the page');
    const shot = pngSize(out);
    assert.equal(shot.width, 390, 'the PNG is the phone viewport');
    assert.ok(shot.bytes > 12000, `the view paints real pixels (${shot.bytes} bytes)`);
    const probe = readProbe(dom);
    assert.ok(probe.controls > 0, 'the view renders controls');
    assert.deepEqual(probe.raw, [], `no control without a ui-* class (${probe.raw.join(', ')})`);
    assert.ok(probe.scrollWidth <= 390, `no horizontal overflow at 390px (scrollWidth ${probe.scrollWidth})`);
    console.log(`ui ${view} phone PNG: ${out} (${shot.width}x${shot.height}, ${shot.bytes} bytes)`);
  });
}
