// @ts-check
/**
 * Browser proof for the scheda cliente layout (backlog:f32824784d04): the
 * real /bo shell, the real `admin-customer-card.js` and the real
 * `styles.css` render the bo:shots «cliente» harness inside a real
 * Chromium at 1280 and at 1440 px. The page measures itself: the central
 * column («Tutti i contatti») is the widest, at least half of the grid,
 * and the note field shows its whole placeholder.
 *
 * Production 11/11 at 1280: the central column was 324 px, as narrow as
 * the side ones (292 and 300), and the note placeholder was cut.
 *
 * The Chromium gate reuses scripts/bo-shots.js like the other *-shots
 * tests: where Chromium does not run, the test skips with its reason.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromiumFlags, chromiumRuns, findChromium, harnessHtml } from '../scripts/bo-shots.js';

const CHROMIUM = findChromium();
const BROWSER_SKIP = chromiumRuns(CHROMIUM)
  ? false
  : 'no runnable Chromium here (set CHROMIUM_BIN); the Mac CI runner measures the layout';

const PUBLIC_DIR = fileURLToPath(new URL('../apps/admin/public', import.meta.url));
const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

// Runs after the harness: waits for the scheda, then measures it.
const MEASURE = `<div id="geo" hidden></div><script type="module">
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (let i = 0; i < 200 && document.title !== 'cliente-ready'; i += 1) await wait(20);
const grid = document.querySelector('.bo-scheda-grid');
const cols = grid ? Array.from(grid.children).map((col) => Math.round(col.getBoundingClientRect().width)) : [];
const note = document.querySelector('[name="noteBody"]');
let placeholder = null;
if (note) {
  const style = getComputedStyle(note);
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = style.font;
  const room = note.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  placeholder = { text: Math.ceil(ctx.measureText(note.placeholder).width), room: Math.floor(room) };
}
document.getElementById('geo').textContent = JSON.stringify({
  ready: document.title,
  grid: grid ? Math.round(grid.getBoundingClientRect().width) : null,
  cols,
  placeholder,
  sideOverflow: grid ? Array.from(grid.children).filter((col, index) => index !== 1)
    .flatMap((col) => Array.from(col.querySelectorAll('*')))
    .filter((node) => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX === 'visible' && node.clientWidth > 0)
    .map((node) => (node.className || node.tagName) + ':' + node.scrollWidth + '>' + node.clientWidth).slice(0, 5) : [],
  scrollWidth: document.documentElement.scrollWidth,
  innerWidth: window.innerWidth,
});
document.title = 'geo-ready';
</script>`;

function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://shot.test');
    if (url.pathname === '/shot-cliente.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(harnessHtml('cliente', PUBLIC_DIR).replace('</body>', `${MEASURE}</body>`));
      return;
    }
    const relative = normalize(url.pathname.replace(/^\/+/, ''));
    const file = join(PUBLIC_DIR, relative);
    const extension = relative.includes('.') ? `.${relative.split('.').pop()}` : '';
    if (relative === '' || relative.startsWith('..') || !file.startsWith(PUBLIC_DIR + sep) || !existsSync(file)) {
      res.writeHead(404);
      res.end('no');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extension] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function dumpDom(binary, url, width) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [
      '--headless', ...chromiumFlags(binary), '--dump-dom',
      `--window-size=${width},900`, '--virtual-time-budget=8000', '--hide-scrollbars',
      '--disable-background-networking', url,
    ]);
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('chromium timed out')); }, 120000);
    child.on('error', reject);
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

async function measure(width) {
  const server = /** @type {import('node:http').Server} */ (await serve());
  try {
    const address = /** @type {import('node:net').AddressInfo} */ (server.address());
    const dom = await dumpDom(CHROMIUM, `http://127.0.0.1:${address.port}/shot-cliente.html`, width);
    const match = String(dom).match(/<div id="geo" hidden="">(.*?)<\/div>/s);
    assert.ok(match, `the page measured itself at ${width}px`);
    return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  } finally {
    server.close();
  }
}

for (const width of [1200, 1280, 1440, 1920]) {
  test(`f32824784d04: at ${width}px the central column is the widest, at least half the grid, and the note placeholder fits`, { skip: BROWSER_SKIP }, async () => {
    const geo = await measure(width);
    assert.equal(geo.ready, 'cliente-ready', 'the scheda rendered');
    assert.equal(geo.cols.length, 3, JSON.stringify(geo));
    const [left, center, right] = geo.cols;
    assert.ok(center > left && center > right, `the central column is the widest: ${JSON.stringify(geo.cols)}`);
    assert.ok(center >= geo.grid / 2, `the central column holds at least half of ${geo.grid}px: ${JSON.stringify(geo.cols)}`);
    assert.ok(geo.placeholder, 'the note field is on screen');
    assert.ok(geo.placeholder.text <= geo.placeholder.room,
      `the note placeholder fits: ${geo.placeholder.text}px of text in ${geo.placeholder.room}px`);
    assert.ok(geo.scrollWidth <= geo.innerWidth, 'nothing scrolls sideways');
    assert.deepEqual(geo.sideOverflow, [], 'nothing spills out of the narrower side columns');
  });
}
