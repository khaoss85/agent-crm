// @ts-check
/**
 * backlog:7d169a3b1dd2 — Agenti scritti a mano: modifica e ritiro dalla
 * card senza confirm nativo; errori del form accanto al campo (scroll +
 * focus + aria-invalid); senza motore la card spiega la differenza col
 * catalogo e Affida dice che l'incarico aspetta (o è spento); la barra
 * cita un agente del team; al rientro la lista è subito quella buona.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import {
  AGENT_NAME_TAKEN_NOTE,
  AGENT_NO_ENGINE_LABEL,
  AGENT_NO_ENGINE_NOTE,
  AGENT_PAUSED_DONE,
  AGENT_WAIT_ENGINE_DONE,
  agentMentionPlaceholder,
  buildAgentCards,
  checkNewAgent,
  createAgentiView,
  firstTeamAgent,
} from '../apps/admin/public/admin-agenti.js';
import { aiPlaceholder } from '../apps/admin/public/admin-shell.js';
// Namespace import for the f06d06f242d6 names: on main the file still
// loads, so each new test fails on its own assertion.
import * as agentiModule from '../apps/admin/public/admin-agenti.js';

const AGENT_MENTION_NEUTRAL = agentiModule.AGENT_MENTION_NEUTRAL ?? 'Scrivi @ e il nome di un agente, poi cosa deve fare';

const NOW = '2026-11-13T10:00:00.000Z';
const RIAGGANCIO = { id: 1, sourceKey: 'agent:presti:riaggancio', spaceId: 'presti', name: 'Riaggancio', role: 'Ricontatta i clienti', status: 'active' };
const CATALOG = [
  { slug: 'riaggancio', name: 'Riaggancio', role: 'Ricontatta i clienti', instructions: 'Trova…', examplePhrase: 'occupati dei lead', agentSourceKey: 'agent:presti:riaggancio' },
];
const MANO = { id: 2, sourceKey: 'custom-agent:presti:v1.20261113.mano', spaceId: 'presti', name: 'Mano', role: 'Fa cose a mano', instructions: 'Guarda e propone.', status: 'active' };

async function flush() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A server like apps/server for the agents routes: Modifica through
 * POST /api/agents/update and Ritira through POST /api/agents/set-status
 * (the teammate-agent module exposes get,list only, so no PATCH exists —
 * review #879 giro 2). `failWrite` refuses the next update/set-status;
 * `noWriteRoutes` answers them like a deployment whose framework has no
 * agents writes yet (404 naming the missing operation).
 */
