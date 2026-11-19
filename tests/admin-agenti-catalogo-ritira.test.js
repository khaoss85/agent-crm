// @ts-check
/**
 * backlog:8605b6f520c0 — Un agente aggiunto dal catalogo non si poteva
 * fermare: la sua card mostrava solo «Affida», senza «Ritira»/«Riattiva».
 * La card dal catalogo ora porta lo stesso interruttore a due passi
 * (Ritira chiede Conferma in linea, poi POST /api/agents/set-status by
 * sourceKey), mentre «Modifica» resta solo per gli scritti a mano: il
 * catalogo possiede le sue righe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import {
  AGENT_STATUS_LABEL,
  buildAgentCards,
  createAgentiView,
} from '../apps/admin/public/admin-agenti.js';
// The real server-side validator: the double below writes only what the
// server would accept (backlog:8605b6f520c0 review giro 1 P1).
import { checkAgentStatusInput } from '../packages/agents/src/agents.js';

const NOW = '2026-11-13T10:00:00.000Z';
const RISPOSTE = { id: 7, sourceKey: 'agent:presti:risposte', spaceId: 'presti', name: 'Risposte', role: 'Risponde ai clienti', status: 'active' };
const CATALOG = [
  { slug: 'risposte', name: 'Risposte', role: 'Risponde ai clienti', instructions: 'Rispondi…', examplePhrase: 'rispondi ai clienti', agentSourceKey: 'agent:presti:risposte' },
];
const MANO = { id: 2, sourceKey: 'custom-agent:presti:v1.20261113.mano', spaceId: 'presti', name: 'Mano', role: 'Fa cose a mano', instructions: 'Guarda e propone.', status: 'active' };

async function flush() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Same /bo double as the modifica suite, with a catalogue-added agent. */
function driveClient({ agents = [RISPOSTE, MANO], catalog = CATALOG } = {}) {
  const calls = [];
  const rows = agents.map((row) => ({ ...row }));
  const findRow = (body) => rows.find((entry) => entry.sourceKey === body.agentSourceKey && entry.spaceId === body.spaceId);
  return {
    calls,
    rows,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      const body = typeof options.body === 'string' && options.body !== '' ? JSON.parse(options.body) : options.body;
      calls.push({ path, method, body, key: options.idempotencyKey });
      if (path.startsWith('/api/agents/catalog')) return { agents: catalog };
      if (path.startsWith('/api/modules/teammate-agent/records?')) return { items: rows.map((row) => ({ ...row })) };
      if (path.startsWith('/api/modules/teammate-assignment/records?')) return { items: [] };
      if (path.startsWith('/api/modules/teammate-run/records?')) return { items: [] };
      if (path === '/api/agents/set-status' && method === 'POST') {
        const checked = checkAgentStatusInput(body);
        const row = findRow(checked);
        if (!row) throw Object.assign(new Error('Unknown agent in this space'), { code: 'AGENT_UNKNOWN', status: 404 });
        const duplicate = row.status === checked.status;
        row.status = checked.status;
        return { agent: { ...row }, duplicate };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}

async function paintedView(options) {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = driveClient(options);
  const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW, setTimer: () => null, clearTimer: () => {} });
  await view.render();
  await flush();
  return { mount, client, view };
}

const cardButton = (mount, sourceKey, action) => mount.findAll('article')
  .find((node) => node.getAttribute('data-agent') === sourceKey)
  .findAll('button').find((node) => node.getAttribute('data-action') === action);

const posts = (client, path) => client.calls.filter((call) => call.method === 'POST' && call.path === path);

test('8605b6f520c0: la card da catalogo ha Ritira ma non Modifica', async () => {
  const { mount } = await paintedView();
  const [catalog] = buildAgentCards({ agents: [RISPOSTE], assignments: [], runs: [], nowIso: NOW, catalog: CATALOG });
  assert.equal(catalog.custom, false, 'resta del catalogo');
  assert.equal(catalog.engine, true, 'con motore nello spazio');
  assert.ok(cardButton(mount, RISPOSTE.sourceKey, 'retire-agent'), 'Ritira c’è');
  assert.equal(cardButton(mount, RISPOSTE.sourceKey, 'retire-agent').textContent, 'Ritira');
  assert.equal(cardButton(mount, RISPOSTE.sourceKey, 'edit-agent'), undefined, 'Modifica no: le righe del catalogo le possiede il catalogo');
  assert.ok(cardButton(mount, MANO.sourceKey, 'edit-agent'), 'lo scritto a mano tiene Modifica');
});

test('8605b6f520c0: Ritira su un agente da catalogo chiede Conferma e mette in pausa', async () => {
  const { mount, client } = await paintedView();
  cardButton(mount, RISPOSTE.sourceKey, 'retire-agent').dispatch('click', {});
  assert.ok(cardButton(mount, RISPOSTE.sourceKey, 'confirm-retire-agent'), 'prima chiede, in linea');
  assert.equal(posts(client, '/api/agents/set-status').length, 0, 'niente scrittura prima della conferma');
  cardButton(mount, RISPOSTE.sourceKey, 'confirm-retire-agent').dispatch('click', {});
  await flush();
  const pauses = posts(client, '/api/agents/set-status');
  assert.equal(pauses.length, 1, 'una sola scrittura');
  assert.deepEqual(pauses[0].body, { spaceId: 'presti', agentSourceKey: RISPOSTE.sourceKey, status: 'paused' });
  assert.ok(typeof pauses[0].key === 'string' && pauses[0].key.length > 0, 'Idempotency-Key del chiamante');
  assert.ok(mount.textContent.includes('Risposte ritirato: resta nel team ma non riceve più incarichi.'), 'la riga lo dice');
  assert.equal(cardButton(mount, RISPOSTE.sourceKey, 'retire-agent').textContent, 'Riattiva', 'dopo la rilettura la card offre Riattiva');
  assert.ok(mount.textContent.includes(AGENT_STATUS_LABEL.paused), 'il badge dice In pausa');
});

test('8605b6f520c0: Riattiva su un agente da catalogo in pausa lo rimette attivo', async () => {
  const { mount, client } = await paintedView({ agents: [{ ...RISPOSTE, status: 'paused' }] });
  assert.equal(cardButton(mount, RISPOSTE.sourceKey, 'retire-agent').textContent, 'Riattiva');
  cardButton(mount, RISPOSTE.sourceKey, 'retire-agent').dispatch('click', {});
  cardButton(mount, RISPOSTE.sourceKey, 'confirm-retire-agent').dispatch('click', {});
  await flush();
  const resumes = posts(client, '/api/agents/set-status');
  assert.equal(resumes.length, 1, 'una sola scrittura');
  assert.deepEqual(resumes[0].body, { spaceId: 'presti', agentSourceKey: RISPOSTE.sourceKey, status: 'active' });
  assert.ok(mount.textContent.includes('Risposte riattivato:'), 'la riga lo dice');
  assert.equal(cardButton(mount, RISPOSTE.sourceKey, 'retire-agent').textContent, 'Ritira', 'di nuovo fermabile');
});
