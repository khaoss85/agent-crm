// @ts-check
/**
 * Agenti, layout delle card (segnalazione di Dan dell'11/11): una sola card
 * stretta a sinistra, metriche spezzate su più righe, una lista lunghissima
 * di giri con l'esito in un corpo più grande del nome dell'agente.
 *
 * Qui si prova la struttura sul fake DOM (solo gli ultimi 2 incarichi,
 * «Mostra tutti (N)», esito come chip, frase intera al clic) e il layout
 * vero in Chromium con lo styles.css reale: la card usa la larghezza della
 * pagina, ogni metrica sta su una riga, il nome dell'agente è il testo più
 * forte della card e a 390 px non c'è scroll orizzontale.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN_WRITE_GATE_BROWSER_PRELUDE, enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import {
  AGENT_RUNS_VISIBLE,
  RUN_OUTCOME_CHIP,
  buildAgentCards,
  createAgentiView,
} from '../apps/admin/public/admin-agenti.js';
import { chromiumRuns, findChromium } from '../scripts/bo-shots.js';

const NOW = '2026-11-11T10:00:00.000Z';
const AGENT = { id: 1, sourceKey: 'agent:presti:pulizia-contatti', spaceId: 'presti', name: 'Pulizia contatti', role: 'Tiene in ordine i clienti', status: 'active' };
const CATALOG_ENTRY = { slug: 'pulizia-contatti', name: 'Pulizia contatti', role: 'Tiene in ordine i clienti', instructions: 'Cerca doppioni.', examplePhrase: 'ogni venerdì controlla i doppioni', agentSourceKey: AGENT.sourceKey };
const LONG = 'controlla i doppioni tra i clienti arrivati da WhatsApp, Instagram, email e dal form del sito negli ultimi tre mesi, proponi come unirli senza perdere le note, i telefoni e le etichette, e dimmi quali hanno ancora un appuntamento aperto';

/** Five incarichi, newest first: applied, rejected, nothing to propose, failed, never ran. */
const ASSIGNMENTS = [
  { sourceKey: 'a-1', agentSourceKey: AGENT.sourceKey, phrase: LONG, cadence: 'once', status: 'completed', decidedAt: '2026-11-10T04:40:00.000Z' },
  { sourceKey: 'a-2', agentSourceKey: AGENT.sourceKey, phrase: 'unisci i doppioni di Rossi', cadence: 'once', status: 'completed', decidedAt: '2026-11-09T04:40:00.000Z' },
  { sourceKey: 'a-3', agentSourceKey: AGENT.sourceKey, phrase: 'controlla le email vuote', cadence: 'once', status: 'completed', decidedAt: '2026-11-08T04:40:00.000Z' },
  { sourceKey: 'a-4', agentSourceKey: AGENT.sourceKey, phrase: 'ogni venerdì controlla i doppioni', cadence: 'weekly', weekday: 5, timeOfDay: '08:00', status: 'active', decidedAt: '2026-11-07T04:40:00.000Z' },
  { sourceKey: 'a-5', agentSourceKey: AGENT.sourceKey, phrase: 'sistema i numeri di telefono', cadence: 'once', status: 'active', decidedAt: '2026-11-06T04:40:00.000Z' },
];
const RUNS = [
  { id: 'r1', sourceKey: 'r-1', agentSourceKey: AGENT.sourceKey, assignmentSourceKey: 'a-1', outcome: 'applied', startedAt: '2026-11-10T04:46:00.000Z', decidedAt: '2026-11-10T04:46:00.000Z' },
  { id: 'r2', sourceKey: 'r-2', agentSourceKey: AGENT.sourceKey, assignmentSourceKey: 'a-2', outcome: 'rejected', startedAt: '2026-11-09T04:46:00.000Z', decidedAt: '2026-11-09T04:46:00.000Z' },
  { id: 'r3', sourceKey: 'r-3', agentSourceKey: AGENT.sourceKey, assignmentSourceKey: 'a-3', outcome: 'artifact', startedAt: '2026-11-08T04:46:00.000Z', decidedAt: '2026-11-08T04:46:00.000Z' },
  { id: 'r4', sourceKey: 'r-4', agentSourceKey: AGENT.sourceKey, assignmentSourceKey: 'a-4', outcome: 'failed', startedAt: '2026-11-07T07:00:00.000Z' },
];

