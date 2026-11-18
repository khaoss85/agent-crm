// @ts-check
/**
 * backlog:667f1f1c — VERIFIER_BACK 2026-11-18 (returns: 2): the verifier
 * failed the delivery on a real Mac because two painted rows were cut in
 * half (a 15-min block whose line leaves its box, a 60-min block whose
 * second title line and initials dot leave the box) and because the proof
 * never ran in a browser.
 *
 * This test renders the real `admin-calendario.js` module plus the real
 * `styles.css` inside a real Chromium (desktop 1280px and phone 390px) and
 * measures every painted row with getBoundingClientRect against its own
 * block: no painted row may leave the block, a badge must stay inside the
 * block to count as readable, the 60-min title stays on one line and its
 * foot paints only when it fits whole.
 *
 * Red on the code before the cure (title on two lines, foot overflowing the
 * 60-min block, 15-min line and badges out of the box), green after it.
 * Where no runnable Chromium exists the tests skip with their reason
 * instead of faking a pass: the Mac CI runner carries the cache and runs
 * them for real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMIN_WRITE_GATE_BROWSER_PRELUDE, enforceAdminWriteGate } from './helpers/admin-strict-client.js';

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
const BROWSER_SKIP = CHROMIUM_RUNS ? false : 'Chromium binary missing or unrunnable here (set CHROMIUM_BIN); the Mac CI runner produces the proof';

// Rome is UTC+2 in October 2026: 08:00Z reads 10:00 on the grid.
const WEEK = {
  from: '2026-10-19T00:00:00.000Z',
  to: '2026-10-26T00:00:00.000Z',
  members: [{
    teamMemberId: 'marco',
    appointments: [
      {
        id: 'r15', status: 'booked',
        startsAt: '2026-10-22T08:00:00.000Z', endsAt: '2026-10-22T08:15:00.000Z',
        serviceKey: 'taglio', teamMemberId: 'marco', priceCents: 3000, currency: 'EUR', notes: null,
        sourceKey: 'gcal:cal:evt-r15',
        subject: { resource: 'contact', id: 'c-r15', owner: 'host', ownerPackage: null, label: 'Cliente con un nome molto lungo da troncare' },
      },
      {
        // A short block with two badges (origin + state): the review P2 on
        // this item. Cancelled rows leave the grid by design
        // (backlog:5346ab531538), so the state badge here is «svolto».
        id: 'r15x', status: 'done',
        startsAt: '2026-10-22T08:30:00.000Z', endsAt: '2026-10-22T08:45:00.000Z',
        serviceKey: 'barba', teamMemberId: 'marco', priceCents: 2000, currency: 'EUR', notes: null,
        sourceKey: 'booking-link:evt-r15x',
        subject: { resource: 'contact', id: 'c-r15x', owner: 'host', ownerPackage: null, label: 'Altro cliente dal nome lunghissimo' },
      },
      {
        id: 'r30', status: 'booked',
        startsAt: '2026-10-22T09:00:00.000Z', endsAt: '2026-10-22T09:30:00.000Z',
        serviceKey: 'taglio', teamMemberId: 'marco', priceCents: 3000, currency: 'EUR', notes: null,
        sourceKey: 'calendario:marco:9:c-r30',
        subject: { resource: 'contact', id: 'c-r30', owner: 'host', ownerPackage: null, label: 'Un altro cliente col nome lunghissimo' },
      },
      {
        id: 'r60', status: 'booked',
        startsAt: '2026-10-22T12:00:00.000Z', endsAt: '2026-10-22T13:00:00.000Z',
        serviceKey: 'piega', teamMemberId: 'marco', priceCents: 3000, currency: 'EUR', notes: null,
        sourceKey: 'calendario:marco:12:c-r60',
        subject: { resource: 'contact', id: 'c-r60', owner: 'host', ownerPackage: null, label: 'Cliente con un nome molto lungo da andare a capo' },
      },
      {
        id: 'r90', status: 'booked',
        startsAt: '2026-10-22T13:00:00.000Z', endsAt: '2026-10-22T14:30:00.000Z',
        serviceKey: 'taglio', teamMemberId: 'marco', priceCents: 3000, currency: 'EUR', notes: null,
        sourceKey: 'calendario:marco:13:c-r90',
        subject: { resource: 'contact', id: 'c-r90', owner: 'host', ownerPackage: null, label: 'Ada' },
      },
      {
        id: 'r180', status: 'booked',
        startsAt: '2026-10-22T07:00:00.000Z', endsAt: '2026-10-22T10:00:00.000Z',
        serviceKey: 'taglio', teamMemberId: 'marco', priceCents: 3000, currency: 'EUR', notes: null,
        sourceKey: 'calendario:marco:7:c-r180',
        subject: { resource: 'contact', id: 'c-r180', owner: 'host', ownerPackage: null, label: 'Bo' },
      },
    ],
  }],
};

const FIXTURE_SCRIPT = `
${ADMIN_WRITE_GATE_BROWSER_PRELUDE}
const WEEK = ${JSON.stringify(WEEK)};
const fail = (error) => {
  document.getElementById('probe').textContent = JSON.stringify({ harnessError: String((error && error.stack) || error) });
  document.title = 'righe-error';
};
try {
const { createCalendarioView } = await import('./admin-calendario.js');
const client = {
  async request(path, options = {}) {
    enforceAdminWriteGate(path, options);
    if (path.startsWith('/api/appointments/team-week')) return JSON.parse(JSON.stringify(WEEK));
    if (path.startsWith('/api/catalog/products')) return { products: [{ sku: 'taglio', name: 'Taglio' }, { sku: 'barba', name: 'Barba' }, { sku: 'piega', name: 'Piega' }] };
    if (path.startsWith('/api/customer-data/profile/')) {
      const error = new Error('no profile');
      error.code = 'NOT_FOUND';
      error.status = 404;
      throw error;
    }
    throw new Error('unexpected ' + path);
  },
};
const byName = (name) => document.querySelector('[name="' + name + '"]');
const view = createCalendarioView({ searchDelayMs: 0,
  doc: document,
  mount: document.getElementById('mount'),
  client,
  now: () => new Date('2026-10-21T06:00:00Z'),
});
await view.render();
byName('members').value = 'marco';
byName('members').dispatchEvent(new Event('input', { bubbles: true }));
[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Mostra settimana')).click();
await new Promise((r) => setTimeout(r, 200));
await new Promise((r) => setTimeout(r, 200));
const rect = (node) => {
  if (!node) return null;
  const box = node.getBoundingClientRect();
  return { top: Math.round(box.top * 10) / 10, bottom: Math.round(box.bottom * 10) / 10,
    left: Math.round(box.left * 10) / 10, right: Math.round(box.right * 10) / 10,
    height: Math.round(box.height * 10) / 10, width: Math.round(box.width * 10) / 10 };
};
const probeBlock = (id) => {
  const node = document.querySelector('[data-event-id="' + id + '"]');
  if (!node) return null;
  const box = rect(node);
  const line = node.querySelector('.cal-compact') ?? node.querySelector('strong');
  const time = node.querySelector('.cal-time');
  const tops = [line, time].filter(Boolean).map((n) => n.getBoundingClientRect().top);
  const badges = [...node.querySelectorAll('.cal-line-badges span')].map((n) => ({
    text: n.textContent, box: rect(n),
  }));
  const foot = node.querySelector('.cal-day-foot');
  const lineStyle = line ? getComputedStyle(line) : null;
  return {
    box,
    overflow: Math.round((node.scrollHeight - node.clientHeight) * 10) / 10,
    clientH: node.clientHeight, scrollH: node.scrollHeight,
    blockStyle: (() => { const cs = getComputedStyle(node); return { padding: cs.paddingTop + ' ' + cs.paddingBottom, margin: cs.marginTop + ' ' + cs.marginBottom, display: cs.display, align: cs.alignContent + '/' + cs.justifyContent, place: cs.placeContent }; })(),
    kids: [...node.children].filter((n) => getComputedStyle(n).position !== 'absolute').map((n) => ({ cls: n.className, top: Math.round((n.getBoundingClientRect().top - box.top) * 10) / 10, bottom: Math.round((n.getBoundingClientRect().bottom - box.top) * 10) / 10 })),
    line: line ? rect(line) : null,
    lineHeight: lineStyle ? Math.round(parseFloat(lineStyle.lineHeight) * 10) / 10 : null,
    contentTop: tops.length > 0 ? Math.round((Math.min(...tops) - box.top) * 10) / 10 : null,
    badges,
    foot: foot ? rect(foot) : null,
    avatar: Boolean(node.querySelector('.cal-avatar')),
  };
};
const probe = {
  days: document.querySelectorAll('.cal-day').length,
  blocks: ['r15', 'r15x', 'r30', 'r60', 'r90', 'r180'].map((id) => ({ id, ...probeBlock(id) })),
  scrollWidth: document.documentElement.scrollWidth,
  innerWidth: window.innerWidth,
};
document.getElementById('probe').textContent = JSON.stringify(probe);
document.title = 'righe-ready';
} catch (error) { fail(error); }
`;

function harnessHtml() {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<link rel="stylesheet" href="/styles.css"></head>`
    + `<body><div id="mount"></div><div id="probe"></div>`
    + `<script type="module">${FIXTURE_SCRIPT}</script></body></html>`;
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
    const url = new URL(req.url ?? '/', 'http://righe.test');
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
  const page = `http://127.0.0.1:${address.port}/harness.html`;
  const served = await fetch(page).then((response) => response.text());
  assert.ok(served.includes('admin-calendario.js'), 'the harness serves the real view module');
  const out = join(mkdirTmp(), `cal-righe-${width}x${height}.png`);
  try {
    const run = await runChromium([
      '--headless',
      `--screenshot=${out}`,
      `--window-size=${width},${height}`,
      '--hide-scrollbars',
      '--virtual-time-budget=8000',
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
  const dir = join(tmpdir(), 'accordo-cal-righe');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readProbe(dom) {
  const probeHtml = dom.match(/<div id="probe">(.*?)<\/div>/)?.[1] ?? '';
  return JSON.parse(probeHtml.replace(/&quot;/g, '"'));
}

/** @param {any} probe @param {string} id */
function blockOf(probe, id) {
  const found = probe.blocks.find((entry) => entry.id === id);
  assert.ok(found && found.box, `the ${id} block paints in the browser`);
  return found;
}