function driveClient({ agents = [RIAGGANCIO, MANO], catalog = CATALOG, failCreate = [], failWrite = [], noWriteRoutes = false } = {}) {
  const calls = [];
  const rows = agents.map((row) => ({ ...row }));
  const assignments = [];
  const failures = [...failCreate];
  const writeFailures = [...failWrite];
  const fold = (value) => String(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
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
      if (path.startsWith('/api/modules/teammate-assignment/records?')) return { items: assignments.map((row) => ({ ...row })) };
      if (path.startsWith('/api/modules/teammate-run/records?')) return { items: [] };
      if (path === '/api/agents/create' && method === 'POST') {
        const failure = failures.shift();
        if (failure) throw failure;
        if (rows.some((row) => fold(row.name) === fold(body.name))) {
          throw Object.assign(new Error('name taken'), { code: 'AGENT_NAME_TAKEN', status: 409 });
        }
        const agent = { id: rows.length + 1, sourceKey: `custom-agent:${body.spaceId}:${body.key}`, spaceId: body.spaceId, name: body.name, role: body.role, instructions: body.instructions, status: 'active' };
        rows.push(agent);
        return { duplicate: false, agent };
      }
      if (path === '/api/agents/assign' && method === 'POST') {
        const assignment = { sourceKey: body.sourceKey, agentSourceKey: body.agentSourceKey, phrase: body.phrase, cadence: 'once', status: 'active', decidedAt: NOW };
        assignments.push(assignment);
        return { duplicate: false, assignment };
      }
      if ((path === '/api/agents/update' || path === '/api/agents/set-status') && method === 'POST') {
        if (noWriteRoutes) {
          throw Object.assign(new Error('Operation not found: teammate agents'), { code: 'NOT_FOUND', status: 404 });
        }
        const failure = writeFailures.shift();
        if (failure) throw failure;
        const row = findRow(body);
        if (!row) throw Object.assign(new Error('Unknown agent in this space'), { code: 'AGENT_UNKNOWN', status: 404 });
        if (path === '/api/agents/update') {
          if (body.name !== undefined && rows.some((entry) => entry !== row && fold(entry.name) === fold(body.name))) {
            throw Object.assign(new Error('name taken'), { code: 'AGENT_NAME_TAKEN', status: 409 });
          }
          for (const field of ['name', 'role', 'instructions', 'spendingCapCents']) {
            if (body[field] !== undefined) row[field] = body[field];
          }
          return { agent: { ...row } };
        }
        if (body.status !== 'active' && body.status !== 'paused') {
          throw Object.assign(new Error('bad status'), { code: 'VALIDATION_ERROR', status: 400 });
        }
        const duplicate = row.status === body.status;
        row.status = body.status;
        return { agent: { ...row }, duplicate };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}

const posts = (client, path) => client.calls.filter((call) => call.method === 'POST' && (!path || call.path === path));

async function paintedView(options) {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = driveClient(options);
  const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW, setTimer: () => null, clearTimer: () => {} });
  await view.render();
  await flush();
  return { mount, client, view };
}

const button = (mount, action) => mount.querySelector(`button[data-action="${action}"]`);

test('7d169a3b1dd2: il rifiuto dice a quale campo manca', () => {
  assert.equal(checkNewAgent({ name: '', role: 'r', instructions: 'i' }).field, 'name');
  assert.equal(checkNewAgent({ name: 'A', role: ' ', instructions: 'i' }).field, 'role');
  assert.equal(checkNewAgent({ name: 'A', role: 'r', instructions: '' }).field, 'instructions');
  assert.equal(checkNewAgent({ name: 'A', role: 'r', instructions: 'i', cap: 'dieci' }).field, 'cap');
  assert.equal(checkNewAgent({ name: 'A', role: 'r', instructions: 'i', cap: '0' }).field, 'cap');
  assert.equal(checkNewAgent({ name: 'Riaggancio', role: 'r', instructions: 'i' }, [RIAGGANCIO]).field, 'name');
  const ok = checkNewAgent({ name: 'Mano', role: 'r', instructions: 'i' });
  assert.equal(ok.field, undefined, 'quando passa non c’è nessun campo da segnare');
});

test('7d169a3b1dd2: il segnaposto della barra cita un agente del team', () => {
  assert.equal(firstTeamAgent([]), '');
  assert.equal(firstTeamAgent([RIAGGANCIO, MANO]), 'Riaggancio');
  assert.match(agentMentionPlaceholder([MANO]), /@Mano/);
  // backlog:f06d06f242d6: no agent that can work → a neutral line, never an @name that reaches nobody.
  assert.equal(agentMentionPlaceholder([]), AGENT_MENTION_NEUTRAL, 'senza team, un testo neutro');
  assert.match(aiPlaceholder('agenti', 'Mano'), /@Mano/, 'la barra Agenti nomina il team');
  assert.equal(aiPlaceholder('agenti'), AGENT_MENTION_NEUTRAL, 'senza nome, il testo neutro');
  assert.doesNotMatch(aiPlaceholder('agenti'), /@\p{L}/u, 'nessun @nome');
});

