// @ts-check
/**
 * backlog:c9c266c352d2 — il blur a meta paint non mangia il rifiuto di Crea.
 *
 * Regressione di #1141 (1ff780ec, backlog:776cf3469e64): Crea con Nome vuoto
 * scrive error/field poi paint(); il paint toglie l'input col fuoco e il blur
 * fa scattare il controllo live del nome, che sul ramo vuoto cancellava
 * error/field. focusFieldError riceveva field null e non faceva nessuno
 * scroll, così campo ed errore restavano sotto la barra fissa
 * (tests/admin-agenti-form-browser.test.js f06d06f242d6, Nome a top -40).
 *
 * La cura: sul ramo vuoto il controllo live scrive solo nameError
 * (fieldErrorOf la mostra comunque prima), error/field di Crea restano.
 * RED sul codice di #1141 (dopo il blur error='' e field=null), GREEN con la
 * cura. Il comportamento di #1141 resta: Nome vuoto dice che il nome manca,
 * mai il doppione.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import {
  AGENT_NAME_MISSING_NOTE,
  AGENT_NAME_TAKEN_NOTE,
  createAgentiView,
} from '../apps/admin/public/admin-agenti.js';

const NOW = '2026-11-12T10:00:00.000Z';
const RIAGGANCIO = { id: 1, sourceKey: 'agent:presti:riaggancio', spaceId: 'presti', name: 'Riaggancio', role: 'Ricontatta i clienti', status: 'active' };
const CATALOG = [
  { slug: 'riaggancio', name: 'Riaggancio', role: 'Ricontatta i clienti', instructions: 'Trova…', examplePhrase: 'occupati dei lead', agentSourceKey: 'agent:presti:riaggancio' },
];

/** A server like apps/server for the agents routes. */
function driveClient({ agents = [RIAGGANCIO] } = {}) {
  const calls = [];
  const rows = agents.map((row) => ({ ...row }));
  const assignments = [];
  return {
    calls,
    rows,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      const body = typeof options.body === 'string' && options.body !== '' ? JSON.parse(options.body) : options.body;
      calls.push({ path, method, body, key: options.idempotencyKey });
      if (path.startsWith('/api/agents/catalog')) return { agents: CATALOG };
      if (path.startsWith('/api/modules/teammate-agent/records?')) return { items: rows.map((row) => ({ ...row })) };
      if (path.startsWith('/api/modules/teammate-assignment/records?')) return { items: assignments.map((row) => ({ ...row })) };
      if (path.startsWith('/api/modules/teammate-run/records?')) return { items: [] };
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
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
  return { mount, client, view };
}

const button = (mount, action) => mount.querySelector(`button[data-action="${action}"]`);

function type(mount, name, value) {
  const node = mount.querySelector(`input[name="${name}"]`) ?? mount.querySelector(`textarea[name="${name}"]`);
  assert.ok(node, `the field ${name}`);
  node.value = value;
  node.dispatch('input', {});
}

test('c9c266c352d2: il blur sul Nome vuoto non cancella il rifiuto di Crea', async () => {
  const { mount, view } = await paintedView();
  button(mount, 'new-agent').dispatch('click', {});
  type(mount, 'agent-role', 'Fa gli auguri ai clienti');
  type(mount, 'agent-instructions', 'Ogni mattina prepara gli auguri.');
  button(mount, 'create-agent').dispatch('click', {});
  const form = view.state.newAgent;
  assert.equal(form.error, AGENT_NAME_MISSING_NOTE, 'Crea scrive che il nome manca');
  assert.equal(form.field, 'name', 'Crea punta al campo Nome');
  // Il paint di Crea toglie l'input col fuoco: il blur a meta paint fa
  // scattare il controllo live sul Nome ancora vuoto.
  mount.querySelector('input[name="agent-name"]').dispatch('blur', {});
  assert.equal(form.error, AGENT_NAME_MISSING_NOTE, 'il controllo live non mangia il rifiuto di Crea');
  assert.equal(form.field, 'name', 'il campo del rifiuto resta, lo scroll sotto la barra riparte');
  assert.match(mount.querySelector('.bo-seq-create-error').textContent, /Dagli un nome/, 'a schermo il nome manca');
  assert.ok(!mount.textContent.includes(AGENT_NAME_TAKEN_NOTE), 'mai il doppione sul Nome vuoto');
});
