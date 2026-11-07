import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN_WRITE_GATE_BROWSER_PRELUDE, enforceAdminWriteGate } from './helpers/admin-strict-client.js';
// Same Chromium discovery as the other real-browser tests.
import { chromiumRuns, findChromium } from '../scripts/bo-shots.js';

/**
 * Cambio schermata in a real browser (production verification 07/11).
 *
 * The shell hands every view a Proxy over the real #view-module node
 * (admin-navigation.js). The fake DOM cannot prove a Proxy over a native
 * HTMLElement behaves (DOM methods reject a foreign `this`), so this page
 * runs a real view — the catalog — through the gate in Chromium: a late
 * catalog paint after the operator moved to Stato sync lands nowhere, and
 * the same handle, once routed again, paints the full table.
 */

const CHROMIUM = findChromium();
const BROWSER_SKIP = chromiumRuns(CHROMIUM)
  ? false
  : 'no runnable Chromium here (set CHROMIUM_BIN); the Mac CI runner runs the browser proofs';

const FIXTURE_SCRIPT = `
${ADMIN_WRITE_GATE_BROWSER_PRELUDE}
import { createMountGate, paintScreenLoading } from './admin-navigation.js';
import { createCatalogView } from './admin-catalog.js';
const probe = {};
try {
  const PRODUCTS = {
    products: [{ productId: 'p1', sku: 'YOGA-10', name: 'Pacchetto 10 lezioni', description: '', category: 'pacchetti',
      source: 'manual', priceReadOnly: false, active: true, version: 1, offers: [] }],
    summary: { manual: 1, byProvider: {}, stripeConnected: false },
  };
  let release = () => {};
  let hold = new Promise((done) => { release = done; });
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      await hold;
      if (path === '/api/schema') return { commercial: { commercialContract: 1, discountPolicies: [] } };
      if (path.startsWith('/api/catalog/products')) return PRODUCTS;
      return { items: [] };
    },
  };
  const mount = document.getElementById('view-module');
  const gate = createMountGate(mount);
  const view = createCatalogView({ doc: document, mount: gate.owned('catalog'), client });

  // Catalogo opens; its reads hang. The operator moves to Stato sync.
  gate.activate('catalog');
  paintScreenLoading({ doc: document, mount, label: 'Catalogo prodotti' });
  const late = view.renderTable({}).catch((error) => { probe.lateError = String(error && error.message); });
  gate.activate('sync');
  paintScreenLoading({ doc: document, mount, label: 'Stato sync' });
  probe.afterSwitch = mount.textContent;
  probe.busy = mount.firstChild ? mount.firstChild.getAttribute('aria-busy') : null;
  release();
  await late;
  probe.afterLate = mount.textContent;

  // Back on Catalogo: the same handle passes through to the real node.
  hold = Promise.resolve();
  gate.activate('catalog');
  paintScreenLoading({ doc: document, mount, label: 'Catalogo prodotti' });
  await view.renderTable({});
  probe.routedAgain = mount.textContent.includes('Pacchetto 10 lezioni');
  probe.loadingGone = !mount.textContent.includes('Carico');
} catch (error) {
  probe.error = error instanceof Error ? error.name + ': ' + error.message : String(error);
}
document.getElementById('probe').textContent = JSON.stringify(probe);
document.title = 'navigation-ready';
`;

function harnessHtml() {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">`
    + `<link rel="stylesheet" href="/styles.css"></head>`
    + `<body><section id="view-module"></section><div id="probe"></div>`
    + `<script type="module">${FIXTURE_SCRIPT}</script></body></html>`;
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

test('a real view through the mount gate: late paint dropped, routed paint passes', { skip: BROWSER_SKIP }, async () => {
  const dir = new URL('../apps/admin/public/', import.meta.url);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://shot.test');
    if (url.pathname === '/harness.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(harnessHtml());
      return;
    }
    const type = url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : null;
    if (type === null) {
      res.writeHead(404);
      res.end('no');
      return;
    }
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
    res.end(readFileSync(join(dir.pathname, url.pathname.slice(1)), 'utf8'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const dom = await runChromium([
      '--headless', '--dump-dom', '--window-size=1440,900', '--virtual-time-budget=8000',
      `http://127.0.0.1:${address.port}/harness.html`,
    ], 120000);
    assert.equal(dom.status, 0, `chromium exits 0 (stderr: ${(dom.stderr ?? '').slice(-500)})`);
    assert.ok(dom.stdout.includes('<title>navigation-ready</title>'), 'the harness ran to completion');
    const probeHtml = dom.stdout.match(/<div id="probe">(.*?)<\/div>/)?.[1] ?? '{}';
    const probe = JSON.parse(probeHtml.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    assert.equal(probe.error, undefined, `no exception in the page: ${probe.error}`);
    assert.equal(probe.afterSwitch, 'Carico Stato sync…', 'the switch clears the old screen at once');
    assert.equal(probe.busy, 'true', 'the loading line is marked busy');
    assert.equal(probe.afterLate, 'Carico Stato sync…', 'the late catalog paint lands nowhere');
    assert.equal(probe.routedAgain, true, 'routed again, the real view paints its table through the handle');
    assert.equal(probe.loadingGone, true, 'the view paint replaces the loading line');
  } finally {
    server.close();
  }
});