test('f06d06f242d6: il segnaposto nomina solo un agente che può lavorare (attivo e con motore)', () => {
  // Mano is hand-written: no engine in this space (the catalogue has only Riaggancio).
  assert.equal(firstTeamAgent([MANO, RIAGGANCIO], CATALOG), 'Riaggancio', 'salta l’agente senza motore');
  assert.equal(firstTeamAgent([MANO], CATALOG), '', 'solo agenti senza motore: nessun nome');
  assert.equal(agentMentionPlaceholder([MANO], CATALOG), AGENT_MENTION_NEUTRAL, 'e la barra resta neutra');
  assert.equal(firstTeamAgent([{ ...RIAGGANCIO, status: 'paused' }, MANO], CATALOG), '', 'un agente ritirato non lavora');
  assert.match(agentMentionPlaceholder([MANO, RIAGGANCIO], CATALOG), /@Riaggancio/);
});

test('7d169a3b1dd2: la card di un agente scritto a mano porta id e custom; il catalogo no', () => {
  const [hand, catalog] = buildAgentCards({ agents: [MANO, RIAGGANCIO], assignments: [], runs: [], nowIso: NOW, catalog: CATALOG });
  assert.equal(hand.custom, true);
  // Modifica/Ritira scrivono con la sourceKey, mai con l'id di riga.
  assert.equal(hand.sourceKey, MANO.sourceKey);
  assert.equal(hand.engine, false, 'scritto a mano: nessun motore in questo spazio');
  assert.equal(catalog.custom, false);
});

test('7d169a3b1dd2: senza motore la card spiega la differenza col catalogo', async () => {
  const { mount } = await paintedView();
  assert.ok(mount.textContent.includes(AGENT_NO_ENGINE_NOTE), 'la nota dice che qui lavorano solo quelli del catalogo');
  assert.ok(mount.textContent.includes('catalogo'));
});

test('7d169a3b1dd2: l’errore del form sta accanto al campo, col focus sopra', async () => {
  const { mount } = await paintedView();
  button(mount, 'new-agent').dispatch('click', {});
  button(mount, 'create-agent').dispatch('click', {});
  const name = mount.querySelector('input[name="agent-name"]');
  assert.equal(name.getAttribute('aria-invalid'), 'true', 'il campo rifiutato si segna');
  assert.equal(mount.querySelector('input[name="agent-role"]').getAttribute('aria-invalid'), null, 'gli altri no');
  const errors = mount.findAll('p').filter((node) => node.classList.contains('bo-agent-field-error'));
  assert.equal(errors.length, 1, 'un solo errore, quello del nome');
  assert.match(errors[0].textContent, /Dagli un nome/);
  assert.equal(errors[0].getAttribute('role'), 'alert');
  assert.ok(name.__focused, 'il fuoco va sul campo da correggere');
});

test('7d169a3b1dd2: un nome già preso resta un rifiuto in cima, non del campo', async () => {
  // Libero nel controllo locale, preso sul server nel frattempo.
  const taken = Object.assign(new Error('taken'), { code: 'AGENT_NAME_TAKEN', status: 409 });
  const { mount } = await paintedView({ agents: [MANO], failCreate: [taken] });
  button(mount, 'new-agent').dispatch('click', {});
  const name = mount.querySelector('input[name="agent-name"]');
  name.value = 'Riaggancio';
  name.dispatch('input', {});
  const role = mount.querySelector('input[name="agent-role"]');
  role.value = 'Fa cose';
  role.dispatch('input', {});
  const instructions = mount.querySelector('textarea[name="agent-instructions"]');
  instructions.value = 'Guarda e propone.';
  instructions.dispatch('input', {});
  button(mount, 'create-agent').dispatch('click', {});
  await flush();
  assert.equal(mount.querySelector('.bo-seq-create-error').textContent, AGENT_NAME_TAKEN_NOTE);
  assert.equal(mount.findAll('p').filter((node) => node.classList.contains('bo-agent-field-error')).length, 0, 'il server non punta a un campo');
});

