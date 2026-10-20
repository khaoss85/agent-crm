// @ts-check
/**
 * Unit tests for `scripts/admin-shots-harness.js`: the server, stubs and
 * badge gates behind the Admin visual-baseline proof. No browser needed —
 * the capture script (`scripts/admin-shots.js`) exercises the same exports
 * under real Chromium.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  STUB_VERSION,
  chromiumCaptureFlags,
  countBadgeNodes,
  findChromium,
  isHeadlessShell,
  runProcess,
  snipDom,
  startRootServer,
  stateBadgeGroups,
  stripAuthority,
  stubResponse,
  summarizeServed,
} from '../scripts/admin-shots-harness.js';

const root = join(import.meta.dirname, '..');
const ADMIN_CSS = join(root, 'apps/admin/public/styles.css');

/**
 * @param {string} dir
 * @returns {Promise<{ port: number, log: { method: string, path: string, status: number, bytes: number }[], close: () => void }>}
 */
function serve(dir) {
  const log = [];
  const server = startRootServer(dir, { log });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ port, log, close: () => server.close() });
    });
  });
}

test('each side serves its own tree at the document root', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-test-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head></html>');
  writeFileSync(join(dir, 'styles.css'), '.badge { color: red; }');
  writeFileSync(join(dir, 'app.js'), 'console.log(1);');
  const { port, log, close } = await serve(dir);
  try {
    for (const [path, type, body] of [
      ['/index.html', 'text/html', '<link rel="stylesheet"'],
      ['/styles.css', 'text/css', '.badge'],
      ['/app.js', 'text/javascript', 'console.log'],
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 200, `${path} answers 200`);
      assert.ok(
        (response.headers.get('content-type') ?? '').startsWith(type),
        `${path} has a ${type} content type`,
      );
      assert.ok((await response.text()).includes(body), `${path} serves this side's bytes`);
    }
    // The document root resolves the absolute asset URLs the app ships.
    const rootResponse = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(rootResponse.status, 200, '/ serves index.html');
    assert.ok((await rootResponse.text()).includes('<link rel="stylesheet"'), '/ renders the app shell');
    const logged = log.filter((item) => item.path === '/styles.css' && item.status === 200);
    assert.ok(logged.length >= 1, 'the request log proves /styles.css was fetched with 200');
    assert.equal(logged[0].bytes, '.badge { color: red; }'.length, 'logged bytes match the served file');
  } finally {
    close();
  }
});

test('unknown paths and traversal attempts answer 404 with an empty body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-test-'));
  writeFileSync(join(dir, 'index.html'), '<html></html>');
  const { port, close } = await serve(dir);
  try {
    for (const path of ['/nope.css', '/api/unknown', '/%2e%2e/admin-shots-harness.js']) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 404, `${path} answers 404`);
      assert.equal(await response.text(), '', `${path} has an empty body, so api() throws honestly`);
    }
  } finally {
    close();
  }
});

test('stubs answer every API the captured screens read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-test-'));
  writeFileSync(join(dir, 'index.html'), '<html></html>');
  const { port, close } = await serve(dir);
  try {
    for (const path of [
      '/health',
      '/api/admin/metrics',
      '/api/opportunities',
      '/api/approvals?status=pending',
      '/api/traces?limit=8',
      '/api/write-outcomes',
      '/api/schema',
      '/api/modules/work-task/records?limit=100',
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 200, `${path} is stubbed`);
      const body = await response.json();
      assert.ok(body !== null && typeof body === 'object', `${path} answers JSON, so response.json() never throws`);
    }
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).ok, true);
  } finally {
    close();
  }
});

test('stub rows render badges covering every state-colour group', () => {
  const css = readFileSync(ADMIN_CSS, 'utf8');
  const groups = stateBadgeGroups(css);
  assert.ok(groups.length >= 5, `styles.css declares the state groups (found ${groups.length})`);
  // Badge classes the app paints from the stub rows: opportunity stages,
  // approval statuses, trace statuses (`badge ${value}` in app.js) and work
  // task statuses (`badge ${row.status}` in admin-work.js).
  const rendered = new Set();
  const opportunities = stubResponse('/api/opportunities');
  assert.ok(opportunities, 'opportunities are stubbed');
  for (const item of JSON.parse(opportunities.body).items) rendered.add(item.stage);
  for (const path of ['/api/approvals', '/api/traces']) {
    const stub = stubResponse(path);
    assert.ok(stub, `${path} is stubbed`);
    for (const item of JSON.parse(stub.body).items) rendered.add(item.status);
  }
  const tasks = stubResponse('/api/modules/work-task/records');
  assert.ok(tasks, 'work tasks are stubbed');
  for (const item of JSON.parse(tasks.body).items) rendered.add(item.status);
  assert.ok(rendered.size > 0, 'stubs render at least one badge class');
  for (const group of groups) {
    assert.ok(
      group.some((state) => rendered.has(state)),
      `state group ${group.join('|')} has a stubbed row — otherwise its pixels never appear in the proof`,
    );
  }
});

