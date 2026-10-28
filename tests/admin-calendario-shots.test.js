// @ts-check
/**
 * Browser proof for the backoffice Calendario view (screen 07): the real
 * `admin-calendario.js` module plus the real `styles.css` render the team
 * week inside a real Chromium, once at a desktop viewport and once on a
 * phone viewport. The harness loads a week for two named members through
 * the view's own "Mostra settimana" button, searches free slots through
 * "Trova slot liberi" from a phrase, so the PNG shows the week, the proposal
 * rows with their ghosts and the prefilled manual form. Each run writes a PNG of the
 * painted week and reports its byte size and pixel dimensions; the phone
 * run additionally asserts, from inside the page, that nothing scrolls
 * sideways under 700px.
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

const WEEK = {
  from: '2026-10-19T00:00:00.000Z',
  to: '2026-10-26T00:00:00.000Z',
  members: [
    {
      teamMemberId: 'marco',
      appointments: [
        {
          id: 'a1',
          status: 'booked',
          startsAt: '2026-10-22T16:00:00.000Z',
          endsAt: '2026-10-22T16:30:00.000Z',
          serviceKey: 'taglio',
          teamMemberId: 'marco',
          priceCents: 4500,
          currency: 'EUR',
          notes: null,
          sourceKey: 'calendario:marco:1:c1',
          subject: { resource: 'contact', id: 'c1', owner: 'host', ownerPackage: null, label: 'Ada' },
        },
      ],
    },
    {
      teamMemberId: 'sara',
      appointments: [
        {
          id: 'a2',
          status: 'booked',
          startsAt: '2026-10-23T07:00:00.000Z',
          endsAt: '2026-10-23T07:30:00.000Z',
          serviceKey: 'barba',
          teamMemberId: 'sara',
          priceCents: 2000,
          currency: 'EUR',
          notes: null,
          sourceKey: 'calendario:sara:1:c2',
          subject: { resource: 'contact', id: 'c2', owner: 'host', ownerPackage: null, label: 'Bo' },
        },
      ],
    },
  ],
};

const SLOTS = [
  { startsAt: '2026-10-22T16:00:00.000Z', endsAt: '2026-10-22T16:30:00.000Z' },
  { startsAt: '2026-10-22T17:00:00.000Z', endsAt: '2026-10-22T17:30:00.000Z' },
];

const DRAFT = {
  teamMemberId: 'marco',
  serviceKey: 'taglio',
  startsAt: '2026-10-22T16:00:00.000Z',
  endsAt: '2026-10-22T16:30:00.000Z',
  notes: 'taglio per Ada',
};

const FIXTURE_SCRIPT = `
import { createCalendarioView } from './admin-calendario.js';
const WEEK = ${JSON.stringify(WEEK)};
const SLOTS = ${JSON.stringify(SLOTS)};
const DRAFT = ${JSON.stringify(DRAFT)};
const client = {
  async request(path) {
    if (path.startsWith('/api/appointments/team-week')) return WEEK;
    if (path === '/api/appointments/phrase') return { draft: DRAFT, dryRun: false, spaceId: 'demo' };
    if (path.startsWith('/api/appointments/suggest-slots')) {
      return { from: '', to: '', slotMinutes: 30, members: [{ teamMemberId: 'marco', slots: SLOTS }] };
    }
    throw new Error('unexpected ' + path);
  },
};
const byName = (name) => document.querySelector('input[name="' + name + '"]');
const click = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(label)).click();
const view = createCalendarioView({
  doc: document,
  mount: document.getElementById('mount'),
  client,
  // Pin Rome time like the unit tests: the fixture week is Oct 2026, so the
  // painted week must be that one whatever day the CI runner boots on.
  now: () => new Date('2026-10-25T10:00:00Z'),
});
await view.render();
byName('members').value = 'marco, sara';
byName('members').dispatchEvent(new Event('input', { bubbles: true }));
click('Mostra settimana');
await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 100));
document.querySelector('textarea[name="phrase"]').value = 'trova 30 minuti con marco';
click('Trova slot liberi');
await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 100));
// No Conferma click here: booking belongs to the operator, and the demo
// client answers no confirm endpoint — the PNG proves rows and ghosts.
const probe = {
  days: document.querySelectorAll('.cal-day').length,
  events: [...document.querySelectorAll('.cal-event strong')].map((n) => n.textContent),
  lede: document.querySelector('.cal-wrap .lede') ? document.querySelector('.cal-wrap .lede').textContent : null,
  filled: byName('teamMemberId').value + '|' + byName('date').value + '|' + byName('start').value,
  proposals: [...document.querySelectorAll('.cal-slots button')].filter((b) => b.textContent === 'Conferma').length,
  ghosts: [...document.querySelectorAll('button')].filter((b) => b.textContent.startsWith('✦ Proposta')).length,
  scrollWidth: document.documentElement.scrollWidth,
  innerWidth: window.innerWidth,
};
document.getElementById('probe').textContent = JSON.stringify(probe);
document.title = 'calendario-ready';
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
  assert.ok(served.includes('admin-calendario.js'), 'the harness serves the real view module');
  const out = join(mkdirTmp(), `cal-week-${width}x${height}.png`);
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
  const dir = join(tmpdir(), 'accordo-cal-shots');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readProbe(dom) {
  const probeHtml = dom.match(/<div id="probe">(.*?)<\/div>/)?.[1] ?? '';
  return JSON.parse(probeHtml.replace(/&quot;/g, '"'));
}

test('the team week renders in a real browser: desktop PNG', { skip: SHOTS_SKIP }, async () => {
  const { out, dom } = await runBrowser({ width: 1280, height: 900 });
  assert.ok(dom.includes('<title>calendario-ready</title>'), 'the harness module ran to completion in the page');
  const shot = pngSize(out);
  assert.equal(shot.width, 1280, 'the PNG is the desktop viewport');
  assert.ok(shot.bytes > 30000, `the week paints real pixels (${shot.bytes} bytes)`);
  const probe = readProbe(dom);
  assert.equal(probe.days, 5, 'the week holds five work-day columns');
  assert.ok(probe.lede?.includes('19 ott'), `the painted nav names the pinned week (${probe.lede})`);
  assert.ok(probe.events.includes('taglio'), 'the desktop render lists the week events');
  assert.ok(probe.filled.startsWith('marco|2026-10-22|'), `the interpreted draft prefills the manual form (${probe.filled})`);
  assert.equal(probe.proposals, 2, 'two proposal rows, one Conferma each');
  assert.equal(probe.ghosts, 2, 'two dashed ghosts on the Thursday column');
  console.log(`calendario desktop PNG: ${out} (${shot.width}x${shot.height}, ${shot.bytes} bytes)`);
});

test('the team week renders in a real browser: phone PNG without sideways scroll', { skip: SHOTS_SKIP }, async () => {
  const { out, dom } = await runBrowser({ width: 390, height: 844 });
  const shot = pngSize(out);
  assert.equal(shot.width, 390, 'the PNG is the phone viewport');
  assert.ok(shot.bytes > 20000, `the week paints real pixels (${shot.bytes} bytes)`);
  assert.ok(dom.includes('<title>calendario-ready</title>'), 'the harness module ran to completion in the page');
  const probe = readProbe(dom);
  assert.ok(probe.events.includes('taglio'), 'the phone render lists the week events');
  assert.ok(probe.scrollWidth <= 390, `no horizontal overflow at 390px (scrollWidth ${probe.scrollWidth})`);
  console.log(`calendario phone PNG: ${out} (${shot.width}x${shot.height}, ${shot.bytes} bytes)`);
});
