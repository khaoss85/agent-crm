import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSequenzaDettaglio,
  buildSequenzeElenco,
  createSequenzeView,
  loadSequenzeData,
  loadSequenzaSteps,
  personStatusLabel,
  personStepLabel,
  sequenceChannelLabel,
  sequenceDayLabel,
  sequenceQuandoLine,
  sequenceStatusLabel,
  sequenceTriggerPills,
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
      calls.push({ path, method: options.method ?? 'GET', body: options.body, key: options.idempotencyKey ?? options.headers?.['Idempotency-Key'] ?? null });
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

test('step day and channel read like the prototype: Subito, +1 giorno, +N giorni', () => {
  assert.equal(sequenceDayLabel(0), 'Subito');
  assert.equal(sequenceDayLabel(1), '+1 giorno');
  assert.equal(sequenceDayLabel(2), '+2 giorni');
  assert.equal(sequenceDayLabel('domani'), 'Giorno da decidere');
  assert.equal(sequenceChannelLabel('whatsapp'), 'WhatsApp');
  assert.equal(sequenceChannelLabel('piccione'), 'piccione');
  assert.equal(sequenceChannelLabel(''), 'Canale sconosciuto');
});

test('trigger lines and pills read the record labels, never invented triggers', () => {
  assert.equal(sequenceQuandoLine({ triggerLabel: 'lead dal sito' }), 'Quando lead dal sito');
  assert.equal(sequenceQuandoLine({}), 'Quando parte');
  assert.deepEqual(sequenceTriggerPills({ triggerLabel: 'lead dal sito', stopLabel: 'alla prima risposta' }), {
    trigger: 'Parte quando: lead dal sito',
    stop: 'Si ferma quando: alla prima risposta',
  });
  assert.deepEqual(sequenceTriggerPills({}), {
    trigger: 'Parte quando: da decidere',
    stop: 'Si ferma quando: alla prima risposta',
  });
});

test('person pills read In corso, Da approvare, Completata, Programmata', () => {
  const now = Date.parse('2026-10-26T12:00:00.000Z');
  assert.equal(personStatusLabel({ status: 'active', nextDueAt: '2026-10-26T09:00:00.000Z' }, { nowMs: now }), 'In corso');
  assert.equal(personStatusLabel({ status: 'active', nextDueAt: '2026-10-27T09:00:00.000Z' }, { nowMs: now }), 'Programmata');
  assert.equal(personStatusLabel({ status: 'active' }, { nowMs: now }), 'In corso');
  assert.equal(personStatusLabel({ status: 'paused' }, { nowMs: now }), 'Programmata');
  assert.equal(personStatusLabel({ status: 'stopped-replied' }, { nowMs: now }), 'Completata');
  assert.equal(personStatusLabel({ status: 'completed' }, { nowMs: now }), 'Completata');
  assert.equal(personStatusLabel({ status: 'active' }, { waitingApproval: true, nowMs: now }), 'Da approvare');
  assert.equal(personStatusLabel({ status: 'flying' }, { nowMs: now }), 'Stato sconosciuto');
});

test('a replied person stays Completata even with a leftover waiting-approval send', () => {
  // stopIfReplied exits the enrollment while its send still waits: the stale
  // send must not resurrect the person as Da approvare next to Uscita.
  const now = Date.parse('2026-10-26T12:00:00.000Z');
  assert.equal(personStatusLabel({ status: 'stopped-replied' }, { waitingApproval: true, nowMs: now }), 'Completata');
  assert.equal(personStatusLabel({ status: 'completed' }, { waitingApproval: true, nowMs: now }), 'Completata');
  const enrollments = [{ sourceKey: 'e-9', subjectLabel: 'Marco', status: 'stopped-replied', currentStep: 1, nextDueAt: null }];
  const sends = [{ enrollmentSourceKey: 'e-9', sequenceSourceKey: 'seq-bentornato', status: 'waiting-approval' }];
  const detail = buildSequenzaDettaglio({
    sequence: SEQUENCE,
    steps: STEPS,
    enrollments,
    sends,
    nowMs: now,
  });
  assert.equal(detail.people[0].statusLabel, 'Completata');
  assert.equal(detail.people[0].stepLabel, 'Uscita');
});