test('7d169a3b1dd2: Modifica salva con update-agent, con la chiave del chiamante', async () => {
  const { mount, client } = await paintedView();
  button(mount, 'edit-agent').dispatch('click', {});
  const panel = mount.querySelector(`div[data-edit="${MANO.sourceKey}"]`);
  assert.ok(panel, 'il pannello si apre sulla card');
  const name = panel.querySelector('input[name="agent-edit-name"]');
  name.value = 'Manona';
  name.dispatch('input', {});
  panel.querySelector('button[data-action="save-agent-edit"]').dispatch('click', {});
  await flush();
  const updates = posts(client, '/api/agents/update');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].body.spaceId, 'presti');
  assert.equal(updates[0].body.agentSourceKey, MANO.sourceKey, 'la riga si punta per sourceKey, mai per id');
  assert.equal(updates[0].body.name, 'Manona');
  assert.ok(typeof updates[0].key === 'string' && updates[0].key.length > 0, 'Idempotency-Key del chiamante');
  assert.ok(mount.textContent.includes('Manona aggiornato.'));
});

test('7d169a3b1dd2: la Modifica rifiutata dal server resta in cima, senza segnare un campo', async () => {
  // Review #879 giro 2 P2: il rifiuto non eredita il marcatore di campo.
  const boom = Object.assign(new Error('down'), { status: 500 });
  const { mount, client } = await paintedView({ failWrite: [boom] });
  button(mount, 'edit-agent').dispatch('click', {});
  const panel = mount.querySelector(`div[data-edit="${MANO.sourceKey}"]`);
  const name = panel.querySelector('input[name="agent-edit-name"]');
  name.value = '';
  name.dispatch('input', {});
  panel.querySelector('button[data-action="save-agent-edit"]').dispatch('click', {});
  await flush();
  assert.match(mount.querySelector('input[name="agent-edit-name"]').getAttribute('aria-invalid'), /true/, 'il controllo locale resta segnato');
  const fixed = mount.querySelector('input[name="agent-edit-name"]');
  fixed.value = 'Manona';
  fixed.dispatch('input', {});
  mount.querySelector('button[data-action="save-agent-edit"]').dispatch('click', {});
  await flush();
  assert.equal(posts(client, '/api/agents/update').length, 1);
  const top = mount.findAll('p').filter((node) => node.classList.contains('bo-seq-create-error'));
  assert.equal(top.length, 1, 'un solo errore, in cima al pannello');
  assert.equal(top[0].getAttribute('role'), 'alert');
  assert.match(top[0].textContent, /riprova tra poco/);
  assert.equal(mount.findAll('p').filter((node) => node.classList.contains('bo-agent-field-error')).length, 0, 'nessun errore accanto a un campo');
  assert.equal(mount.querySelector('input[name="agent-edit-name"]').getAttribute('aria-invalid'), null);
});

test('7d169a3b1dd2: la Modifica rifiutata mette il fuoco sul campo vivo', async () => {
  // Review #879 giro 2 P2: dopo paint() il fuoco corre sul mount vivo.
  const { mount } = await paintedView();
  button(mount, 'edit-agent').dispatch('click', {});
  const panel = mount.querySelector(`div[data-edit="${MANO.sourceKey}"]`);
  const name = panel.querySelector('input[name="agent-edit-name"]');
  name.value = '';
  name.dispatch('input', {});
  panel.querySelector('button[data-action="save-agent-edit"]').dispatch('click', {});
  await flush();
  const live = mount.querySelector('input[name="agent-edit-name"]');
  assert.equal(live.getAttribute('aria-invalid'), 'true', 'il campo rifiutato si segna');
  assert.ok(live.__focused, 'il fuoco va sul controllo vivo del pannello Modifica');
});

