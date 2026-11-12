// @ts-check

/**
 * bo:shots, schermata Import: arriva a import-ready anche quando la lettura
 * del file è lenta (voce bo:shots import, PR #828 e #833 rosse nella stessa
 * ora con «import desktop: the harness module did not run to completion (no
 * import-ready)»).
 *
 * Why it failed: the import harness loads a demo CSV through the real file
 * control, and the view reads it with `file.arrayBuffer()`. Chromium's
 * virtual clock (`--virtual-time-budget`) waits for network fetches, not
 * for Blob I/O, and the harness polled with 50 ms timers: on a loaded
 * runner the Blob read landed after the virtual budget was spent, so the
 * page never set its ready title.
 *
 * What it proves: the real import harness of scripts/bo-shots.js, served
 * with a prelude that makes every Blob read never settle — the extreme of
 * «slower than the budget» — still runs to import-ready and paints the
 * column-match step. On the harness before the cure it never does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromiumFlags, findChromium, harnessHtml } from '../scripts/bo-shots.js';

const CHROMIUM = findChromium();
const FLAGS = chromiumFlags(CHROMIUM);
const BROWSER_SKIP = FLAGS !== null
  ? false
  : 'no runnable Chromium here (set CHROMIUM_BIN); the CI runner carries one';

const PUBLIC = fileURLToPath(new URL('../apps/admin/public/', import.meta.url));

/** Every Blob read hangs: the file bytes never arrive through Blob I/O. */
const HANGING_BLOB_READS = '<script>Blob.prototype.arrayBuffer = function hangingRead() { return new Promise(() => {}); };</script>';

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

function runChromium(args) {
  return new Promise((resolve) => {
    const child = spawn(/** @type {string} */ (CHROMIUM), [...(FLAGS ?? []), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test('bo:shots import reaches import-ready even when the Blob read never lands', { skip: BROWSER_SKIP }, async () => {
  const page = harnessHtml('import', PUBLIC).replace('<body>', `<body>${HANGING_BLOB_READS}`);
  assert.ok(page.includes('hangingRead'), 'the hanging prelude sits before the harness module');
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://shot.test');
    if (url.pathname === '/harness.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    const file = join(PUBLIC, decodeURIComponent(url.pathname.slice(1)));
    if (!file.startsWith(PUBLIC) || !existsSync(file)) {
      res.writeHead(404);
      res.end('no');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const dom = await runChromium([
      '--headless', '--disable-gpu', '--dump-dom',
      '--window-size=1440,1800',
      '--virtual-time-budget=8000',
      '--disable-background-networking',
      `http://127.0.0.1:${address.port}/harness.html`,
    ]);
    assert.equal(dom.status, 0, `the probe run exits 0 (stderr: ${dom.stderr.slice(-300)})`);
    assert.ok(dom.stdout.includes('<title>import-ready</title>'),
      'the harness reaches import-ready without waiting on Blob I/O');
    assert.ok(dom.stdout.includes('name="mapping-0"'), 'the column-match step is painted');
  } finally {
    server.close();
  }
});
