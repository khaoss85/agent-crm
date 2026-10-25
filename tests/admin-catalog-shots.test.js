// @ts-check
/**
 * Browser proof for the backoffice Catalogo view (screen 11): the real
 * `admin-catalog.js` module plus the real `styles.css` render the product
 * table inside a real Chromium, once at a desktop viewport and once on a
 * phone viewport. Each run writes a PNG of the table and reports its byte
 * size and pixel dimensions; the phone run additionally asserts, from inside
 * the page, that nothing scrolls sideways under 700px.
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
import { createCatalogView } from './admin-catalog.js';
const MANUAL = {
  products: [{
    productId: 'p1', sku: 'YOGA-10', name: 'Pacchetto 10 lezioni',
    description: 'Dieci ingressi.', category: 'pacchetti', source: 'manual',
    priceReadOnly: false, active: true, version: 2,
    offers: [{
      offerId: 'o1', name: 'Pacchetto 10 lezioni', active: true,
      currency: 'EUR', quoteEligible: true, unsupportedReason: null,
      components: [{
        key: 'prezzo-pacchetto', label: 'Prezzo del pacchetto',
        chargeType: 'one_time', pricingModel: 'flat_fee',
        interval: null, intervalCount: null, unitAmountCents: null,
        flatAmountCents: 9900, externalPriceId: null,
        sourcePricingModel: 'manual:flat_fee', tiers: [],
      }],
    }],
  }],
  summary: { manual: 1, byProvider: { 'stripe-test': 1 }, stripeConnected: true },
};
const SCHEMA = { commercial: { commercialContract: 1, discountPolicies: [{
  name: 'catalog-price-rules', version: 1, label: 'Catalog price rules',
  fingerprint: 'shot', config: { autoApproveMaxBps: 1000, ownerApprovalMaxBps: 3000, approvalKey: 'owner' },
}] } };
const client = {
  async request(path) {
    if (path === '/api/schema') return SCHEMA;
    if (path.startsWith('/api/catalog/products')) return MANUAL;
    throw new Error('unexpected ' + path);
  },
};
const view = createCatalogView({ doc: document, mount: document.getElementById('mount'), client });
await view.renderTable({});
const probe = {
  table: document.querySelector('.catalog-list') ? document.querySelector('.catalog-list').textContent.slice(0, 60) : null,
  scrollWidth: document.documentElement.scrollWidth,
  innerWidth: window.innerWidth,
  stripe: (document.querySelector('.catalog-stripe-ok') ?? { textContent: null }).textContent,
  rules: (document.querySelector('.catalog-rule-bands') ?? { textContent: null }).textContent,
};
document.getElementById('probe').textContent = JSON.stringify(probe);
document.title = 'catalog-ready';
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
  assert.ok(served.includes('admin-catalog.js'), 'the harness serves the real view module');
  const out = join(mkdirTmp(), `catalog-${width}x${height}.png`);
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
  const dir = join(tmpdir(), 'accordo-catalog-shots');
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('the catalog table renders in a real browser: desktop PNG', { skip: CHROMIUM ? false : 'no Chromium binary (set CHROMIUM_BIN)' }, async () => {
  const { out, dom } = await runBrowser({ width: 1280, height: 900 });
  assert.ok(dom.includes('<title>catalog-ready</title>'), 'the harness module ran to completion in the page');
  const shot = pngSize(out);
  assert.equal(shot.width, 1280, 'the PNG is the desktop viewport');
  assert.ok(shot.bytes > 30000, `the table paints real pixels (${shot.bytes} bytes)`);
  console.log(`catalog desktop PNG: ${out} (${shot.width}x${shot.height}, ${shot.bytes} bytes)`);
});

test('the catalog table renders in a real browser: phone PNG without sideways scroll', { skip: CHROMIUM ? false : 'no Chromium binary (set CHROMIUM_BIN)' }, async () => {
  const { out, dom } = await runBrowser({ width: 390, height: 844 });
  const shot = pngSize(out);
  assert.equal(shot.width, 390, 'the PNG is the phone viewport');
  assert.ok(shot.bytes > 20000, `the table paints real pixels (${shot.bytes} bytes)`);
  assert.ok(dom.includes('<title>catalog-ready</title>'), 'the harness module ran to completion in the page');
  const probeHtml = dom.match(/<div id="probe">(.*?)<\/div>/)?.[1] ?? '';
  const probe = JSON.parse(probeHtml.replace(/&quot;/g, '"'));
  assert.ok(probe.table?.includes('Pacchetto 10 lezioni'), 'the phone render holds the product table');
  assert.ok(probe.stripe?.includes('Stripe collegato'), 'the phone render holds the Stripe state');
  assert.ok(probe.rules?.includes('10%'), 'the phone render holds the price-rule bands');
  assert.ok(probe.scrollWidth <= 390, `no horizontal overflow at 390px (scrollWidth ${probe.scrollWidth})`);
  console.log(`catalog phone PNG: ${out} (${shot.width}x${shot.height}, ${shot.bytes} bytes)`);
});