test('7d169a3b1dd2: la Modifica su un nome preso resta in cima con la nota del nome', async () => {
  const taken = Object.assign(new Error('taken'), { code: 'AGENT_NAME_TAKEN', status: 409 });
  const { mount } = await paintedView({ agents: [MANO], failWrite: [taken] });
  button(mount, 'edit-agent').dispatch('click', {});
  const panel = mount.querySelector(`div[data-edit="${MANO.sourceKey}"]`);
  const name = panel.querySelector('input[name="agent-edit-name"]');
  name.value = 'Riaggancio';
  name.dispatch('input', {});
  panel.querySelector('button[data-action="save-agent-edit"]').dispatch('click', {});
  await flush();
  assert.ok(mount.textContent.includes(AGENT_NAME_TAKEN_NOTE));
  assert.equal(mount.findAll('p').filter((node) => node.classList.contains('bo-agent-field-error')).length, 0, 'in cima, non del campo');
});

test('7d169a3b1dd2: su un deploy senza le scritture agenti la Modifica legge neutra', async () => {
  // Review #879 giro 2 P1: il 404 che nomina l'operazione mancante non è
  // un errore e non dice «non sono attivi».
  const { mount, client } = await paintedView({ noWriteRoutes: true });
  button(mount, 'edit-agent').dispatch('click', {});
  const panel = mount.querySelector(`div[data-edit="${MANO.sourceKey}"]`);
  panel.querySelector('button[data-action="save-agent-edit"]').dispatch('click', {});
  await flush();
  assert.equal(posts(client, '/api/agents/update').length, 1, 'una sola POST rifiutata dal deploy senza scritture');
  const live = mount.querySelector(`div[data-edit="${MANO.sourceKey}"]`);
  assert.ok(live && live.findAll('p').some((node) => node.classList.contains('bo-agent-edit-unavailable')), 'nota neutra nel pannello');
  assert.ok(!mount.textContent.includes('non sono attivi'), 'mai la riga del non attivo');
});

test('7d169a3b1dd2: Ritira chiede Conferma in linea e mette in pausa, mai un dialog nativo', async () => {
  const { mount, client } = await paintedView();
  button(mount, 'retire-agent').dispatch('click', {});
  assert.ok(mount.querySelector('button[data-action="confirm-retire-agent"]'), 'prima chiede, in linea');
  assert.equal(posts(client, '/api/agents/set-status').length, 0, 'niente scrittura prima della conferma');
  mount.querySelector('button[data-action="confirm-retire-agent"]').dispatch('click', {});
  await flush();
  const pauses = posts(client, '/api/agents/set-status');
  assert.equal(pauses.length, 1);
  assert.deepEqual(pauses[0].body, { spaceId: 'presti', agentSourceKey: MANO.sourceKey, status: 'paused' });
  assert.ok(typeof pauses[0].key === 'string' && pauses[0].key.length > 0, 'Idempotency-Key del chiamante');
  assert.ok(mount.textContent.includes('Mano ritirato: resta nel team ma non riceve più incarichi.'));
});

test('7d169a3b1dd2: Ritira su un deploy senza le scritture agenti legge neutra', async () => {
  const { mount } = await paintedView({ noWriteRoutes: true });
  button(mount, 'retire-agent').dispatch('click', {});
  mount.querySelector('button[data-action="confirm-retire-agent"]').dispatch('click', {});
  await flush();
  const live = mount.findAll('div').find((node) => node.classList.contains('bo-agent-retire'));
  assert.ok(live && live.findAll('p').some((node) => node.classList.contains('bo-agent-retire-unavailable')), 'nota neutra nella conferma');
});