test('person progress reads Passo n di m, In attesa, Uscita', () => {
  assert.equal(personStepLabel({ status: 'active', currentStep: 0 }, 3), 'Passo 1 di 3');
  assert.equal(personStepLabel({ status: 'active', currentStep: 1 }, 3), 'Passo 2 di 3');
  assert.equal(personStepLabel({ status: 'active' }, 3), 'In attesa');
  assert.equal(personStepLabel({ status: 'stopped-replied', currentStep: 1 }, 3), 'Uscita');
  assert.equal(personStepLabel({ status: 'completed', currentStep: 2 }, 3), 'Uscita');
  assert.equal(personStepLabel({ status: 'active', currentStep: 0 }, 0), 'Passo 1');
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
  const detail = buildSequenzaDettaglio({
    sequence: SEQUENCE,
    steps: STEPS,
    enrollments: ENROLLMENTS,
    sends: SENDS,
    nowMs: Date.parse('2026-10-26T12:00:00.000Z'),
  });
  assert.equal(detail.name, 'Bentornato in palestra');
  assert.equal(detail.statusLabel, 'Bozza');
  assert.equal(detail.steps.length, 2);
  assert.equal(detail.steps[0].dayLabel, 'Subito');
  assert.equal(detail.steps[0].channelLabel, 'WhatsApp');
  assert.equal(detail.steps[0].title, 'WhatsApp · Ciao, ci manchi');
  assert.equal(detail.steps[1].dayLabel, '+2 giorni');
  assert.deepEqual(detail.steps[0].vars, ['name']);
  assert.equal(detail.people.length, 2);
  assert.equal(detail.people[0].name, 'Giulia Rossi');
  assert.equal(detail.people[0].stepLabel, 'Passo 1 di 2');
  assert.equal(detail.people[0].statusLabel, 'In corso');
  assert.equal(detail.people[1].stepLabel, 'Uscita');
  assert.equal(detail.people[1].statusLabel, 'Completata');
});

test('elenco rows carry Quando lines and reply-share stats, in pausa when held', () => {
  const rows = buildSequenzeElenco({
    sequences: [
      { ...SEQUENCE, id: 7, status: 'active', triggerLabel: 'lead dal sito' },
      { ...SEQUENCE, id: 8, sourceKey: 'seq-pausa', status: 'paused' },
    ],
    enrollments: ENROLLMENTS,
    sends: SENDS,
  });
  assert.equal(rows[0].quando, 'Quando lead dal sito');
  assert.equal(rows[0].stats, '2 persone · 50% risposte');
  assert.equal(rows[0].replyPct, 50);
  assert.equal(rows[1].quando, 'Quando parte');
  assert.equal(rows[1].stats, 'in pausa');
});

test('dettaglio pills and KPI read the sequence labels and the counted rows', () => {
  const detail = buildSequenzaDettaglio({
    sequence: { ...SEQUENCE, status: 'active', triggerLabel: 'lead dal sito', stopLabel: 'quando risponde' },
    steps: STEPS,
    enrollments: ENROLLMENTS,
    sends: SENDS,
    nowMs: Date.parse('2026-10-26T12:00:00.000Z'),
  });
  assert.deepEqual(detail.pills, {
    trigger: 'Parte quando: lead dal sito',
    stop: 'Si ferma quando: quando risponde',
  });
  assert.deepEqual(detail.metrics.kpi, { inCorso: 1, risposte: 1, callFissate: null });
});

test('a waiting-approval send on an enrollment paints Da approvare', () => {
  const enrollments = [{ sourceKey: 'e-1', subjectLabel: 'Anna', status: 'active', currentStep: 0, nextDueAt: null }];
  const sends = [{ enrollmentSourceKey: 'e-1', sequenceSourceKey: 'seq-bentornato', status: 'waiting-approval' }];
  const detail = buildSequenzaDettaglio({
    sequence: SEQUENCE,
    steps: STEPS,
    enrollments,
    sends,
    nowMs: Date.parse('2026-10-26T12:00:00.000Z'),
  });
  assert.equal(detail.people[0].statusLabel, 'Da approvare');
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
  assert.ok(mount.textContent.includes('Subito'));
  assert.ok(mount.textContent.includes('WhatsApp · Ciao, ci manchi'));
  assert.ok(mount.textContent.includes('+2 giorni'));
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

test('activate posts through the submission client with an idempotency key', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createSequenzeView({ doc, mount, client });
  await view.renderSequenze();
  await flush();
  mount.querySelector('button[data-open="seq-bentornato"]').dispatch('click', {});
  await flush();
  mount.querySelector('button[data-action="activate"]').dispatch('click', {});
  await flush();
  mount.querySelector('button[data-confirm="activate"]').dispatch('click', {});
  await flush();
  const posts = client.calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 1);
  assert.match(String(posts[0].key ?? ''), /^v1\./);
});

