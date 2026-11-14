import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  BROWSER_IDLE_MS, PACE_PRELUDE, STALL_MS, VIRTUAL_BUDGET_MS, chromiumFlags, findChromium, harnessStage, startServer,
} from '../scripts/bo-shots.js';

/**
 * backlog:c7e97de6cf1f — bo:shots on a loaded CI runner: a harness never
 * reached its ready title, or the PNG came out almost blank, because the
 * fixed 8 s virtual budget (~16 s real at the pacer's rate) ran out while a
 * busy machine was still compiling the page. A shot now ends on the page's
 * own signals: its ready title, or no progress at all for STALL_MS of real
 * time. A page that keeps working, however slowly, is never cut by a clock.
 */

const CHROMIUM = findChromium();
const FLAGS = chromiumFlags(CHROMIUM);
const BROWSER_SKIP = FLAGS !== null ? false : 'no runnable Chromium here (set CHROMIUM_BIN); the CI runner carries one';
const PUBLIC = fileURLToPath(new URL('../apps/admin/public', import.meta.url));

function runChromium(args) {
  return new Promise((resolve) => {
    const child = spawn(/** @type {string} */ (CHROMIUM), [...(FLAGS ?? []), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const page = (script) => `<!doctype html><html><head><meta charset="utf-8"><title>in corso</title>${PACE_PRELUDE}</head>`
  + `<body><main id="out"></main><script>${script}</script></body></html>`;

async function dump(html, stallMs) {
  const server = await startServer(PUBLIC, () => html, { stallMs });
  const address = server.address();
  const started = Date.now();
  try {
    const dom = await runChromium([
      '--headless', '--disable-gpu', '--dump-dom', '--window-size=390,800',
      `--virtual-time-budget=${VIRTUAL_BUDGET_MS}`, '--disable-background-networking',
      `http://127.0.0.1:${/** @type {any} */ (address).port}/shot-prova.html`,
    ]);
    return { dom, ms: Date.now() - started };
  } finally {
    server.close();
  }
}

test('c7e97de6cf1f: the budget is no deadline and the caps are on no progress, never on total time', () => {
  assert.ok(VIRTUAL_BUDGET_MS >= 600_000, 'the virtual budget no longer ends a working harness');
  assert.equal(BROWSER_IDLE_MS, 2 * STALL_MS, 'the browser guard is an idle guard');
  assert.match(harnessStage({ stdout: '<html data-bo-stalled="true"><head><title>x</title></head></html>', stderr: '' }), /^stalled \(no progress for 30s\), /);
});

test('c7e97de6cf1f: a page that keeps working for many stall windows still reaches its ready title', { skip: BROWSER_SKIP }, async () => {
  // One DOM change every 10 ms of virtual time for 1.5 s of virtual time:
  // ~3 s of real time at the pacer's rate, six times the 500 ms stall window.
  const working = page(`let n = 0; const tick = () => { document.getElementById('out').append(document.createElement('i')); n += 1;
    if (n < 150) setTimeout(tick, 10); else document.title = 'prova-ready'; }; tick();`);
  const { dom, ms } = await dump(working, 500);
  assert.equal(dom.status, 0);
  assert.ok(dom.stdout.includes('<title>prova-ready</title>'), `ready after ${ms} ms (${harnessStage(dom)})`);
  assert.doesNotMatch(dom.stdout, /<html[^>]*data-bo-stalled="true"/, 'never stopped while it worked');
});

test('c7e97de6cf1f: a page that stops making progress is stopped, and says so', { skip: BROWSER_SKIP }, async () => {
  // Waits on a promise nothing settles: no DOM change, no fetch, no title.
  const stuck = page('new Promise(() => {}).then(() => { document.title = "prova-ready"; });');
  const { dom, ms } = await dump(stuck, 500);
  assert.equal(dom.status, 0);
  assert.ok(!dom.stdout.includes('<title>prova-ready</title>'));
  assert.match(harnessStage(dom), /^stalled /, 'the failure names the stall');
  assert.ok(ms < 60_000, `stopped by the stall window, not by a budget (${ms} ms)`);
});
