import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSequenzaDettaglio,
  buildSequenzeElenco,
  createSequenzeView,
  loadSequenzeData,
  sequenceChannelLabel,
  sequenceDayLabel,
  sequenceStatusLabel,
  enrollmentStatusLabel,
  sequenzaOfferedAction,
} from '../apps/admin/public/admin-sequenze.js';
import { buildShellNav } from '../apps/admin/public/admin-shell.js';
import { parseModuleRoute, shellNavInput } from '../apps/admin/public/admin-core.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * Backoffice "10 Sequenze" (backlog:925808b3f193, BO-F3-03): elenco with
 * state and counted metrics, dettaglio with day+channel steps, people with
 * states, activate/pause with a second ask. These tests drive the real view
 * code with the dependency-free fake DOM — no browser.
 */

const SEQUENCE = {
  id: 7,
  sourceKey: 'seq-bentornato',
  spaceId: 'presti',
  name: 'Bentornato in palestra',
  status: 'draft',
};
const STEPS = [
  { id: 2, sequenceSourceKey: 'seq-bentornato', spaceId: 'presti', stepOrder: 1, dayOffset: 2, channel: 'email', templateName: 'Ritroviamoci', templateLanguage: 'it', templateVars: '["name"]' },
  { id: 1, sequenceSourceKey: 'seq-bentornato', spaceId: 'presti', stepOrder: 0, dayOffset: 0, channel: 'whatsapp', templateName: 'Ciao, ci manchi', templateLanguage: 'it', templateVars: '["name"]' },
];
const ENROLLMENTS = [
  { id: 11, sequenceSourceKey: 'seq-bentornato', spaceId: 'presti', subjectLabel: 'Giulia Rossi', status: 'active', currentStep: 0, nextDueAt: '2026-10-26T09:00:00.000Z' },
  { id: 12, sequenceSourceKey: 'seq-bentornato', spaceId: 'presti', subjectLabel: 'Marco Bianchi', status: 'stopped-replied', currentStep: 1, nextDueAt: null },
];
const SENDS = [
  { id: 21, sequenceSourceKey: 'seq-bentornato', spaceId: 'presti', status: 'sent' },
  { id: 22, sequenceSourceKey: 'seq-bentornato', spaceId: 'presti', status: 'waiting-approval' },
];

/** Flush the view's async work: clicks resolve promises across ticks. */
async function flush() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function stubClient({ sequences = [SEQUENCE], steps = STEPS, failAction = null } = {}) {
  const calls = [];
  return {
    calls,
    request: async (path, options = {}) => {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/schema') return { domains: { sequences: { sequencesContract: 1 } } };
      if (path.startsWith('/api/modules/sequence/records?')) return { items: sequences };
      if (path.startsWith('/api/modules/sequence-enrollment/records?')) return { items: ENROLLMENTS };
      if (path.startsWith('/api/modules/sequence-send/records?')) return { items: SENDS };
      if (path.startsWith('/api/modules/sequence-step/records?')) return { items: steps };
      if (path.includes('/actions/')) {
        if (failAction) {
          const error = new Error(failAction);
          throw error;
        }
        return { ok: true, action: path.split('/actions/')[1] };
      }
      throw new Error(`unexpected request ${path}`);
    },
  };
}

test('sequence states read in Italian, unknown states say so', () => {
  assert.equal(sequenceStatusLabel('draft'), 'Bozza');
  assert.equal(sequenceStatusLabel('active'), 'Attiva');
  assert.equal(sequenceStatusLabel('paused'), 'In pausa');
  assert.equal(sequenceStatusLabel('flying'), 'Stato sconosciuto');
  assert.equal(enrollmentStatusLabel('stopped-replied'), 'Fermata alla risposta');
  assert.equal(enrollmentStatusLabel('completed'), 'Completata');
});

test('step day and channel read plainly: day zero fires at once', () => {
  assert.equal(sequenceDayLabel(0), 'Giorno 0 · parte subito');
  assert.equal(sequenceDayLabel(2), 'Giorno 2');
  assert.equal(sequenceDayLabel('domani'), 'Giorno da decidere');
  assert.equal(sequenceChannelLabel('whatsapp'), 'WhatsApp');
  assert.equal(sequenceChannelLabel('piccione'), 'piccione');
  assert.equal(sequenceChannelLabel(''), 'Canale sconosciuto');
});

test('elenco counts people and fires per sequence, never across sequences', () => {
  const other = { ...SEQUENCE, id: 8, sourceKey: 'seq-altra', name: 'Altra', status: 'active' };
  const rows = buildSequenzeElenco({ sequences: [SEQUENCE, other], enrollments: ENROLLMENTS, sends: SENDS });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].statusLabel, 'Bozza');
  assert.equal(rows[0].peopleTotal, 2);
  assert.equal(rows[0].peopleActive, 1);
  assert.equal(rows[0].sent, 1);
  assert.equal(rows[0].waitingApproval, 1);
  assert.equal(rows[1].peopleTotal, 0);
  assert.equal(rows[1].sent, 0);
});