test('7d169a3b1dd2: Affida dice che l’incarico aspetta il motore, o che è spento', async () => {
  const plain = { ...MANO, spendingCapCents: undefined };
  const first = await paintedView({ agents: [plain] });
  const card = first.mount.querySelector(`article[data-agent="${MANO.sourceKey}"]`);
  card.querySelector(`input[name="talk-${MANO.sourceKey}"]`).value = 'ogni lunedì fai gli auguri';
  card.querySelector('form').dispatch('submit', {});
  await flush();
  assert.equal(posts(first.client, '/api/agents/assign').length, 1);
  assert.ok(first.mount.textContent.includes(AGENT_WAIT_ENGINE_DONE), 'aspetta il motore e parte da solo');

  const second = await paintedView({ agents: [{ ...plain, status: 'paused' }] });
  const paused = second.mount.querySelector(`article[data-agent="${MANO.sourceKey}"]`);
  paused.querySelector(`input[name="talk-${MANO.sourceKey}"]`).value = 'ogni lunedì fai gli auguri';
  paused.querySelector('form').dispatch('submit', {});
  await flush();
  assert.ok(second.mount.textContent.includes(AGENT_PAUSED_DONE), 'in pausa: l’incarico resta fermo');
});

test('7d169a3b1dd2: al rientro la lista è subito quella buona, poi si rilegge', async () => {
  await paintedView({ agents: [MANO] });
  const doc = createFakeDocument();
  const mount = createMount();
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = driveClient({ agents: [{ ...MANO, name: 'Manona' }] });
  const realRequest = client.request.bind(client);
  client.request = (path, options = {}) => {
    if (path.startsWith('/api/modules/teammate-agent/records?')) return gate;
    return realRequest(path, options);
  };
  const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW, setTimer: () => null, clearTimer: () => {} });
  const pending = view.render();
  await flush();
  assert.ok(mount.textContent.includes('Mano'), 'dipinto subito dalla cache');
  release({ items: [{ ...MANO, name: 'Manona' }] });
  await pending;
  await flush();
  assert.ok(mount.textContent.includes('Manona'), 'la rilettura sostituisce la cache');
});

// ---- backlog:f06d06f242d6 (verifica 14/11 05:49Z, pilota 1e10e62) ----------

/** A fake document that, like the real one, knows where the focus is. */
function focusingDocument() {
  const doc = createFakeDocument();
  const make = doc.createElement;
  doc.activeElement = null;
  doc.createElement = (tag) => {
    const node = make(tag);
    node.focus = (options) => { doc.activeElement = node; node.__focused = true; node.focusOptions = options ?? null; };
    return node;
  };
  return doc;
}

async function focusedView(options) {
  const doc = focusingDocument();
  const mount = createMount();
  const client = driveClient(options);
  const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW, setTimer: () => null, clearTimer: () => {} });
  await view.render();
  await flush();
  return { doc, mount, client, view };
}

test('f06d06f242d6: aprendo «Nuovo agente» il cursore è in Nome, e una rilettura non lo porta via', async () => {
  const { doc, mount, view } = await focusedView();
  button(mount, 'new-agent').dispatch('click', {});
  const name = mount.querySelector('input[name="agent-name"]');
  assert.equal(doc.activeElement, name, 'il cursore è nel campo Nome');
  name.value = 'Aug';
  name.dispatch('input', {});
  name.selectionStart = 3;
  name.selectionEnd = 3;
  // The periodic read lands while the operator types: the page repaints.
  view.paint();
  const fresh = mount.querySelector('input[name="agent-name"]');
  assert.notEqual(fresh, name, 'la pagina è ridisegnata');
  assert.equal(fresh.value, 'Aug', 'quello che ha scritto resta');
  assert.equal(doc.activeElement, fresh, 'e il cursore resta in Nome');
});

