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
 * Third red, 13/11 on #836 and #839: «cliente desktop: the harness module
 * did not run to completion (no cliente-ready)». #841 held the two waits
 * known then (webfonts, the Import Blob) one by one; any other wait off
 * the main thread still let the virtual clock jump to the end of the
 * budget. And a hold freezes the clock outright: a webfont load started
 * after one task boundary never settles inside a hold (until its 30 s cap).
 *
 * The cure is one pacer in the harness generator (PACE_PRELUDE): until the
 * ready title, the virtual clock moves at most PACE_STEP_MS per PACE_MS of
 * real time, so a real-time wait costs its real length, never the budget.
 *
 * What it proves, on the real shot server and the real harnesses:
 * - every harness reaches its ready title when a step of it — at the start
 *   of the module and right before the ready title — takes real time with
 *   no fetch open (on the harness before the pacer none does: the run ends
 *   at once with no title, the CI symptom);
 * - Import reaches import-ready with every Blob read hanging forever;
 * - nuovo-modulo reaches nuovo-modulo-ready with every webfont load taking
 *   real time (a 1 GB Blob read first);
 * - the pacer keeps virtual timers moving: calendario, which steps its view
 *   with setTimeout, finishes in a few seconds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { SCREENS, chromiumFlags, findChromium, harnessHtml, harnessStage, startServer } from '../scripts/bo-shots.js';

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
  return dumpPage(name, (html) => html.replace('<body>', `<body>${prelude}`));
}

/**
 * Serve one harness, rewritten by `rewrite`, through the real shot server,
 * and read the DOM after the 8000 ms virtual budget.
 * @param {string} name @param {(html: string) => string} rewrite
 */
async function dumpPage(name, rewrite) {
  const server = await startServer(PUBLIC, (screen) => rewrite(harnessHtml(screen, PUBLIC)));
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
  assert.ok(dom.includes('<title>nuovo-modulo-ready</title>'), 'the shell font wait is paced: the harness completes');
  assert.ok(dom.includes('Genera il modulo'), 'the screen is painted');
});

test('bo:shots: the pacer keeps virtual timers moving (calendario steps its view with setTimeout)', { skip: BROWSER_SKIP }, async () => {
  const { dom, ms } = await dumpWith('calendario', '');
  assert.ok(dom.includes('<title>calendario-ready</title>'), 'the timer-driven harness completes');
  assert.ok(ms < 20_000, `its timers are never frozen (${ms} ms < 20000 ms)`);
});

/**
 * One step that takes real time with no fetch open: Chromium reads a Blob
 * off the main thread, the page has nothing else to do, and an unpaced
 * virtual clock jumps to the end of the budget.
 */
const REAL_TIME_STEP = 'await new Blob([new Uint8Array(64 * 1024 * 1024)]).arrayBuffer();';

/** The harness with a real-time step at its start and before its ready title. */
function withRealTimeSteps(html) {
  const ready = /document\.title = '([a-z-]+-ready)';/;
  assert.ok(html.includes('<script type="module">') && ready.test(html), 'the harness has a module and a ready title');
  return html
    .replace('<script type="module">', `<script type="module">${REAL_TIME_STEP}`)
    .replace(ready, `${REAL_TIME_STEP}document.title = '$1';`);
}

test('bo:shots: every harness reaches its ready title when its steps take real time with no fetch (backlog:30dc70e6b076)', { skip: BROWSER_SKIP }, async () => {
  const screens = SCREENS.filter((screen) => screen.module !== null);
  assert.ok(screens.some((screen) => screen.name === 'cliente'), 'the scheda cliente is one of them');
  const missed = [];
  for (let start = 0; start < screens.length; start += 4) {
    await Promise.all(screens.slice(start, start + 4).map(async (screen) => {
      const { dom } = await dumpPage(screen.name, withRealTimeSteps);
      if (!dom.includes(`<title>${screen.ready}</title>`)) missed.push(`${screen.name}: no ${screen.ready}`);
    }));
  }
  assert.deepEqual(missed, [], 'every harness completes');
});

test('bo:shots: a run that ends before the ready title says where it stopped', () => {
  const page = harnessHtml('cliente', PUBLIC);
  assert.equal(
    harnessStage({ stdout: page, stderr: 'line one\nrenderer gone\n' }),
    `title null, dom ${page.length} chars, shell empty, view 0 chars, stderr "renderer gone"`,
  );
  assert.match(harnessStage({ stdout: '', stderr: '' }), /^title null, dom 0 chars, shell empty, view 0 chars$/);
});