test('record reads stay space-explicit when the shell names a space', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createSequenzeView({ doc, mount, client, spaceId: () => 'presti' });
  await view.renderSequenze();
  await flush();
  const reads = client.calls.filter((call) => call.method === 'GET' && call.path.includes('/api/modules/'));
  assert.ok(reads.length > 0);
  for (const call of reads) assert.ok(call.path.includes('filter.spaceId=presti'), call.path);
});

test('a failed dataset reads as unavailable, never as a genuine zero', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const inner = stubClient();
  const client = {
    calls: inner.calls,
    request: async (path, options) => {
      if (path.startsWith('/api/modules/sequence-enrollment/records?')) {
        throw Object.assign(new Error('store down'), { code: 'STORE_DOWN' });
      }
      return inner.request(path, options);
    },
  };
  const view = createSequenzeView({ doc, mount, client });
  await view.renderSequenze();
  await flush();
  assert.ok(mount.textContent.includes('Bentornato in palestra'));
  assert.ok(mount.textContent.includes('Non riesco a leggere adesso: enrollments.'));
});

test('a failed steps read stays failed, never an empty list', async () => {
  const ok = await loadSequenzaSteps(stubClient());
  assert.equal(ok.failed, false);
  assert.equal(ok.rows.length, 2);
  const failing = { request: async () => { throw Object.assign(new Error('store down'), { code: 'STORE_DOWN' }); } };
  const bad = await loadSequenzaSteps(failing, 'seq-bentornato', 'presti');
  assert.equal(bad.failed, true);
  assert.deepEqual(bad.rows, []);
});

