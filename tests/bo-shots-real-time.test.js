// @ts-check

/**
 * bo:shots: ogni schermata arriva al suo *-ready anche quando il runner è
 * carico (backlog:30dc70e6b076). Rossi visti: «import desktop … no
 * import-ready» su #828 e #833, «nuovo-modulo phone … no nuovo-modulo-ready»
 * su #828.
 *
 * Why it failed: the import harness loads a demo CSV through the real file
 * control, and the view reads it with `file.arrayBuffer()`. Chromium's
 * virtual clock (`--virtual-time-budget`) waits for network fetches, not
 * for Blob I/O, and the harness polled with 50 ms timers: on a loaded
 * runner the Blob read landed after the virtual budget was spent, so the
 * page never set its ready title.
 *
 * The family: anything that takes real time without a network fetch
 * races Chromium's virtual clock — the Import Blob read, and on every
 * screen the webfont load the shell awaits before the fixtures run.
 *
 * What it proves, on the real shot server and the real harnesses:
 * - Import reaches import-ready with every Blob read hanging forever;
 * - nuovo-modulo reaches nuovo-modulo-ready with every webfont load taking
 *   real time (a 1 GB Blob read first) — the shell's font wait is held;
 * - the hold never stalls virtual timers: calendario, which steps its view
 *   with setTimeout, still finishes well inside the hold cap.
 * On the harness before the cure the first two never reach ready.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { HOLD_CAP_MS, chromiumFlags, findChromium, harnessHtml, startServer } from '../scripts/bo-shots.js';

const CHROMIUM = findChromium();
const FLAGS = chromiumFlags(CHROMIUM);
const BROWSER_SKIP = FLAGS !== null
  ? false
  : 'no runnable Chromium here (set CHROMIUM_BIN); the CI runner carries one';

const PUBLIC = fileURLToPath(new URL('../apps/admin/public', import.meta.url));

/** Every Blob read hangs: the file bytes never arrive through Blob I/O. */
const HANGING_BLOB_READS = '<script>Blob.prototype.arrayBuffer = function hangingRead() { return new Promise(() => {}); };</script>';

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

/** Every webfont load first reads 1 GB of throwaway bytes: real time, no fetch. */
const SLOW_FONTS = '<script>{ const own = document.fonts.load.bind(document.fonts); const big = new Blob([new Uint8Array(512 * 1024 * 1024)]); document.fonts.load = async (...args) => { await big.arrayBuffer(); await big.arrayBuffer(); return own(...args); }; }</script>';

/**
 * Serve one harness through the real shot server with a prelude, and read
 * the DOM after the 8000 ms virtual budget.
 * @param {string} name @param {string} prelude
 */
async function dumpWith(name, prelude) {
  const server = await startServer(PUBLIC, (screen) => harnessHtml(screen, PUBLIC).replace('<body>', `<body>${prelude}`));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const started = Date.now();
  try {
    const dom = await runChromium([
      '--headless', '--disable-gpu', '--dump-dom',
      '--window-size=390,1600',
      '--virtual-time-budget=8000',
      '--disable-background-networking',
      `http://127.0.0.1:${address.port}/shot-${name}.html`,
    ]);
    assert.equal(dom.status, 0, `the probe run exits 0 (stderr: ${dom.stderr.slice(-300)})`);
    return { dom: dom.stdout, ms: Date.now() - started };
  } finally {
    server.close();
  }
}

test('bo:shots import reaches import-ready even when the Blob read never lands', { skip: BROWSER_SKIP }, async () => {
  const { dom } = await dumpWith('import', HANGING_BLOB_READS);
  assert.ok(dom.includes('<title>import-ready</title>'), 'the harness reaches import-ready without waiting on Blob I/O');
  assert.ok(dom.includes('name="mapping-0"'), 'the column-match step is painted');
});

test('bo:shots nuovo-modulo reaches nuovo-modulo-ready while the webfonts take real time', { skip: BROWSER_SKIP }, async () => {
  const { dom } = await dumpWith('nuovo-modulo', SLOW_FONTS);
  assert.ok(dom.includes('<title>nuovo-modulo-ready</title>'), 'the shell font wait is held: the harness completes');
  assert.ok(dom.includes('Genera il modulo'), 'the screen is painted');
});

test('bo:shots: the hold never stalls virtual timers (calendario steps its view with setTimeout)', { skip: BROWSER_SKIP }, async () => {
  const { dom, ms } = await dumpWith('calendario', '');
  assert.ok(dom.includes('<title>calendario-ready</title>'), 'the timer-driven harness completes');
  assert.ok(ms < HOLD_CAP_MS, `it never waits for the hold cap (${ms} ms < ${HOLD_CAP_MS} ms)`);
});