// A badge counts as readable only inside its block: present in the DOM but
// clipped by the block edge is the P2 the review caught on this item.
// @param {any} found @param {number} lane
function assertBadgesInside(found, lane) {
  assert.ok(found.badges.length > 0, `${found.id}: the badges paint (desktop ${lane}px)`);
  for (const badge of found.badges) {
    assert.ok(badge.box.right <= found.box.right + 1,
      `${found.id}: «${badge.text}» stays inside the block (${badge.box.right} <= ${found.box.right})`);
    assert.ok(badge.box.bottom <= found.box.bottom + 1,
      `${found.id}: «${badge.text}» is never cut in half (${badge.box.bottom} <= ${found.box.bottom})`);
  }
}

test('667f1f1c: calendar rows never paint half-cut in a real Chromium (desktop)', { skip: BROWSER_SKIP }, async () => {
  const { out, dom } = await runBrowser({ width: 1280, height: 900 });
  const probe = readProbe(dom);
  assert.ok(dom.includes('<title>righe-ready</title>'), `the harness module ran to completion in the page: ${JSON.stringify(probe).slice(0, 2000)}`);
  assert.equal(probe.days, 5, 'the week holds five work-day columns');
  // A 15-min block is one painted line: the line fits whole in its box.
  const r15 = blockOf(probe, 'r15');
  assert.ok(r15.overflow <= 1, `r15: the block clips nothing (${r15.overflow}px over)`);
  assert.ok(r15.line.bottom <= r15.box.bottom + 1, `r15: the line is never cut in half (${r15.line.bottom} <= ${r15.box.bottom})`);
  assertBadgesInside(r15, 1280);
  // A 15-min block with two badges still names origin and state inside the box.
  const r15x = blockOf(probe, 'r15x');
  assert.ok(r15x.overflow <= 1, `r15x: the block clips nothing (${r15x.overflow}px over)`);
  assertBadgesInside(r15x, 1280);
  // A 30-min block reads «Titolo, 12:00» on one dotted line.
  const r30 = blockOf(probe, 'r30');
  assert.ok(r30.overflow <= 1, `r30: the block clips nothing (${r30.overflow}px over)`);
  assert.ok(r30.line.height <= r30.lineHeight * 1.5, `r30: one line only (${r30.line.height}px over ${r30.lineHeight}px)`);
  assert.ok(r30.line.bottom <= r30.box.bottom + 1, `r30: the line is never cut in half`);
  // A 60-min block with a long title: one line, and the foot goes away
  // because the initials dot cannot fit whole beside it.
  const r60 = blockOf(probe, 'r60');
  assert.ok(r60.overflow <= 1, `r60: the block clips nothing (${r60.overflow}px over)`);
  assert.ok(r60.line.height <= r60.lineHeight * 1.5, `r60: the title stays on one line (${r60.line.height}px over ${r60.lineHeight}px)`);
  assert.ok(r60.foot === null || r60.foot.bottom <= r60.box.bottom + 1,
    `r60: the foot paints only where it fits whole (${JSON.stringify(r60.foot)} in ${JSON.stringify(r60.box)})`);
  assert.ok(!r60.avatar || (r60.foot !== null && r60.foot.bottom <= r60.box.bottom + 1),
    'r60: the initials dot is never cut in half');
  // A 90-min block with a short title keeps its dot, whole inside the box.
  const r90 = blockOf(probe, 'r90');
  assert.equal(r90.avatar, true, 'r90: the initials dot paints where it fits');
  assert.ok(r90.foot && r90.foot.bottom <= r90.box.bottom + 1, 'r90: the foot fits whole in the block');
  assert.ok(r90.overflow <= 1, `r90: the block clips nothing (${r90.overflow}px over)`);
  // A long block starts its text at the top, never halfway down.
  const r180 = blockOf(probe, 'r180');
  assert.ok(r180.contentTop !== null && r180.contentTop <= 12, `r180: the text starts at the top (${r180.contentTop}px: ${JSON.stringify(r180)})`);
  assert.ok(r180.overflow <= 1, `r180: the block clips nothing (${r180.overflow}px over)`);
  console.log(`cal-righe desktop PNG: ${out} (${probe.innerWidth}px viewport)`);
});

test('667f1f1c: calendar rows never paint half-cut in a real Chromium (phone)', { skip: BROWSER_SKIP }, async () => {
  const { out, dom } = await runBrowser({ width: 390, height: 844 });
  assert.ok(dom.includes('<title>righe-ready</title>'), 'the harness module ran to completion in the page');
  const probe = readProbe(dom);
  assert.ok(probe.scrollWidth <= 390, `no horizontal page overflow at 390px (scrollWidth ${probe.scrollWidth})`);
  for (const id of ['r15', 'r15x', 'r30', 'r60', 'r90', 'r180']) {
    const found = blockOf(probe, id);
    assert.ok(found.overflow <= 1, `${id}: the block clips nothing on the phone (${found.overflow}px over: ${JSON.stringify(found)})`);
    assert.ok(!found.line || found.line.bottom <= found.box.bottom + 1, `${id}: no line cut in half on the phone`);
  }
  const desktop = blockOf(probe, 'r15');
  assert.ok(desktop.badges.length > 0, 'r15: the origin badge paints on the phone too');
  console.log(`cal-righe phone PNG: ${out} (${probe.innerWidth}px viewport)`);
});