function client({ assignments = ASSIGNMENTS } = {}) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      // The agent is the catalogue's own (backlog:1f7cb20d3c30: only a
      // catalogue agent has an engine, so it reads «Attivo»).
      if (path.startsWith('/api/agents/catalog')) return { agents: [CATALOG_ENTRY] };
      if (path.startsWith('/api/modules/teammate-agent/records?')) return { items: [{ ...AGENT }] };
      if (path.startsWith('/api/modules/teammate-assignment/records?')) return { items: assignments.map((row) => ({ ...row })) };
      if (path.startsWith('/api/modules/teammate-run/records?')) return { items: RUNS.map((row) => ({ ...row })) };
      throw new Error(`unexpected ${path}`);
    },
  };
}

async function flush() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** @param {any} node @param {string} tag @param {string} cls */
function byClass(node, tag, cls) {
  return node.findAll(tag).filter((child) => child.classList.contains(cls));
}

async function paintedView(options) {
  const mount = createMount();
  const view = createAgentiView({ doc: createFakeDocument(), mount, client: client(options), spaceId: () => 'presti', now: () => NOW, setTimer: () => null, clearTimer: () => {} });
  await view.render();
  await flush();
  return { mount, view };
}

test('ogni incarico porta l’esito e la data dell’ultimo giro come dati, non come frase lunga', () => {
  const [card] = buildAgentCards({ agents: [AGENT], assignments: ASSIGNMENTS, runs: RUNS, nowIso: NOW });
  assert.deepEqual(card.assignments.map((row) => row.lastOutcome), ['applied', 'rejected', 'artifact', 'failed', null]);
  assert.equal(card.assignments[0].lastStamp, '10 nov, 05:46', 'ora di Roma');
  assert.equal(card.assignments[4].lastStamp, '', 'mai girato: niente data');
  assert.equal(RUN_OUTCOME_CHIP.applied.label, 'Applicato');
  assert.equal(RUN_OUTCOME_CHIP.rejected.label, 'Rifiutato');
  assert.equal(RUN_OUTCOME_CHIP.artifact.label, 'Niente da proporre');
});

test('la card mostra solo gli ultimi 2 incarichi; «Mostra tutti (5)» apre e richiude il resto', async () => {
  const { mount, view } = await paintedView();
  assert.equal(AGENT_RUNS_VISIBLE, 2);
  assert.equal(byClass(mount, 'li', 'bo-agent-assignment').length, 2, 'solo gli ultimi 2');
  const toggle = mount.querySelector('button[data-action="runs-toggle"]');
  assert.ok(toggle, 'c’è «Mostra tutti»');
  assert.equal(toggle.textContent, 'Mostra tutti (5)');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  toggle.dispatch('click', {});
  assert.equal(byClass(mount, 'li', 'bo-agent-assignment').length, 5, 'tutti dopo il clic');
  const open = mount.querySelector('button[data-action="runs-toggle"]');
  assert.equal(open.textContent, 'Mostra meno');
  assert.equal(open.getAttribute('aria-expanded'), 'true');
  view.paint();
  assert.equal(byClass(mount, 'li', 'bo-agent-assignment').length, 5, 'la lettura periodica non richiude la lista');
  mount.querySelector('button[data-action="runs-toggle"]').dispatch('click', {});
  assert.equal(byClass(mount, 'li', 'bo-agent-assignment').length, 2, 'Mostra meno richiude');
});

test('con 2 incarichi o meno non c’è «Mostra tutti»', async () => {
  const { mount } = await paintedView({ assignments: ASSIGNMENTS.slice(0, 2) });
  assert.equal(byClass(mount, 'li', 'bo-agent-assignment').length, 2);
  assert.equal(mount.querySelector('button[data-action="runs-toggle"]'), null);
});

