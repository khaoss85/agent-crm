import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// The real /bo pipeline page of bo:shots (shell, styles.css, demo board),
// served the same way, in a real Chromium.
import {
  harnessHtml, readProbe, runnableChromium, startServer, VIRTUAL_BUDGET_MS,
} from '../scripts/bo-shots.js';

/**
 * backlog:2df27cf9e5c1 (review Muse #893, P2): chiudendo il pannello
 * dell'offerta col mouse il focus torna sulla card aperta. La misura è nel
 * browser vero: dopo la chiusura, document.activeElement è l'«Apri» della
 * card che era aperta — col ✕ e con un clic su uno spazio vuoto della
 * board; un clic su un campo lascia il focus al campo.
 */

// The shared finder of bo:shots (backlog:d30d17880f63): on CI (CI=true) a
// missing Chromium fails the test instead of skipping it.
const RUNNABLE = runnableChromium();
const CHROMIUM = RUNNABLE?.binary ?? null;
const BROWSER_SKIP = RUNNABLE !== null
  ? false
  : (process.env.CI ? false : 'no runnable Chromium here (set CHROMIUM_BIN)');

const PUBLIC_DIR = fileURLToPath(new URL('../apps/admin/public', import.meta.url));

const MEASURE = `
{
  const seen = {};
  const cardOf = (id) => [...document.querySelectorAll('#view-module .pipeline-card')].find((node) => node.getAttribute('data-record') === id);
  const apriOf = (id) => [...cardOf(id).querySelectorAll('button')].find((node) => node.textContent.trim() === 'Apri');
  const where = () => {
    const active = document.activeElement;
    return {
      action: active?.getAttribute?.('data-action') ?? active?.tagName ?? null,
      card: active?.closest?.('.pipeline-card')?.getAttribute('data-record') ?? null,
    };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  // 1. A mouse click on ✕ (detail 1, like a real click).
  apriOf('b').click();
  seen.opened = Boolean(document.querySelector('[data-offer-drawer]'));
  document.querySelector('[data-offer-drawer] [data-action="offer-drawer-close"]')
    .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  seen.closedByX = !document.querySelector('[data-offer-drawer]');
  seen.afterX = where();
  // 2. A press on empty board.
  apriOf('b').click();
  document.querySelector('#view-module .pipeline-board')
    .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  seen.closedOutside = !document.querySelector('[data-offer-drawer]');
  await settle();
  seen.afterOutside = where();
  // 3. A press on a field: the browser focused the field; it keeps it.
  apriOf('b').click();
  const field = document.querySelector('#view-module input[data-filter="q"]');
  field.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  field.focus();
  await settle();
  seen.afterField = where();
  document.getElementById('focusprobe').textContent = JSON.stringify(seen);
}
`;

function pageFor(name) {
  const html = harnessHtml(name, PUBLIC_DIR);
  const ready = "document.title = 'pipeline-ready';";
  if (name !== 'pipeline' || !html.includes(ready)) return html;
  return html
    .replace(ready, `${MEASURE}\n${ready}`)
    .replace('<div id="probe" hidden></div>', '<div id="probe" hidden></div><div id="focusprobe" hidden></div>');
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

test('2df27cf9e5c1: closing the offer panel with the mouse gives focus back to the open card', { skip: BROWSER_SKIP }, async () => {
  assert.ok(RUNNABLE, 'CI runs this proof: no runnable Chromium here (set CHROMIUM_BIN)');
  const server = await startServer(PUBLIC_DIR, pageFor);
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const dom = await runChromium([
      '--headless', ...RUNNABLE.flags, '--dump-dom', '--window-size=1280,900',
      `--virtual-time-budget=${VIRTUAL_BUDGET_MS}`, '--force-prefers-reduced-motion', '--disable-background-networking',
      `http://127.0.0.1:${address.port}/shot-pipeline.html`,
    ], 120000);
    assert.equal(dom.status, 0, `chromium exits 0 (stderr: ${(dom.stderr ?? '').slice(-400)})`);
    assert.ok(dom.stdout.includes('<title>pipeline-ready</title>'), 'the board painted');
    assert.equal(readProbe(dom.stdout, 'pipeline').deals, 5, 'with the five demo offers');
    const match = dom.stdout.match(/<div id="focusprobe"[^>]*>(.*?)<\/div>/s);
    assert.ok(match, 'the measure ran');
    const seen = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    assert.equal(seen.opened, true, 'Apri opened the panel');
    assert.equal(seen.closedByX, true, 'the mouse ✕ closed it');
    assert.deepEqual(seen.afterX, { action: 'open-offer', card: 'b' }, 'focus is on the open card (its Apri) after the ✕');
    assert.equal(seen.closedOutside, true, 'a press on the board closed it');
    assert.deepEqual(seen.afterOutside, { action: 'open-offer', card: 'b' }, 'and focus came back to the card');
    assert.deepEqual(seen.afterField, { action: 'INPUT', card: null }, 'a press on a field leaves focus in the field');
  } finally {
    server.close();
  }
});