test('dettaglio orders steps by stepOrder with day and channel', () => {
  const detail = buildSequenzaDettaglio({ sequence: SEQUENCE, steps: STEPS, enrollments: ENROLLMENTS, sends: SENDS });
  assert.equal(detail.name, 'Bentornato in palestra');
  assert.equal(detail.statusLabel, 'Bozza');
  assert.equal(detail.steps.length, 2);
  assert.equal(detail.steps[0].dayLabel, 'Giorno 0 · parte subito');
  assert.equal(detail.steps[0].channelLabel, 'WhatsApp');
  assert.equal(detail.steps[1].dayLabel, 'Giorno 2');
  assert.deepEqual(detail.steps[0].vars, ['name']);
  assert.equal(detail.people.length, 2);
  assert.equal(detail.people[0].name, 'Giulia Rossi');
  assert.equal(detail.people[1].statusLabel, 'Fermata alla risposta');
});

test('hostile names are inert text, never markup', () => {
  const hostile = { ...SEQUENCE, name: '<script>alert(1)</script>' };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createSequenzeView({ doc, mount, client: stubClient({ sequences: [hostile] }) });
  return view.renderSequenze().then(async () => {
    await flush();
    const name = mount.querySelector('.bo-seq-name');
    assert.ok(name.textContent.includes('<script>alert(1)</script>'));
    assert.equal(name.findAll('script').length, 0);
  });
});

test('full screen: elenco, dettaglio with passi, double-ask activate posts once', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createSequenzeView({ doc, mount, client });
  await view.renderSequenze();
  await flush();
  assert.ok(mount.textContent.includes('Bentornato in palestra'));
  assert.ok(mount.textContent.includes('Bozza'));
  mount.querySelector('button[data-open="seq-bentornato"]').dispatch('click', {});
  await flush();
  assert.ok(mount.textContent.includes('Passi'));
  assert.ok(mount.textContent.includes('Giorno 0 · parte subito'));
  assert.ok(mount.textContent.includes('WhatsApp'));
  assert.ok(mount.textContent.includes('Giorno 2'));
  assert.ok(mount.textContent.includes('Persone nella sequenza'));
  assert.ok(mount.textContent.includes('Giulia Rossi'));
  const postsBefore = client.calls.filter((call) => call.method === 'POST').length;
  mount.querySelector('button[data-action="activate"]').dispatch('click', {});
  await flush();
  assert.ok(mount.textContent.includes('Attivare questa sequenza?'));
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, postsBefore);
  mount.querySelector('button[data-confirm="activate"]').dispatch('click', {});
  await flush();
  const posts = client.calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, postsBefore + 1);
  assert.ok(posts[posts.length - 1].path.endsWith('/actions/activate'));
});

test('a refused write says the state moved and reloads, never a raw error', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ failAction: 'sequence.activate is not allowed from state "active" (409 INVALID_STATE)' });
  const view = createSequenzeView({ doc, mount, client });
  await view.renderSequenze();
  await flush();
  mount.querySelector('button[data-open="seq-bentornato"]').dispatch('click', {});
  await flush();
  mount.querySelector('button[data-action="activate"]').dispatch('click', {});
  await flush();
  mount.querySelector('button[data-confirm="activate"]').dispatch('click', {});
  await flush();
  assert.ok(mount.textContent.includes('Lo stato è cambiato mentre decidevi'));
});

test('without the package the screen names its story, never a blank page', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = { request: async (path) => {
    if (path === '/api/schema') return { domains: {} };
    throw new Error(`unexpected request ${path}`);
  } };
  const view = createSequenzeView({ doc, mount, client });
  await view.renderSequenze();
  await flush();
  assert.ok(mount.textContent.includes('Sequenze'));
  assert.ok(mount.textContent.includes('BO-F3-03'));
  assert.ok(!mount.textContent.includes('undefined'));
});

test('loadSequenzeData marks availability from the contract, not from rows', async () => {
  const data = await loadSequenzeData(stubClient({ sequences: [] }));
  assert.equal(data.sequencesAvailable, true);
  assert.deepEqual(data.sequences, []);
  const empty = await loadSequenzeData({ request: async () => ({ domains: {} }) });
  assert.equal(empty.sequencesAvailable, false);
});

test('offered write follows the state: draft and paused activate, active pauses', () => {
  assert.equal(sequenzaOfferedAction('draft').action, 'activate');
  assert.equal(sequenzaOfferedAction('paused').button, 'Riattiva la sequenza');
  assert.equal(sequenzaOfferedAction('active').action, 'pause');
  assert.equal(sequenzaOfferedAction('completed'), null);
  assert.equal(sequenzaOfferedAction('unknown'), null);
});

test('shell enables Sequenze only when the package is composed', () => {
  const on = buildShellNav({ sequencesAvailable: true });
  const voice = on.find((item) => item.id === 'sequenze');
  assert.equal(voice.route, '#/sequenze');
  assert.equal(voice.available, true);
  const off = buildShellNav({});
  const parked = off.find((item) => item.id === 'sequenze');
  assert.equal(parked.route, null);
  assert.equal(parked.available, false);
  assert.ok(parked.disabledReason.includes('BO-F3'));
  const input = shellNavInput({ domains: { sequences: { sequencesContract: 1 } } });
  assert.equal(input.sequencesAvailable, true);
  const missing = shellNavInput({ domains: {} });
  assert.equal(missing.sequencesAvailable, false);
});

test('router owns #/sequenze; anything deeper is invalid, never a lookup', () => {
  assert.deepEqual(parseModuleRoute('#/sequenze'), { view: 'sequenze' });
  assert.deepEqual(parseModuleRoute('#/sequenze/'), { view: 'sequenze' });
  assert.deepEqual(parseModuleRoute('#/sequenze/abc'), { view: 'invalid' });
  assert.deepEqual(parseModuleRoute('#/sequenze//'), { view: 'invalid' });
});
