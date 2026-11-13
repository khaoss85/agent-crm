import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// The real /bo pipeline page of bo:shots (shell, styles.css, demo board),
// served the same way, in a real Chromium.
import {
  chromiumFlags, chromiumRuns, findChromium, harnessHtml, readProbe, startServer, VIRTUAL_BUDGET_MS,
} from '../scripts/bo-shots.js';

/**
 * backlog:fd0adcded1c3 (seguito di 23f92c6a72ea), verifica in produzione
 * 13/11: a 1024 e a 1280 px il pannello dell'offerta, a destra, copriva la
 * colonna della card aperta (1024: x 580-1000 sopra Proposta; 1280: x
 * 836-1256 sopra Pagato) e la board non scorreva. Qui la pagina vera, alle
 * due larghezze: si apre la card di Proposta e quella di Pagato, e la loro
 * colonna deve restare tutta a sinistra del pannello.
 */

const CHROMIUM = findChromium();
const BROWSER_SKIP = chromiumRuns(CHROMIUM)
  ? false
  : 'no runnable Chromium here (set CHROMIUM_BIN); the Mac CI runner runs the browser proofs';

const PUBLIC_DIR = fileURLToPath(new URL('../apps/admin/public', import.meta.url));

// Runs right after the demo board painted, before its ready title: opens
// each card's panel with its own «Apri» and measures what the eye sees.
const MEASURE = `
{
  const board = document.querySelector('#view-module .pipeline-board');
  const room = {};
  for (const id of ['c', 'd']) {
    const card = [...document.querySelectorAll('#view-module .pipeline-card')].find((node) => node.getAttribute('data-record') === id);
    const open = card && [...card.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Apri');
    if (!open) { room[id] = { error: 'no Apri' }; continue; }
    open.click();
    const panel = document.querySelector('[data-offer-drawer]');
    const column = card.parentNode;
    const p = panel.getBoundingClientRect();
    const c = column.getBoundingClientRect();
    const b = board.getBoundingClientRect();
    room[id] = {
      stage: column.getAttribute('data-stage'),
      panelLeft: Math.round(p.left), panelRight: Math.round(p.right),
      columnLeft: Math.round(c.left), columnRight: Math.round(c.right),
      boardLeft: Math.round(b.left), scrolled: Math.round(board.scrollLeft),
    };
    panel.querySelector('[data-action="offer-drawer-close"]').click();
    room[id].afterClose = { room: board.getAttribute('data-offer-room'), style: board.getAttribute('style') };
  }
  document.getElementById('roomprobe').textContent = JSON.stringify(room);
}
`;

function pageFor(name) {
  const html = harnessHtml(name, PUBLIC_DIR);
  const ready = "document.title = 'pipeline-ready';";
  if (name !== 'pipeline' || !html.includes(ready)) return html;
  return html
    .replace(ready, `${MEASURE}\n${ready}`)
    .replace('<div id="probe" hidden></div>', '<div id="probe" hidden></div><div id="roomprobe" hidden></div>');
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

test('fd0adcded1c3: at 1024 and 1280 px the open card\'s column stays left of the offer panel', { skip: BROWSER_SKIP }, async () => {
  const flags = chromiumFlags(CHROMIUM) ?? [];
  const server = await startServer(PUBLIC_DIR, pageFor);
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    for (const width of [1024, 1280]) {
      const dom = await runChromium([
        '--headless', ...flags, '--dump-dom', `--window-size=${width},900`,
        `--virtual-time-budget=${VIRTUAL_BUDGET_MS}`, '--force-prefers-reduced-motion', '--disable-background-networking',
        `http://127.0.0.1:${address.port}/shot-pipeline.html`,
      ], 120000);
      assert.equal(dom.status, 0, `${width}: chromium exits 0 (stderr: ${(dom.stderr ?? '').slice(-400)})`);
      assert.ok(dom.stdout.includes('<title>pipeline-ready</title>'), `${width}: the board painted`);
      assert.equal(readProbe(dom.stdout, 'pipeline').deals, 5, `${width}: with the five demo offers`);
      const match = dom.stdout.match(/<div id="roomprobe"[^>]*>(.*?)<\/div>/s);
      assert.ok(match, `${width}: the measure ran`);
      const room = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      for (const [id, stage] of [['c', 'proposta'], ['d', 'pagato']]) {
        const seen = room[id];
        assert.equal(seen.error, undefined, `${width} ${id}: ${seen.error}`);
        assert.equal(seen.stage, stage);
        assert.ok(seen.panelLeft > seen.boardLeft, `${width} ${stage}: the panel sits beside the board (${JSON.stringify(seen)})`);
        assert.ok(seen.columnRight <= seen.panelLeft,
          `${width} ${stage}: the column (x ${seen.columnLeft}-${seen.columnRight}) ends before the panel (x ${seen.panelLeft}-${seen.panelRight})`);
        assert.ok(seen.columnLeft >= seen.boardLeft, `${width} ${stage}: and starts inside the board (${seen.columnLeft} ≥ ${seen.boardLeft})`);
        assert.deepEqual(seen.afterClose, { room: null, style: null }, `${width} ${stage}: closing the panel gives the board its width back`);
      }
    }
  } finally {
    server.close();
  }
});