test('f06d06f242d6: un nome già nel team si vede subito, accanto al campo e legato a lui', async () => {
  const { mount, client } = await focusedView();
  button(mount, 'new-agent').dispatch('click', {});
  const name = mount.querySelector('input[name="agent-name"]');
  name.value = 'riaggancio';
  name.dispatch('input', {});
  // No other field filled, no Crea pressed.
  const error = mount.findAll('p').find((node) => node.classList.contains('bo-agent-field-error'));
  assert.ok(error, 'l’errore compare mentre scrive');
  assert.equal(error.textContent, AGENT_NAME_TAKEN_NOTE);
  assert.equal(error.parentNode, name.parentNode, 'accanto al campo');
  const id = error.getAttribute('id');
  assert.ok(id, 'l’errore ha un id');
  assert.equal(name.getAttribute('aria-describedby'), id, 'il campo lo nomina (aria-describedby)');
  assert.equal(name.getAttribute('aria-errormessage'), id, 'e come messaggio d’errore (aria-errormessage)');
  assert.equal(name.getAttribute('aria-invalid'), 'true');
  assert.equal(mount.querySelector('input[name="agent-name"]'), name, 'nessun ridisegno: il campo è lo stesso');
  assert.equal(posts(client).length, 0, 'nessuna scrittura');
  name.value = 'Riaggancio 2';
  name.dispatch('input', {});
  assert.equal(mount.findAll('p').filter((node) => node.classList.contains('bo-agent-field-error')).length, 0, 'cambiando nome l’errore va via');
  assert.equal(name.getAttribute('aria-describedby'), null);
  assert.equal(name.getAttribute('aria-invalid'), null);
});

test('f06d06f242d6: anche l’errore di Crea è legato al suo campo', async () => {
  const { mount } = await focusedView();
  button(mount, 'new-agent').dispatch('click', {});
  button(mount, 'create-agent').dispatch('click', {});
  const name = mount.querySelector('input[name="agent-name"]');
  const error = mount.findAll('p').find((node) => node.classList.contains('bo-agent-field-error'));
  assert.match(error.textContent, /Dagli un nome/);
  assert.equal(name.getAttribute('aria-describedby'), error.getAttribute('id'));
  assert.equal(name.getAttribute('aria-errormessage'), error.getAttribute('id'));
  assert.equal(name.focusOptions?.preventScroll, true, 'il fuoco non salta: lo scroll lo fa la riga, sotto la barra');
});

test('f06d06f242d6: in Modifica, Salva e Annulla sono gli stessi del form nuovo', async () => {
  const { mount } = await focusedView();
  button(mount, 'new-agent').dispatch('click', {});
  const create = button(mount, 'create-agent');
  const cancelNew = button(mount, 'cancel-agent');
  const createClass = create.getAttribute('class');
  const cancelNewClass = cancelNew.getAttribute('class');
  cancelNew.dispatch('click', {});
  button(mount, 'edit-agent').dispatch('click', {});
  assert.equal(button(mount, 'save-agent-edit').getAttribute('class'), createClass, 'Salva come «Crea l’agente»');
  assert.equal(button(mount, 'cancel-agent-edit').getAttribute('class'), cancelNewClass, 'Annulla come nel form nuovo');
});

test('f06d06f242d6: dopo Riattiva la riga usa le parole del badge', async () => {
  const { mount } = await focusedView({ agents: [RIAGGANCIO, { ...MANO, status: 'paused' }] });
  button(mount, 'retire-agent').dispatch('click', {});
  mount.querySelector('button[data-action="confirm-retire-agent"]').dispatch('click', {});
  await flush();
  assert.ok(!mount.textContent.includes('di nuovo attivo'), 'mai «attivo» per un agente che aspetta il motore');
  assert.ok(mount.textContent.includes(`Mano riattivato: ${AGENT_NO_ENGINE_LABEL.charAt(0).toLowerCase()}${AGENT_NO_ENGINE_LABEL.slice(1)}.`),
    'la riga dice quello che dice il badge');
  assert.ok(mount.textContent.includes(AGENT_NO_ENGINE_LABEL), 'e il badge lo conferma');
});

// ---- Review Muse #895, giro 1 ------------------------------------------------