test('a failed steps read renders unavailable in the dettaglio, never a genuine zero', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const inner = stubClient();
  const client = {
    calls: inner.calls,
    request: async (path, options) => {
      if (path.startsWith('/api/modules/sequence-step/records?')) {
        throw Object.assign(new Error('store down'), { code: 'STORE_DOWN' });
      }
      return inner.request(path, options);
    },
  };
  const view = createSequenzeView({ doc, mount, client });
  await view.renderSequenze();
  await flush();
  mount.querySelector('button[data-open="seq-bentornato"]').dispatch('click', {});
  await flush();
  assert.ok(mount.textContent.includes('Non riesco a leggere i passi adesso'));
  assert.ok(!mount.textContent.includes('non ha passi registrati'));
  assert.ok(mount.textContent.includes('Giulia Rossi'));
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

test('without the package the screen says so in Italian, never a blank page', async () => {
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
  assert.ok(mount.textContent.includes('non sono composte in questo spazio'));
  assert.ok(!mount.textContent.includes('BO-F3-03'));
  assert.ok(!mount.textContent.includes('undefined'));
  assert.ok(!/NOT_FOUND|non composto/i.test(mount.textContent));
});

test('loadSequenzeData marks availability from the contract, not from rows', async () => {
  const data = await loadSequenzeData(stubClient({ sequences: [] }));
  assert.equal(data.sequencesAvailable, true);
  assert.deepEqual(data.sequences, []);
  const empty = await loadSequenzeData({ request: async () => ({ domains: {} }) });
  assert.equal(empty.sequencesAvailable, false);
});

test('offered write follows the state: draft and paused activate, active pauses', () => {
  assert.deepEqual(sequenzaOfferedAction('draft'), {
    action: 'activate',
    button: 'Attiva',
    confirm: 'Attivare questa sequenza? I passi dovuti possono partire.',
  });
  assert.equal(sequenzaOfferedAction('paused').button, 'Riattiva');
  assert.equal(sequenzaOfferedAction('active').button, 'Metti in pausa');
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

test('the header reads the prototype verbatim: eyebrow, title, subtitle', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createSequenzeView({ doc, mount, client: stubClient() });
  await view.renderSequenze();
  await flush();
  assert.ok(mount.textContent.includes('MODULO NATIVO'), 'the eyebrow is uppercase');
  assert.ok(mount.textContent.includes('Sequenze'));
  assert.ok(mount.textContent.includes(
    'Follow-up che partono da soli quando succede qualcosa, sul canale giusto. Si fermano appena il cliente risponde.',
  ), 'the subtitle is verbatim');
});

test('Nuova sequenza is the primary CTA with Crea con l’AI beside it', async () => {
  // Owner 31/10: no menu — «Nuova sequenza» is the green CTA on the title row
  // and «✦ Crea con l'AI» sits beside it in the assistant's colours.
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createSequenzeView({ doc, mount, client: stubClient() });
  await view.renderSequenze();
  await flush();
  assert.ok(mount.querySelector('.bo-seq-actions'), 'the two header voices share one top-right wrap');
  const manual = () => mount.querySelector('button[data-action="new-manual"]');
  const ai = () => mount.querySelector('button[data-action="new-ai"]');
  assert.equal(manual().textContent, 'Nuova sequenza');
  assert.deepEqual(
    String(manual().getAttribute('class') ?? '').split(/\s+/).filter((cls) => cls.startsWith('ui-btn-')),
    ['ui-btn-cta'],
    'Nuova sequenza is the single green CTA, like the prototype',
  );
  assert.ok(ai().textContent.includes('Crea con l'), 'the AI voice names the assistant entry');
  assert.ok(ai().textContent.includes('✦'), 'the AI voice carries the assistant star');
  const aiClasses = String(ai().getAttribute('class') ?? '').split(/\s+/);
  assert.ok(aiClasses.includes('ui-btn'), 'the AI voice carries a ui-* system class');
  assert.ok(aiClasses.includes('bo-seq-ai'), 'the AI voice wears the assistant colours');
  assert.ok(!mount.querySelector('.bo-seq-menu'), 'no menu is painted anymore');
});

test('Nuova sequenza names the manual next step in Italian, twice hides it', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createSequenzeView({ doc, mount, client: stubClient() });
  await view.renderSequenze();
  await flush();
  const manual = () => mount.querySelector('button[data-action="new-manual"]');
  manual().dispatch('click', {});
  await flush();
  assert.ok(mount.textContent.includes('la vedi qui appena è pronta'), 'the manual voice names the outcome, in Italian');
  assert.equal(manual().getAttribute('aria-expanded'), 'true');
  assert.equal(manual().__focused, true, 'the repaint keeps keyboard focus on the voice');
  manual().dispatch('click', {});
  await flush();
  assert.ok(!mount.textContent.includes('la vedi qui appena è pronta'), 'a second press hides the hint');
});

test('the AI voice focuses the shell AI bar instead of painting a help sentence', async () => {
  const doc = createFakeDocument();
  const aiInput = doc.createElement('input');
  aiInput.setAttribute('class', 'bo-ai-input ui-field');
  const docWithBar = {
    ...doc,
    querySelector: (selector) => (selector === '.bo-ai-input' ? aiInput : null),
  };
  const mount = createMount();
  const view = createSequenzeView({ doc: docWithBar, mount, client: stubClient() });
  await view.renderSequenze();
  await flush();
  mount.querySelector('button[data-action="new-ai"]').dispatch('click', {});
  await flush();
  assert.equal(aiInput.__focused, true, 'the AI voice moves focus to the real AI bar');
  assert.ok(!mount.textContent.includes('barra AI'), 'no invented help sentence is painted');
});

test('without the shell bar the AI voice keeps focus and paints no hint', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createSequenzeView({ doc, mount, client: stubClient() });
  await view.renderSequenze();
  await flush();
  const ai = () => mount.querySelector('button[data-action="new-ai"]');
  ai().dispatch('click', {});
  await flush();
  assert.ok(!mount.textContent.includes('barra AI'), 'no hint without the bar');
  assert.equal(ai().__focused, true, 'focus stays on the AI voice');
});

test('the dettaglio paints trigger pills, 3 KPI cards and the approval note', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const sequences = [{ ...SEQUENCE, status: 'active', triggerLabel: 'lead dal sito', stopLabel: 'quando risponde' }];
  const client = stubClient({ sequences });
  const view = createSequenzeView({ doc, mount, client });
  await view.renderSequenze();
  await flush();
  mount.querySelector('button[data-open="seq-bentornato"]').dispatch('click', {});
  await flush();
  assert.ok(mount.textContent.includes('Parte quando: lead dal sito'));
  assert.ok(mount.textContent.includes('Si ferma quando: quando risponde'));
  assert.ok(mount.textContent.includes('In corso'));
  assert.ok(mount.textContent.includes('Risposte'));
  assert.ok(mount.textContent.includes('Call fissate'));
  assert.ok(mount.textContent.includes('—'), 'the call card stays an honest dash without appointments data');
  const cards = mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('metric'));
  assert.equal(cards.length, 3, 'the dettaglio paints the 3 KPI cards with the Reporting classes');
  for (const card of cards) {
    const kids = card.childNodes ?? [];
    assert.equal(kids.length, 3, 'each KPI card is label + big number + a line below');
    assert.equal(String(kids[0].tagName ?? '').toLowerCase(), 'span');
    assert.equal(String(kids[1].tagName ?? '').toLowerCase(), 'strong');
    assert.equal(String(kids[2].tagName ?? '').toLowerCase(), 'span');
  }
  assert.ok(mount.textContent.includes('persone dentro adesso'));
  assert.ok(mount.textContent.includes('non lette in questa vista'), 'the dash card says why it has no number');
  assert.ok(mount.textContent.includes(
    'Con «Inviare risposte senza approvazione» spento, ogni messaggio della sequenza aspetta il tuo ok prima di partire.',
  ));
  assert.ok(mount.textContent.includes('Quando lead dal sito'), 'the elenco names the trigger');
});