test('stub version is a positive integer recorded in the manifest', () => {
  assert.ok(Number.isInteger(STUB_VERSION) && STUB_VERSION >= 1, 'STUB_VERSION is versioned');
});

test('stripAuthority removes exactly the six authority rules', () => {
  const css = readFileSync(ADMIN_CSS, 'utf8');
  const stripped = stripAuthority(css);
  assert.equal((css.split('\n').length - stripped.split('\n').length), 6, 'six rules removed');
  assert.ok(!stripped.includes('[data-authority='), 'no authority selector survives');
  assert.throws(() => stripAuthority('.badge { color: red; }'), /exactly 6/, 'a stylesheet without them fails closed');
});

test('stateBadgeGroups parses the five pinned state rules', () => {
  const groups = stateBadgeGroups(readFileSync(ADMIN_CSS, 'utf8'));
  assert.equal(groups.length, 5, 'exactly five state-colour groups');
  const flat = groups.flat();
  for (const state of ['pending', 'rejected', 'proposal', 'completed', 'failed']) {
    assert.ok(flat.includes(state), `group coverage includes ${state}`);
  }
  assert.ok(!flat.some((state) => state.includes('authority')), 'attribute variants are not state groups');
});

test('isHeadlessShell recognises both shell spellings, never a full browser', () => {
  // Legacy Linux shell and the Playwright download-dir prefix (underscores).
  assert.equal(isHeadlessShell('/opt/pw-browsers/chromium/chrome-linux/headless_shell'), true, 'legacy shell');
  assert.equal(
    isHeadlessShell('/Users/x/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-linux/headless_shell'),
    true,
    'shell via download-dir prefix',
  );
  // Current macOS/Linux shell binary (hyphens), including a bare CHROMIUM_BIN
  // with no Playwright parent dir to match against (the old underscore-only
  // test misdetected that layout as a full browser and added --headless=new).
  assert.equal(
    isHeadlessShell('/Users/x/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
    true,
    'hyphenated shell under an underscore parent',
  );
  assert.equal(isHeadlessShell('/tmp/chrome-headless-shell'), true, 'bare hyphenated binary path');
  assert.equal(isHeadlessShell('/usr/bin/google-chrome'), false, 'full Chrome needs --headless=new');
  assert.equal(isHeadlessShell('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), false, 'macOS Chrome bundle');
});

test('findChromium prefers a full browser over the headless shell', () => {
  const CHROME_APP = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const SHELL = '/Users/x/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell';
  // CHROMIUM_BIN always wins, even over an installed full browser.
  assert.equal(
    findChromium({ env: { CHROMIUM_BIN: '/tmp/custom-chromium' }, exists: () => true }),
    '/tmp/custom-chromium',
    'explicit override wins',
  );
  // With both present, the full browser is picked: the macOS shell renders
  // nothing (exit 143, no screenshot — CI run 39465652065).
  assert.equal(
    findChromium({ env: {}, exists: (path) => path === CHROME_APP || path === SHELL }),
    CHROME_APP,
    'full Chrome before headless shell',
  );
  // The shell is still the fallback where no full browser exists.
  assert.equal(
    findChromium({
      env: {},
      home: '/Users/x',
      exists: (path) => path === SHELL,
      readdir: (dir) => (dir === '/Users/x/Library/Caches/ms-playwright' ? ['chromium_headless_shell-1208'] : []),
    }),
    SHELL,
    'shell fallback preserved',
  );
  assert.equal(
    findChromium({ env: {}, exists: () => false, readdir: () => [] }),
    null,
    'null when no browser exists',
  );
});

test('chromiumCaptureFlags pins the runner-proof invocation', () => {
  const full = chromiumCaptureFlags('/usr/bin/google-chrome');
  assert.ok(full.includes('--headless=new'), 'full browser renders headless');
  assert.ok(full.includes('--no-proxy-server'), 'runner proxy never touches loopback');
  assert.ok(full.includes('--timeout=30000'), 'Chromium bounds its own wait (CI run 39487589615)');
  assert.ok(full.includes('--virtual-time-budget=5000'), 'render settles before the shot');
  assert.ok(!full.some((flag) => flag.startsWith('--user-data-dir=')), 'profile stays per-capture');
  const shell = chromiumCaptureFlags('/x/chrome-headless-shell');
  assert.ok(!shell.includes('--headless=new'), 'shell is headless by definition');
  assert.ok(shell.includes('--no-proxy-server'), 'proxy bypass is not browser-specific');
  assert.ok(shell.includes('--timeout=30000'), 'timeout bound is not browser-specific');
});

test('countBadgeNodes counts badge elements and their state classes', () => {
  const dom = [
    '<div class="badge approval_pending">a</div>',
    '<span class="badge rejected extra">b</span>',
    '<p class="not-a-badge">c</p>',
    '<div class="badges">d</div>',
  ].join('');
  const counted = countBadgeNodes(dom);
  assert.equal(counted.total, 2, 'only badge-token elements count');
  assert.deepEqual(counted.states, ['approval_pending', 'extra', 'rejected'], 'state classes collected');
  assert.equal(countBadgeNodes('<html><body>no badges</body></html>').total, 0, 'empty shell counts zero');
});

test('summarizeServed renders the request log one line per hit, in order', () => {
  const lines = summarizeServed([
    { method: 'GET', path: '/index.html', status: 200, bytes: 12 },
    { method: 'GET', path: '/styles.css', status: 200, bytes: 34 },
    { method: 'GET', path: '/missing', status: 404, bytes: 0 },
  ]);
  assert.deepEqual(lines, [
    'GET /index.html 200 12b',
    'GET /styles.css 200 34b',
    'GET /missing 404 0b',
  ]);
  assert.deepEqual(summarizeServed([]), [], 'empty log summarises empty');
});

test('snipDom collapses a document to one log line with an explicit cut', () => {
  assert.equal(snipDom('<html>\n  <body>hi</body>\n</html>'), '<html> <body>hi</body> </html>');
  const long = `<html>${'x'.repeat(2000)}</html>`;
  const snipped = snipDom(long, 100);
  assert.ok(snipped.startsWith('<html>'), 'keeps the head, where the failure evidence is');
  assert.match(snipped, /\(\+\d+ chars\)$/, 'marks the cut instead of truncating silently');
  assert.equal(snipDom(null), '', 'never throws on odd input');
});

test('runProcess keeps the loopback servers answering while a subprocess runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-test-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>capture-alive</body></html>');
  const { port, log, close } = await serve(dir);
  try {
    // Regression: the capture used to spawn Chromium synchronously while
    // serving its trees from the same process, so no request was ever
    // answered (CI run 39497667414: zero served lines, empty DOM after the
    // browser's own timeout). A subprocess fetching the tree must get its
    // bytes while the parent awaits it.
    const probe = await runProcess(
      process.execPath,
      [
        '-e',
        `fetch('http://127.0.0.1:${port}/index.html').then(async (r) => { console.log(await r.text()); }).catch((e) => { console.error('fetch failed: ' + e.message); process.exitCode = 7; })`,
      ],
      { timeoutMs: 15_000 },
    );
    assert.equal(probe.timedOut, false, 'the subprocess finished instead of hanging a starved server');
    assert.equal(probe.status, 0, 'the fetch subprocess exited cleanly');
    assert.ok(probe.stdout.includes('capture-alive'), 'the server answered mid-flight with its own bytes');
    assert.ok(
      log.some((item) => item.path === '/index.html' && item.status === 200),
      'the hit is in the request log',
    );
  } finally {
    close();
  }
});

test('runProcess times out a hung subprocess instead of waiting forever', async () => {
  const startedAt = Date.now();
  const hung = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 50);'], {
    timeoutMs: 500,
  });
  assert.equal(hung.timedOut, true, 'the hang is reported, not awaited');
  assert.ok(Date.now() - startedAt < 15_000, 'the timeout bound holds');
});