test('review #895: scrivere il nome tocca solo l’errore del nome — quello del ruolo resta', async () => {
  const { mount, view } = await focusedView();
  button(mount, 'new-agent').dispatch('click', {});
  const name = mount.querySelector('input[name="agent-name"]');
  name.value = 'Auguri';
  name.dispatch('input', {});
  button(mount, 'create-agent').dispatch('click', {});
  const roleError = () => mount.querySelector('input[name="agent-role"]').parentNode.childNodes
    .find((node) => node.getAttribute?.('data-field-error') === 'true') ?? null;
  assert.match(roleError()?.textContent ?? '', /Scrivi in poche parole/, 'Crea segna il ruolo');
  assert.equal(view.state.newAgent.field, 'role');
  const live = mount.querySelector('input[name="agent-name"]');
  live.value = 'Auguri di Natale';
  live.dispatch('input', {});
  assert.equal(view.state.newAgent.field, 'role', 'nello stato l’errore del ruolo resta');
  assert.match(view.state.newAgent.error, /Scrivi in poche parole/);
  assert.match(roleError()?.textContent ?? '', /Scrivi in poche parole/, 'e anche sullo schermo');
  live.value = 'riaggancio';
  live.dispatch('input', {});
  assert.equal(live.getAttribute('aria-invalid'), 'true', 'il nome doppione si segna sul nome');
  assert.match(roleError()?.textContent ?? '', /Scrivi in poche parole/, 'senza cancellare il ruolo');
  view.paint();
  const errors = mount.findAll('p').filter((node) => node.classList.contains('bo-agent-field-error')).map((node) => node.textContent);
  assert.equal(errors.length, 2, 'dopo un ridisegno: due errori, uno per campo');
  assert.ok(errors.includes(AGENT_NAME_TAKEN_NOTE));
});

test('review #895: il cursore torna nel pannello Modifica giusto anche con una chiave che contiene « " » e « ] »', async () => {
  const odd = { ...MANO, id: 3, sourceKey: 'custom-agent:presti:a"b]c', name: 'Strano' };
  const { doc, mount, view } = await focusedView({ agents: [RIAGGANCIO, MANO, odd] });
  // Like a real Element: a selector with the raw key in it is not valid
  // CSS (SyntaxError), and closest() finds the panel around a field.
  const strict = mount.querySelector.bind(mount);
  mount.querySelector = (selector) => {
    if (String(selector).includes(odd.sourceKey)) throw new SyntaxError(`'${selector}' is not a valid selector`);
    return strict(selector);
  };
  const make = doc.createElement;
  doc.createElement = (tag) => {
    const node = make(tag);
    node.closest = (selector) => {
      if (selector !== '[data-edit]') return null;
      for (let at = node; at; at = at.parentNode) if (at.getAttribute?.('data-edit') != null) return at;
      return null;
    };
    return node;
  };
  view.paint(); // the page again, with the browser-like nodes
  const card = mount.findAll('article').find((node) => node.textContent.includes('Strano'))
    ?? mount.findAll('div').find((node) => String(node.getAttribute('class') ?? '').includes('bo-agent-card') && node.textContent.includes('Strano'));
  assert.ok(card, 'la card con la chiave strana c’è');
  const edit = card.findAll('button').find((node) => node.getAttribute('data-action') === 'edit-agent');
  edit.dispatch('click', {});
  const panel = mount.findAll('div').find((node) => node.getAttribute('data-edit') === odd.sourceKey);
  assert.ok(panel, 'il pannello Modifica si apre');
  const field = panel.findAll('input').find((node) => node.getAttribute('name') === 'agent-edit-name');
  assert.equal(doc.activeElement, field, 'aprendo Modifica il cursore è nel suo Nome');
  assert.doesNotThrow(() => view.paint(), 'il ridisegno non lancia su una chiave con « " » e « ] »');
  const freshPanel = mount.findAll('div').find((node) => node.getAttribute('data-edit') === odd.sourceKey);
  const fresh = freshPanel.findAll('input').find((node) => node.getAttribute('name') === 'agent-edit-name');
  assert.notEqual(fresh, field, 'la pagina è ridisegnata');
  assert.equal(doc.activeElement, fresh, 'e il cursore è tornato nel Nome dello stesso pannello');
});