test('ogni riga: frase troncata con il testo intero al passaggio e al clic, esito come chip, data', async () => {
  const { mount } = await paintedView();
  mount.querySelector('button[data-action="runs-toggle"]').dispatch('click', {});
  const rows = byClass(mount, 'li', 'bo-agent-assignment');
  const chips = rows.map((row) => byClass(row, 'span', 'bo-agent-outcome')[0] ?? null);
  assert.deepEqual(chips.map((chip) => chip?.textContent ?? null), ['Applicato', 'Rifiutato', 'Niente da proporre', 'Non riuscito', null]);
  assert.ok(chips[0].classList.contains('bo-agent-outcome-applied') && chips[0].classList.contains('ui-badge-accord'));
  assert.ok(chips[1].classList.contains('bo-agent-outcome-rejected') && chips[1].classList.contains('ui-badge-human'));
  assert.ok(chips[2].classList.contains('bo-agent-outcome-artifact') && chips[2].classList.contains('ui-badge'));
  assert.ok(chips[3].classList.contains('bo-agent-outcome-failed') && chips[3].classList.contains('ui-badge-fault'));
  assert.equal(byClass(rows[0], 'span', 'bo-agent-run-date')[0].textContent, '10 nov, 05:46');
  assert.equal(byClass(rows[0], 'p', 'bo-agent-lastrun').length, 0, 'niente più la frase «Ultimo giro» in corpo grande');
  assert.equal(rows[0].getAttribute('title'), 'Ultimo giro: approvato e applicato, 10 nov, 05:46');
  assert.equal(byClass(rows[3], 'p', 'bo-agent-when')[0].textContent, 'Ogni venerdì alle 08:00 · Attivo');

  const phrase = byClass(rows[0], 'button', 'bo-agent-phrase')[0];
  assert.equal(phrase.textContent, `«${LONG}»`);
  assert.equal(phrase.getAttribute('title'), LONG, 'testo intero al passaggio');
  assert.equal(phrase.getAttribute('type'), 'button', 'raggiungibile da tastiera, Invio la apre');
  assert.equal(phrase.getAttribute('aria-expanded'), 'false');
  phrase.dispatch('click', {});
  assert.ok(phrase.classList.contains('is-open'), 'testo intero all’apertura');
  assert.equal(phrase.getAttribute('aria-expanded'), 'true');
  phrase.dispatch('click', {});
  assert.equal(phrase.classList.contains('is-open'), false, 'un secondo clic la richiude');
});

// ---------------------------------------------------------------------------
// Layout vero: il modulo reale e styles.css in Chromium.
// ---------------------------------------------------------------------------

const CHROMIUM = findChromium();
const BROWSER_SKIP = chromiumRuns(CHROMIUM)
  ? false
  : 'no runnable Chromium here (set CHROMIUM_BIN); the Mac CI runner runs the layout proof';

const FIXTURE_SCRIPT = `
${ADMIN_WRITE_GATE_BROWSER_PRELUDE}
import { createAgentiView } from './admin-agenti.js';
const AGENT = ${JSON.stringify(AGENT)};
const ASSIGNMENTS = ${JSON.stringify(ASSIGNMENTS)};
const RUNS = ${JSON.stringify(RUNS)};
const client = {
  async request(path, options = {}) {
    enforceAdminWriteGate(path, options);
    if (path.startsWith('/api/agents/catalog')) return { agents: [${JSON.stringify(CATALOG_ENTRY)}] };
    if (path.startsWith('/api/modules/teammate-agent/records?')) return { items: [AGENT] };
    if (path.startsWith('/api/modules/teammate-assignment/records?')) return { items: ASSIGNMENTS };
    if (path.startsWith('/api/modules/teammate-run/records?')) return { items: RUNS };
    throw new Error('unexpected ' + path);
  },
};
const mount = document.getElementById('mount');
const view = createAgentiView({ doc: document, mount, client, spaceId: () => 'presti', now: () => '${NOW}', setTimer: () => null, clearTimer: () => {} });
await view.render();
const rect = (node) => node.getBoundingClientRect();
const px = (node) => parseFloat(getComputedStyle(node).fontSize);
const section = document.querySelector('.bo-agenti-section');
const card = document.querySelector('.bo-agent-card');
const name = card.querySelector('.bo-agent-name');
const facts = [...card.querySelectorAll('.bo-agent-fact')].map((fact) => {
  const dd = fact.querySelector('dd');
  const dt = fact.querySelector('dt');
  return {
    term: dt.textContent,
    value: dd.textContent,
    lines: Math.round(rect(dd).height / parseFloat(getComputedStyle(dd).lineHeight === 'normal' ? px(dd) * 1.2 : getComputedStyle(dd).lineHeight)),
    termLines: Math.round(rect(dt).height / (px(dt) * 1.2)),
    clipped: dd.scrollWidth > dd.clientWidth + 1,
    sameLine: Math.abs(rect(dt).bottom - rect(dd).bottom) < 6,
    labelPx: px(dt),
    valuePx: px(dd),
  };
});
const rows = [...card.querySelectorAll('.bo-agent-assignment')];
const rowText = rows.flatMap((row) => [...row.querySelectorAll('*')].filter((node) => node.childElementCount === 0 && node.textContent.trim() !== ''));
const phrase = rows[0].querySelector('.bo-agent-phrase');
const probe = {
  innerWidth: window.innerWidth,
  scrollWidth: document.documentElement.scrollWidth,
  sectionWidth: rect(section).width,
  cardWidth: rect(card).width,
  namePx: px(name),
  maxRowPx: Math.max(...rowText.map(px)),
  rows: rows.length,
  toggle: (card.querySelector('[data-action="runs-toggle"]') ?? { textContent: null }).textContent,
  phraseOneLine: rect(phrase).height < px(phrase) * 2,
  phraseCut: phrase.scrollWidth > phrase.clientWidth,
  facts,
};
document.getElementById('probe').textContent = JSON.stringify(probe);
document.title = 'agenti-card-ready';
`;