test('empty screens stay simple: no cards, no codes, no English', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createSequenzeView({ doc, mount, client: stubClient({ sequences: [] }) });
  await view.renderSequenze();
  await flush();
  assert.ok(mount.textContent.includes('Nessuna sequenza: creane una con il pulsante in alto.'));
  const empty = stubClient({ sequences: [{ ...SEQUENCE, sourceKey: 'seq-vuota' }], steps: [] });
  const doc3 = createFakeDocument();
  const mount3 = createMount();
  const view3 = createSequenzeView({ doc: doc3, mount: mount3, client: empty });
  await view3.renderSequenze();
  await flush();
  mount3.querySelector('button[data-open="seq-vuota"]').dispatch('click', {});
  await flush();
  assert.ok(mount3.textContent.includes('Nessuna persona in questa sequenza.'));
  for (const text of [mount.textContent, mount3.textContent]) {
    assert.ok(!/NOT_FOUND|undefined|NaN/.test(text), 'no technical residue');
  }
});

test('pausing an active sequence offers Riattiva, the In pausa pill and in pausa stats', async () => {
  let status = 'active';
  const doc = createFakeDocument();
  const mount = createMount();
  const inner = stubClient({ sequences: [{ ...SEQUENCE, status: 'active' }] });
  const client = {
    calls: inner.calls,
    request: async (path, options = {}) => {
      if (options.method === 'POST' && path.includes('/actions/pause')) {
        status = 'paused';
        return { ok: true };
      }
      if (path.startsWith('/api/modules/sequence/records?')) {
        return { items: [{ ...SEQUENCE, status }] };
      }
      return inner.request(path, options);
    },
  };
  const view = createSequenzeView({ doc, mount, client });
  await view.renderSequenze();
  await flush();
  mount.querySelector('button[data-open="seq-bentornato"]').dispatch('click', {});
  await flush();
  assert.ok(mount.textContent.includes('Metti in pausa'));
  mount.querySelector('button[data-action="pause"]').dispatch('click', {});
  await flush();
  assert.ok(mount.textContent.includes('Mettere in pausa?'));
  mount.querySelector('button[data-confirm="pause"]').dispatch('click', {});
  await flush();
  assert.ok(mount.textContent.includes('Riattiva'), 'after the pause the detail offers Riattiva');
  assert.ok(mount.textContent.includes('In pausa'), 'after the pause the pill reads In pausa');
  assert.ok(mount.textContent.includes('in pausa'), 'after the pause the elenco stats read in pausa');
});

test('the sequenze screen renders no raw control', async () => {
  // Acceptance: a control without a ui-* system class fails this screen.
  const rawControls = (root) => {
    const out = [];
    const walk = (node) => {
      const tag = String(node.tagName ?? '').toLowerCase();
      if (['button', 'select', 'input', 'textarea'].includes(tag)) {
        const classes = String(node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
        if (!classes.some((cls) => cls === 'ui' || cls.startsWith('ui-'))) out.push(`${tag}[${classes.join('.')}]`);

      }
      for (const child of node.childNodes ?? []) walk(child);
    };
    walk(root);
    return out;
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createSequenzeView({ doc, mount, client: stubClient() });
  await view.renderSequenze();
  await flush();
  assert.deepEqual(rawControls(mount), [], 'every control of the header carries a ui-* class');
  mount.querySelector('button[data-action="new-manual"]').dispatch('click', {});
  await flush();
  assert.deepEqual(rawControls(mount), [], 'the manual hint adds no raw control');
  mount.querySelector('button[data-open="seq-bentornato"]').dispatch('click', {});
  await flush();
  assert.deepEqual(rawControls(mount), [], 'the dettaglio adds no raw control');
});
