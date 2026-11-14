import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
// The real /bo Agenti page of bo:shots (shell with its sticky top bar,
// styles.css, demo team), served the same way, in a real Chromium.
import {
  runChromium as runSharedChromium, harnessHtml, readProbe, runnableChromium, startServer, VIRTUAL_BUDGET_MS,
} from '../scripts/bo-shots.js';

/**
 * backlog:f06d06f242d6 (verifica 14/11 05:49Z, pilota 1e10e62): nel form
 * «Nuovo agente», dopo un errore lo scroll metteva campo ed errore sotto la
 * barra fissa in alto (input a top 0, errore a 47-63 px, la barra copre
 * fino a ~64 px). Qui la pagina vera, a 1280×600 e a 390×700: il form si
 * apre, la pagina scorre oltre il campo Nome, «Crea l'agente» con il nome
 * vuoto — campo ed errore devono stare sotto la barra e dentro la finestra.
 */

const RUNNABLE = runnableChromium();
const CHROMIUM = RUNNABLE?.binary ?? null;
const BROWSER_SKIP = RUNNABLE !== null
  ? false
  : (process.env.CI ? false : 'no runnable Chromium here (set CHROMIUM_BIN)');

const PUBLIC_DIR = fileURLToPath(new URL('../apps/admin/public', import.meta.url));

const MEASURE = `
{
  const seen = {};
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  document.querySelector('#view-module [data-action="new-agent"]').click();
  await settle();
  seen.focusOnOpen = document.activeElement?.getAttribute('name') ?? null;
  // The page scrolls on, past the Nome field (the operator went down to Crea).
  const create = document.querySelector('#view-module [data-action="create-agent"]');
  window.scrollTo(0, 0);
  const nameTop = document.querySelector('#view-module input[name="agent-name"]').getBoundingClientRect().top + window.scrollY;
  window.scrollTo(0, nameTop + 40);
  await settle();
  create.click();
  await settle();
  const bar = document.querySelector('.bo-topbar').getBoundingClientRect();
  const input = document.querySelector('#view-module input[name="agent-name"]');
  const error = input.parentNode.querySelector('.bo-agent-field-error');
  const i = input.getBoundingClientRect();
  const e = error ? error.getBoundingClientRect() : null;
  seen.barBottom = Math.round(bar.bottom);
  seen.inputTop = Math.round(i.top);
  seen.errorTop = e ? Math.round(e.top) : null;
  seen.errorBottom = e ? Math.round(e.bottom) : null;
  seen.viewport = window.innerHeight;
  seen.focusAfterError = document.activeElement?.getAttribute('name') ?? null;
  document.getElementById('formprobe').textContent = JSON.stringify(seen);
}
`;

function pageFor(name) {
  const html = harnessHtml(name, PUBLIC_DIR);
  const ready = "document.title = 'agenti-ready';";
  if (name !== 'agenti' || !html.includes(ready)) return html;
  return html
    .replace(ready, `${MEASURE}\n${ready}`)
    .replace('<div id="probe" hidden></div>', '<div id="probe" hidden></div><div id="formprobe" hidden></div>');
}

// backlog:c7e97de6cf1f (review Muse #900): the shared runner — stopped on
// no sign of life (output or a request to the shot server), with a safety
// cap never reached by a normal run; never on a fixed total time.
function runChromium(args, server) {
  return runSharedChromium(CHROMIUM, args, { activityAt: () => server.boActivityAt() });
}

test('f06d06f242d6: after a refused «Nuovo agente», field and error sit below the sticky top bar', { skip: BROWSER_SKIP }, async () => {
  assert.ok(RUNNABLE, 'CI runs this proof: no runnable Chromium here (set CHROMIUM_BIN)');
  const server = await startServer(PUBLIC_DIR, pageFor);
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    for (const [width, height] of [[1280, 600], [390, 700]]) {
      const dom = await runChromium([
        '--headless', ...RUNNABLE.flags, '--dump-dom', `--window-size=${width},${height}`,
        `--virtual-time-budget=${VIRTUAL_BUDGET_MS}`, '--force-prefers-reduced-motion', '--disable-background-networking',
        `http://127.0.0.1:${address.port}/shot-agenti.html`,
      ], server);
      assert.equal(dom.status, 0, `${width}: chromium exits 0 (stderr: ${(dom.stderr ?? '').slice(-400)})`);
      assert.ok(dom.stdout.includes('<title>agenti-ready</title>'), `${width}: the page painted`);
      assert.equal(readProbe(dom.stdout, 'agenti').agents, 2, `${width}: with the demo team`);
      const match = dom.stdout.match(/<div id="formprobe"[^>]*>(.*?)<\/div>/s);
      assert.ok(match, `${width}: the measure ran`);
      const seen = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      assert.equal(seen.focusOnOpen, 'agent-name', `${width}: opening the form puts the cursor in Nome`);
      assert.ok(seen.errorTop !== null, `${width}: the error shows next to Nome`);
      assert.ok(seen.inputTop >= seen.barBottom,
        `${width}: the Nome field (top ${seen.inputTop}) is below the top bar (bottom ${seen.barBottom})`);
      assert.ok(seen.errorTop >= seen.barBottom && seen.errorBottom <= seen.viewport,
        `${width}: its error (${seen.errorTop}-${seen.errorBottom}) is in view, under the bar (${seen.barBottom}), inside ${seen.viewport}`);
      assert.equal(seen.focusAfterError, 'agent-name', `${width}: the cursor is in Nome to fix it`);
    }
  } finally {
    server.close();
  }
});
