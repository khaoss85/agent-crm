// @ts-check
/**
 * Browser proof for the backoffice Oggi view (BO-F6-07, backlog:aede607c82a2,
 * segue #386): the real `admin-oggi.js` module plus the real `styles.css`
 * render the advisor screen inside a real Chromium, once at a desktop
 * viewport and once on a phone viewport. Each run reports the painted DOM
 * probe and the PNG size; the phone run additionally asserts that the page
 * fits without sideways scrolling and that every card keeps its Domani and
 * primary-action buttons visible (spec C27-C28: at 390 the prototype itself
 * cuts text, the product rule is one column with no cuts).
 *
 * The page under test is the shared `harnessHtml('oggi')` from
 * scripts/bo-shots.js — byte for byte the same render the `npm run bo:shots`
 * CI workflow paints — with one appended module script that records layout
 * metrics (scroll fit, Domani/action counts, painted sections) into the same
 * hidden #probe div, so `readProbe`/`assertProbe` keep gating the demo data
 * while this file gates the layout.
 *
 * The Chromium gate reuses scripts/bo-shots.js (findChromium, then the
 * chromiumRuns launch probe, like tests/bo-shots.test.js): a present binary
 * is not a runnable one in a sandbox, so where Chromium does not actually
 * run the tests skip with their reason instead of faking a pass. The Mac CI
 * runner carries a working Chromium, so the gate still sees a real browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DESKTOP,
  PHONE,
  assertProbe,
  chromiumRuns,
  findChromium,
  harnessHtml,
  readProbe,
} from '../scripts/bo-shots.js';

const CHROMIUM = findChromium();
const BROWSER_SKIP = chromiumRuns(CHROMIUM)
  ? false
  : 'no runnable Chromium here (set CHROMIUM_BIN); the Mac CI runner produces the PNGs';

const publicDir = new URL('../apps/admin/public/', import.meta.url).pathname;

// Runs after the harness module (module scripts execute in order), so the
// Oggi view is already painted when the metrics are collected.
const METRICS_SCRIPT = `<script type="module">
const view = document.getElementById('view-module');
const text = view ? view.textContent : '';
const probe = JSON.parse(document.getElementById('probe').textContent || '{}');
try {
  const buttons = view ? [...view.querySelectorAll('button')] : [];
  probe.metrics = {
    fits: document.documentElement.scrollWidth <= window.innerWidth,
    h1: view ? view.querySelectorAll('h1').length : 0,
    domani: buttons.filter((button) => button.getAttribute('data-triage') === 'postpone').length,
    actions: buttons.filter((button) => button.getAttribute('data-triage') === 'execute').length,
    agenda: text.includes('Agenda di oggi'),
    agendaLink: text.includes('Apri il calendario'),
    brief: text.includes('Prima della prossima call'),
    briefCta: text.includes('Apri la scheda'),
    banner: /di 9 collegati/.test(text),
  };
} catch (error) {
  probe.metricsError = String(error && error.message ? error.message : error);
}
document.getElementById('probe').textContent = JSON.stringify(probe);
</script>`;

function shotPage() {
  return harnessHtml('oggi', publicDir).replace('</body>', `${METRICS_SCRIPT}</body>`);
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
    if (url.pathname === '/shot-oggi.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(shotPage());
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
  const page = `http://127.0.0.1:${port}/shot-oggi.html`;
  // The browser reads the fixture from this process: prove the fixture
  // serves before launching anything, so a browser-env failure can never
  // disguise itself as a passing render.
  const served = await fetch(page).then((response) => response.text());
  assert.ok(served.includes('admin-oggi.js'), 'the harness serves the real view module');
  const out = join(mkdirTmp(), `oggi-${width}x${height}.png`);
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
  const dir = join(tmpdir(), 'accordo-oggi-shots');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {string} dom
 * @param {string} where
 */
function oggiMetrics(dom, where) {
  assert.ok(dom.includes('<title>oggi-ready</title>'), `${where}: the harness module ran to completion in the page`);
  const probe = readProbe(dom, 'oggi');
  assertProbe('oggi', probe);
  assert.ok(!probe.metricsError, `${where}: the metrics script ran clean (${probe.metricsError ?? 'no error'})`);
  const metrics = probe.metrics ?? {};
  assert.equal(metrics.h1, 1, `${where}: the greeting stays the single h1 (spec C6)`);
  assert.ok(metrics.domani >= 2, `${where}: every open card keeps its Domani button (saw ${metrics.domani})`);
  assert.ok(metrics.actions >= 2, `${where}: every open card keeps its primary action (saw ${metrics.actions})`);
  assert.equal(metrics.agenda, true, `${where}: the agenda card paints (spec C15)`);
  assert.equal(metrics.agendaLink, true, `${where}: the agenda links to the calendar (spec C16)`);
  assert.equal(metrics.brief, true, `${where}: the pre-call brief paints (spec C17)`);
  assert.equal(metrics.briefCta, true, `${where}: the brief opens the customer card (spec C19)`);
  assert.equal(metrics.banner, true, `${where}: the connections banner counts out of nine (spec C20)`);
  return metrics;
}

test('the oggi screen renders in a real browser: desktop PNG', { skip: BROWSER_SKIP }, async () => {
  const { out, dom } = await runBrowser({ width: DESKTOP.width, height: DESKTOP.height });
  const shot = pngSize(out);
  assert.equal(shot.width, 1440, 'the PNG is the desktop viewport');
  assert.ok(shot.bytes > 60000, `the screen paints real pixels (${shot.bytes} bytes)`);
  const metrics = oggiMetrics(dom, 'desktop');
  assert.equal(metrics.fits, true, 'desktop: no sideways scroll at 1440 (spec C25)');
  console.log(`oggi desktop PNG: ${out} (${shot.width}x${shot.height}, ${shot.bytes} bytes)`);
});

test('the oggi screen renders in a real browser: phone PNG without sideways scroll', { skip: BROWSER_SKIP }, async () => {
  const { out, dom } = await runBrowser({ width: PHONE.width, height: PHONE.height });
  const shot = pngSize(out);
  assert.equal(shot.width, 390, 'the PNG is the phone viewport');
  assert.ok(shot.bytes > 20000, `the screen paints real pixels (${shot.bytes} bytes)`);
  const metrics = oggiMetrics(dom, 'phone');
  assert.equal(metrics.fits, true, 'phone: one column, no sideways scroll at 390 (spec C27)');
  console.log(`oggi phone PNG: ${out} (${shot.width}x${shot.height}, ${shot.bytes} bytes)`);
});