function harnessHtml() {
  return '<!doctype html><html lang="it"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<link rel="stylesheet" href="/styles.css">'
    + '<style>body{margin:0;padding:24px 16px}</style></head>'
    + '<body><div id="mount"></div><div id="probe"></div>'
    + `<script type="module">${FIXTURE_SCRIPT}</script></body></html>`;
}

/** @param {Array<string>} args @param {number} timeoutMs */
function runChromium(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(String(CHROMIUM), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`chromium timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

/** @param {number} width */
async function probeAt(width) {
  const dir = new URL('../apps/admin/public/', import.meta.url);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://shot.test');
    if (url.pathname === '/harness.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(harnessHtml());
      return;
    }
    const type = url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : null;
    if (type === null || url.pathname.includes('..')) { res.writeHead(404); res.end('no'); return; }
    try {
      const body = readFileSync(join(dir.pathname, url.pathname.slice(1)), 'utf8');
      res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('no');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const run = /** @type {{ status: number, stdout: string, stderr: string }} */ (await runChromium([
      '--headless', '--dump-dom', `--window-size=${width},1400`, '--virtual-time-budget=8000', '--hide-scrollbars',
      `http://127.0.0.1:${address.port}/harness.html`,
    ], 120000));
    assert.equal(run.status, 0, `chromium exits 0 (stderr: ${run.stderr.slice(-400)})`);
    assert.ok(run.stdout.includes('<title>agenti-card-ready</title>'), 'il modulo ha dipinto la pagina');
    const html = run.stdout.match(/<div id="probe">(.*?)<\/div>/)?.[1] ?? '';
    return JSON.parse(html.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  } finally {
    server.close();
  }
}

/** @param {any} probe @param {number} width */
function assertCardLayout(probe, width) {
  assert.ok(probe.cardWidth >= probe.sectionWidth - 1, `una sola card usa tutta la larghezza (${probe.cardWidth} su ${probe.sectionWidth} a ${width}px)`);
  assert.ok(probe.scrollWidth <= probe.innerWidth, `niente scroll orizzontale a ${width}px (scrollWidth ${probe.scrollWidth})`);
  assert.equal(probe.rows, 2, 'solo gli ultimi 2 incarichi');
  assert.equal(probe.toggle, 'Mostra tutti (5)');
  assert.ok(probe.maxRowPx < probe.namePx, `il nome (${probe.namePx}px) è più forte di ogni testo dei giri (${probe.maxRowPx}px)`);
  assert.ok(probe.phraseOneLine, 'la frase lunga sta su una riga');
  assert.ok(probe.phraseCut, 'e la frase lunga è troncata con ellissi');
  assert.equal(probe.facts.length, 3);
  for (const fact of probe.facts) {
    assert.equal(fact.lines, 1, `«${fact.term}» su una riga a ${width}px`);
    assert.equal(fact.termLines, 1, `l’etichetta «${fact.term}» su una riga a ${width}px`);
    assert.equal(fact.clipped, false, `«${fact.value}» intero a ${width}px`);
    assert.ok(fact.sameLine, `etichetta e valore di «${fact.term}» sulla stessa riga`);
    assert.ok(fact.labelPx < fact.valuePx, 'etichetta piccola, valore chiaro');
  }
}

test('layout reale a 1440 px: card a tutta larghezza, metriche su una riga, giri secondari', { skip: BROWSER_SKIP }, async () => {
  const probe = await probeAt(1440);
  assert.ok(probe.cardWidth > 900, `la card non è una colonna stretta (${probe.cardWidth}px)`);
  assertCardLayout(probe, 1440);
});

test('layout reale a 390 px: una colonna, nessuno scroll orizzontale, metriche leggibili', { skip: BROWSER_SKIP }, async () => {
  const probe = await probeAt(390);
  assertCardLayout(probe, 390);
});
