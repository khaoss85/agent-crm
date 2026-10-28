// @ts-check
/**
 * Browser proof for the backoffice Spazi e accessi view (screen 08,
 * backlog:5872e92b): the real `admin-spazi-accessi.js` module plus the real
 * `styles.css` render the spaces, the team and the AI switches inside a real
 * Chromium, once at a desktop viewport and once on a phone viewport. Each
 * run writes a PNG of the screen and reports its byte size and pixel
 * dimensions; the desktop run additionally asserts, from inside the page,
 * that team and AI panels sit side by side in one row, and the phone run
 * asserts that the stacked panels paint nothing sideways under 700px.
 *
 * The Chromium lookup mirrors scripts/site-shots.js (CHROMIUM_BIN, then the
 * Playwright headless-shell caches). Where no binary exists the test skips
 * with its reason instead of faking a pass: the CI runner is the Mac that
 * carries the cache, so the gate still sees a real browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

const FIXTURE_SCRIPT = `
import { createSpaziAccessiView } from './admin-spazi-accessi.js';
const SPACES = [
  { id: 'spazio-1', name: 'Negozio via Roma', initials: 'NE' },
  { id: 'spazio-2', name: 'Palestra centro', initials: 'PA' },
];
const MEMBERS = [
  { subject: 'owner-1', role: 'owner', status: 'active' },
  { subject: 'marco', role: 'operator', status: 'active' },
];
const client = {
  async request(path, options) {
    const opts = options || {};
    if (path === '/api/spine/context') {
      return { membership: { role: 'owner' }, roles: { owner: [], operator: [], observer: [] } };
    }
    if (path === '/api/spine/memberships' && String(opts.method || 'GET').toUpperCase() !== 'POST') {
      return { items: MEMBERS };
    }
    if (path.indexOf('/api/space-permissions/effective') === 0) {
      return { spaceId: 'spazio-1', overrides: [] };
    }
    if (path.indexOf('/api/connectors') === 0) {
      return { spaceId: 'spazio-1', connectors: [{ status: 'active' }, { status: 'active' }] };
    }
    if (path.indexOf('/api/customer-data/customers') === 0) {
      return { items: [], total: 3, totalIsExact: true, page: 1, pageSize: 10, pages: 1 };
    }
    throw new Error('unexpected ' + path);
  },
};
const view = createSpaziAccessiView({
  doc: document,
  mount: document.getElementById('mount'),
  client: client,
  spaces: function () { return SPACES; },
  activeSpaceId: function () { return 'spazio-1'; },
});
await view.render();
const panels = document.querySelector('.bo-spazi-panels');
const teamRect = document.querySelector('.bo-spazi-team-panel')
  ? document.querySelector('.bo-spazi-team-panel').getBoundingClientRect()
  : null;
const aiRect = document.querySelector('.bo-spazi-ai-panel')
  ? document.querySelector('.bo-spazi-ai-panel').getBoundingClientRect()
  : null;
const probe = {
  spaces: document.querySelectorAll('.bo-spazi-card').length,
  here: document.querySelector('.bo-spazi-here')
    ? document.querySelector('.bo-spazi-here').textContent : null,
  members: document.querySelectorAll('.bo-spazi-member').length,
  avatars: document.querySelectorAll('.bo-spazi-avatar').length,
  avatarText: document.querySelector('.bo-spazi-avatar')
    ? document.querySelector('.bo-spazi-avatar').textContent : null,
  pills: document.querySelectorAll('.bo-spazi-role').length,
  pillText: document.querySelector('.bo-spazi-role')
    ? document.querySelector('.bo-spazi-role').textContent : null,
  switches: document.querySelectorAll('button[role="switch"]').length,
  panelsDirection: panels ? getComputedStyle(panels).flexDirection : null,
  teamTop: teamRect ? Math.round(teamRect.top) : null,
  aiTop: aiRect ? Math.round(aiRect.top) : null,
  scrollWidth: document.documentElement.scrollWidth,
  innerWidth: window.innerWidth,
};
document.getElementById('probe').textContent = JSON.stringify(probe);
document.title = 'spazi-ready';
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
  assert.ok(served.includes('admin-spazi-accessi.js'), 'the harness serves the real view module');
  const out = join(mkdirTmp(), `spazi-${width}x${height}.png`);
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
  const dir = join(tmpdir(), 'accordo-spazi-shots');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** @param {string} html */
function readProbe(html) {
  const probeHtml = html.match(/<div id="probe">(.*?)<\/div>/)?.[1] ?? '';
  return JSON.parse(probeHtml.replace(/&quot;/g, '"'));
}

test('the spazi screen renders in a real browser: desktop PNG, team and AI side by side', { skip: CHROMIUM ? false : 'no Chromium binary (set CHROMIUM_BIN)' }, async () => {
  const { out, dom } = await runBrowser({ width: 1280, height: 900 });
  assert.ok(dom.includes('<title>spazi-ready</title>'), 'the harness module ran to completion in the page');
  const probe = readProbe(dom);
  assert.equal(probe.spaces, 2, 'both space cards render');
  assert.match(probe.here ?? '', /Stai lavorando qui/, 'the active space is marked');
  assert.equal(probe.members, 2, 'both team members render');
  assert.equal(probe.avatars, 2, 'every member has an avatar');
  assert.equal(probe.pills, 2, 'every member has a role pill');
  assert.equal(probe.switches, 5, 'the five AI switches render');
  assert.equal(probe.panelsDirection, 'row', 'team and AI panels share one row on desktop');
  assert.equal(probe.teamTop, probe.aiTop, 'team and AI panels start on the same row');
  const shot = pngSize(out);
  assert.equal(shot.width, 1280, 'the PNG is the desktop viewport');
  assert.ok(shot.bytes > 30000, `the screen paints real pixels (${shot.bytes} bytes)`);
  writeFileSync(join(mkdirTmp(), 'spazi-desktop-probe.json'), JSON.stringify({ probe, shot }, null, 2));
  console.log(`spazi desktop PNG: ${out} (${shot.width}x${shot.height}, ${shot.bytes} bytes)`);
});

test('the spazi screen renders in a real browser: phone PNG without sideways scroll', { skip: CHROMIUM ? false : 'no Chromium binary (set CHROMIUM_BIN)' }, async () => {
  const { out, dom } = await runBrowser({ width: 390, height: 844 });
  assert.ok(dom.includes('<title>spazi-ready</title>'), 'the harness module ran to completion in the page');
  const probe = readProbe(dom);
  assert.equal(probe.members, 2, 'the phone render holds the team');
  assert.equal(probe.switches, 5, 'the phone render holds the five AI switches');
  assert.equal(probe.panelsDirection, 'column', 'the panels stack in one column on the phone');
  assert.ok(probe.scrollWidth <= 390, `no horizontal overflow at 390px (scrollWidth ${probe.scrollWidth})`);
  const shot = pngSize(out);
  assert.equal(shot.width, 390, 'the PNG is the phone viewport');
  assert.ok(shot.bytes > 20000, `the screen paints real pixels (${shot.bytes} bytes)`);
  writeFileSync(join(mkdirTmp(), 'spazi-phone-probe.json'), JSON.stringify({ probe, shot }, null, 2));
  console.log(`spazi phone PNG: ${out} (${shot.width}x${shot.height}, ${shot.bytes} bytes)`);
});
