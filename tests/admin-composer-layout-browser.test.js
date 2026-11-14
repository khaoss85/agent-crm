/**
 * backlog:d30d17880f63 (verifica produzione 13/11, 1512×773): the composer
 * «Scrivi al cliente» opened with its body scrolled — the focus on the
 * message field pulled it down, so «Rispondi su» sat cut under the dark
 * window header. Measured in a real Chromium: the label shows whole, below
 * the header, and the body opens at the top.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromiumFlags, chromiumRuns, findChromium } from '../scripts/bo-shots.js';

const CHROMIUM = findChromium();
const CHROMIUM_RUNS = chromiumRuns(CHROMIUM);
// Skip only where the proof cannot run AND nobody gates on it (the rule of
// admin-shell-identity-shots.test.js): on CI (GitHub Actions sets CI=true)
// a missing Chromium fails the test instead of skipping it, so the layout
// claim never passes unproven.
const BROWSER_SKIP = CHROMIUM_RUNS
  ? false
  : (process.env.CI ? false : 'no runnable Chromium here (set CHROMIUM_BIN)');
const PUBLIC_DIR = fileURLToPath(new URL('../apps/admin/public', import.meta.url));
const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

// One customer with an address on every channel, Email linked, the space
// AI off — the production case: the off line and the channel line both
// take room, so the body is taller than the window at 773 px.
const HARNESS = `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/styles.css"></head>
<body><main class="bo-shell"><div class="bo-main"><section id="view-module"></section></div></main>
<div id="geo" hidden></div>
<script type="module">
import { createCustomerCardView } from './admin-customer-card.js';
const CARD = {
  name: 'Guido Esempio', email: 'guido@palestra.esempio.invalid',
  phone: { available: true, value: '+39 333 000 0000' },
  status: { value: 'contatto' },
  socials: [{ system: 'instagram', handle: 'guido.esempio' }, { system: 'facebook', handle: 'guido.esempio' }],
};
const client = {
  async request(path) {
    if (path.startsWith('/api/customer-hub/')) {
      if (path.includes('/card/')) return CARD;
      return { entries: [] };
    }
    if (path.startsWith('/api/connectors')) return { connectors: [
      { channel: 'email', status: 'active', connectionKey: 'gmail-1', account: 'studio@palestra.esempio.invalid' },
    ] };
    if (path === '/api/assistant/status') return { freeQuestions: 'disabled', code: 'LLM_SPACE_DISABLED' };
    throw Object.assign(new Error('not here ' + path), { status: 404 });
  },
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await createCustomerCardView({ doc: document, mount: document.getElementById('view-module'), client, spaceId: 'presti', role: () => 'owner' }).renderCard('contact', 'c1');
document.querySelector('[data-action="compose-email"]').click();
let panel = null;
for (let i = 0; i < 100 && !(panel = document.querySelector('[data-composer="open"]'))?.querySelector('.bo-composer-ai[data-off="true"]'); i += 1) await wait(20);
await wait(200);
const head = document.querySelector('.bo-composer-head').getBoundingClientRect();
const label = document.querySelector('.bo-composer-reply-on').getBoundingClientRect();
const body = document.querySelector('.bo-composer-body');
document.getElementById('geo').textContent = JSON.stringify({
  off: Boolean(panel?.querySelector('.bo-composer-ai[data-off="true"]')),
  headBottom: Math.round(head.bottom), labelTop: Math.round(label.top), labelHeight: Math.round(label.height),
  bodyTop: Math.round(body.getBoundingClientRect().top), scrollTop: body.scrollTop,
  overflows: body.scrollHeight > body.clientHeight,
});
document.title = 'geo-ready';
</script></body></html>`;

function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://shot.test');
    if (url.pathname === '/composer.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HARNESS);
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

function dumpDom(binary, url, width, height) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [
      '--headless', ...chromiumFlags(binary), '--dump-dom',
      `--window-size=${width},${height}`, '--virtual-time-budget=8000', '--hide-scrollbars',
      '--disable-background-networking', url,
    ]);
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('chromium timed out')); }, 120000);
    child.on('error', reject);
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

// 773 is the verifier's window. 520 makes the window body much shorter
// than its content, with the message field below the fold: there a focus
// without preventScroll scrolls the body to the field and «Rispondi su»
// goes under the header (review #880: this case turns red without the
// cure, the margin alone does not save it).
for (const height of [773, 520]) {
  test(`backlog:d30d17880f63: at 1512×${height} «Rispondi su» shows whole under the composer header`, { skip: BROWSER_SKIP }, async () => {
    assert.ok(CHROMIUM_RUNS, 'CI runs this proof: no runnable Chromium here (set CHROMIUM_BIN)');
    const server = /** @type {import('node:http').Server} */ (await serve());
    try {
      const address = /** @type {import('node:net').AddressInfo} */ (server.address());
      const dom = await dumpDom(CHROMIUM, `http://127.0.0.1:${address.port}/composer.html`, 1512, height);
      const match = String(dom).match(/<div id="geo" hidden="">(.*?)<\/div>/s);
      assert.ok(match, 'the composer measured itself');
      const geo = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      assert.ok(geo.off, `the AI-off composer is the one measured: ${JSON.stringify(geo)}`);
      if (height === 520) assert.ok(geo.overflows, `the short window really overflows: ${JSON.stringify(geo)}`);
      assert.equal(geo.scrollTop, 0, `the opening focus never scrolls the body: ${JSON.stringify(geo)}`);
      assert.ok(geo.labelTop >= geo.headBottom + 8, `«Rispondi su» sits whole below the header, with room: ${JSON.stringify(geo)}`);
      assert.ok(geo.labelHeight > 0, 'the label takes room');
    } finally {
      server.close();
    }
  });
}
