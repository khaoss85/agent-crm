import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_STATUS_PATH,
  FREE_QUESTION_DISABLED_NOTICE,
  SUGGESTION_CATALOG,
  askFreeQuestion,
  createAssistantPanel,
  isSafeRecordId,
  probeAssistantBackend,
  runAssistantAction,
  runSuggestion,
  suggestionsFor,
} from '../apps/admin/public/admin-assistant.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

const CONVS = {
  items: [
    {
      id: 'conv-1', status: 'open', channel: 'whatsapp', remoteHandle: '+39 333 000 0001',
      subjectResource: 'contact', subjectId: 'contact-9', subjectLabel: 'Marco Rossi',
      updatedAt: '2026-10-20T08:00:00.000Z', openedAt: '2026-10-19T08:00:00.000Z',
    },
    {
      id: 'conv-2', status: 'open', channel: 'instagram', remoteHandle: '@sara.b',
      subjectResource: 'contact', subjectId: 'contact-7', subjectLabel: 'Sara Bianchi',
      updatedAt: '2026-10-20T09:00:00.000Z', openedAt: '2026-10-19T09:00:00.000Z',
    },
    { id: 'conv-3', status: 'closed', channel: 'email', remoteHandle: 'luigi@example.it', updatedAt: '2026-10-18T08:00:00.000Z' },
  ],
};

const ISSUES = {
  items: [
    { id: 'issue-1', status: 'open', title: 'Duplicato possibile: Marco Rossi' },
    { id: 'issue-2', status: 'resolved', title: 'Email mancante' },
  ],
};

const CALLS = {
  items: [
    { id: 'call-1', outcome: 'completed', teamAuthorId: 'guido', remoteHandle: '+39 333 000 0001' },
    { id: 'call-2', outcome: 'missed', teamAuthorId: 'maria', remoteHandle: '+39 333 000 0002' },
    { id: 'call-3', outcome: 'completed', teamAuthorId: 'guido', remoteHandle: '+39 333 000 0003' },
  ],
};

function stubClient(routes) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, options });
      if (Object.hasOwn(routes, path)) {
        const value = routes[path];
        if (value instanceof Error) throw value;
        return typeof value === 'function' ? value(path, options) : value;
      }
      const error = new Error(`no such module (${path})`);
      Object.assign(error, { status: 404, code: 'MODULE_NOT_FOUND' });
      throw error;
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function sourceIds(answer) {
  return (answer.sources ?? []).map((source) => source.id);
}

// Acceptance 1: suggestions differ per screen.

test('suggestions differ per screen, fallback never empty', () => {
  const screens = Object.keys(SUGGESTION_CATALOG);
  assert.ok(screens.length >= 7);
  for (const screen of screens) {
    assert.ok(suggestionsFor(screen).length > 0, screen);
  }
  const idSets = screens.map((screen) => JSON.stringify(suggestionsFor(screen).map((s) => s.id).sort()));
  assert.equal(new Set(idSets).size, idSets.length, 'every screen has its own suggestions');
  assert.ok(suggestionsFor('module-partner').length > 0);
  assert.ok(suggestionsFor(null).length > 0);
  assert.ok(suggestionsFor('').length > 0);
});

test('oggetti ostili restano testo: id non sicuri mai nelle fonti', async () => {
  const hostile = {
    items: [
      { id: '../../x', status: 'open', subjectLabel: '<script>alert(1)</script>' },
      { id: 'conv-ok', status: 'open', subjectLabel: '${process.env.SECRET}' },
    ],
  };
  const client = stubClient({ '/api/modules/conversation/records?limit=50': hostile });
  const answer = await runSuggestion(client, 'bo04:oggi:urgenti');
  assert.ok(!sourceIds(answer).includes('../../x'));
  assert.ok(sourceIds(answer).includes('conv-ok'));
  for (const source of answer.sources) {
    assert.ok(isSafeRecordId(source.id));
    assert.ok(source.href.startsWith('#/modules/'));
    assert.ok(source.href.includes(encodeURIComponent(source.id)));
  }
});

// Acceptance 2: every answer cites clickable sources to real records.

test('urgenti: fonti lette dai record, href al record, indisponibili nominati', async () => {
  const client = stubClient({
    '/api/modules/conversation/records?limit=50': CONVS,
    '/api/modules/data-quality-issue/records?limit=50': ISSUES,
  });
  const answer = await runSuggestion(client, 'bo04:oggi:urgenti');
  const readIds = [...CONVS.items, ...ISSUES.items].map((row) => row.id);
  assert.ok(answer.sources.length > 0);
  for (const source of answer.sources) {
    assert.ok(readIds.includes(source.id), `invented source ${source.id}`);
    assert.ok(source.href.includes(encodeURIComponent(source.id)));
  }
  assert.ok(answer.actions.some((action) => action.kind === 'navigate'));
  assert.deepEqual(answer.unavailable, []);
});

test('modulo non composto: la sezione si nomina, la risposta resta', async () => {
  const client = stubClient({ '/api/modules/conversation/records?limit=50': CONVS });
  const answer = await runSuggestion(client, 'bo04:oggi:urgenti');
  assert.ok(answer.sources.length > 0);
  assert.ok(answer.unavailable.some((note) => note.includes('data-quality-issue')));
});

test('ricontattare: scheda cliente, segna-letta reale, contatta con conferma', async () => {
  const client = stubClient({ '/api/modules/conversation/records?limit=50': CONVS });
  const answer = await runSuggestion(client, 'bo04:clienti:ricontattare');
  assert.ok(sourceIds(answer).every((id) => CONVS.items.some((row) => row.id === id)));
  const card = answer.actions.find((action) => action.id === 'bo04:apri-scheda');
  assert.equal(card.href, '#/customer-card/contact/contact-7');
  const mark = answer.actions.find((action) => action.id.startsWith('bo04:segna-letta'));
  assert.equal(mark.request.path, '/api/modules/conversation/records/conv-2/actions/mark-read');
  const contact = answer.actions.find((action) => action.id.startsWith('bo04:contatta'));
  assert.equal(contact.customerFacing, true);
});

test('segnali: raggruppati per lead da behavioral-signal (intelligence)', async () => {
  const client = stubClient({
    '/api/modules/behavioral-signal/records?limit=100': {
      items: [
        { id: 'sig-1', leadId: 'lead-a', signalType: 'pricing-page-visited', observedAt: '2026-10-20T07:00:00.000Z' },
        { id: 'sig-2', leadId: 'lead-a', signalType: 'demo-requested', observedAt: '2026-10-20T08:00:00.000Z' },
        { id: 'sig-3', leadId: 'lead-b', signalType: 'pricing-page-visited', observedAt: '2026-10-20T08:30:00.000Z' },
      ],
    },
  });
  const answer = await runSuggestion(client, 'bo04:clienti:segnali');
  assert.deepEqual(sourceIds(answer), ['sig-2', 'sig-3']);
  assert.ok(answer.lines.some((line) => line.includes('lead-a') && line.includes('2 segnali')));
});

test('chiusura: somme intere per fase, mai float', async () => {
  const client = stubClient({
    '/api/opportunities': {
      items: [
        { id: 'opp-1', name: 'Prova costume', stage: 'proposal', valueCents: 150000, currency: 'EUR' },
        { id: 'opp-2', name: 'Annuale', stage: 'proposal', valueCents: 20000, currency: 'EUR' },
        { id: 'opp-3', name: 'Senza importo', stage: 'new' },
      ],
    },
  });
  const answer = await runSuggestion(client, 'bo04:pipeline:chiusura');
  assert.ok(answer.lines.some((line) => line.includes('EUR 1,700.00')));
  assert.ok(!answer.lines.some((line) => line.includes('.000')));
  assert.ok(sourceIds(answer).every((id) => ['opp-1', 'opp-2', 'opp-3'].includes(id)));
});

test('ai-puo: registri llm-call-audit reali + capability deterministiche', async () => {
  const client = stubClient({
    '/api/modules/llm-call-audit/records?limit=20': {
      items: [
        { id: 'audit-1', purpose: 'assistant', model: 'gpt-5.6-luna', dryRun: true },
        { id: 'audit-2', purpose: 'suggest', model: 'gpt-5.6-luna', dryRun: true },
      ],
    },
  });
  const answer = await runSuggestion(client, 'bo04:impostazioni:ai-puo');
  assert.deepEqual(sourceIds(answer), ['audit-1', 'audit-2']);
  assert.ok(answer.lines.some((line) => line.includes('dry-run')));
  assert.ok(answer.lines.some((line) => line.includes('conferma')));
});

test('suggerimento sconosciuto rifiuta, senza client rifiuta', async () => {
  const client = stubClient({});
  await assert.rejects(runSuggestion(client, 'bo04:mai:esistito'), /sconosciuto/);
  await assert.rejects(runSuggestion(null, 'bo04:oggi:urgenti'), /client API/);
});

// Acceptance 3: linked actions execute really; nothing to a customer without confirmation.

test('azione navigate esegue davvero', async () => {
  const client = stubClient({});
  const seen = [];
  const outcome = await runAssistantAction(
    client,
    { id: 'a1', label: 'Apri', kind: 'navigate', href: '#/customer-data', customerFacing: false },
    { navigate: (href) => seen.push(href) },
  );
  assert.equal(outcome.ok, true);
  assert.deepEqual(seen, ['#/customer-data']);
  assert.equal(client.calls.length, 0);
});

test('azione api esegue davvero la richiesta dichiarata', async () => {
  const client = stubClient({
    '/api/modules/conversation/records/conv-2/actions/mark-read': { read: { id: 'conv-2' } },
  });
  const outcome = await runAssistantAction(
    client,
    {
      id: 'bo04:segna-letta:conv-2', label: 'Segna come letta', kind: 'api',
      request: { path: '/api/modules/conversation/records/conv-2/actions/mark-read', method: 'POST', body: {} },
      customerFacing: false,
    },
    { idempotencyKey: 'assistant:test:1' },
  );
  assert.equal(outcome.ok, true);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].options.idempotencyKey, 'assistant:test:1');
});

test('verso un cliente senza conferma: zero richieste, zero navigazioni', async () => {
  const client = stubClient({});
  const seen = [];
  for (const action of [
    { id: 'c1', label: 'Contatta il cliente', kind: 'navigate', href: '#/modules/conversation/conv-2', customerFacing: true },
    {
      id: 'c2', label: 'Invia risposta', kind: 'api',
      request: { path: '/api/outbox/send', method: 'POST', body: {} }, customerFacing: true,
    },
  ]) {
    const outcome = await runAssistantAction(client, action, { navigate: (href) => seen.push(href) });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.needsConfirmation, true);
    assert.ok(outcome.confirmLabel.length > 0);
  }
  assert.equal(client.calls.length, 0);
  assert.deepEqual(seen, []);
});

test('conferma per azione: quella giusta parte, quella sbagliata no', async () => {
  const client = stubClient({
    '/api/modules/conversation/records/conv-2/actions/mark-read': { read: { id: 'conv-2' } },
  });
  const seen = [];
  const action = {
    id: 'bo04:contatta:conv-2', label: 'Contatta il cliente', kind: 'navigate',
    href: '#/modules/conversation/conv-2', customerFacing: true,
  };
  const wrong = await runAssistantAction(client, action, {
    navigate: (href) => seen.push(href), confirmedActionId: 'bo04:contatta:conv-9',
  });
  assert.equal(wrong.needsConfirmation, true);
  const right = await runAssistantAction(client, action, {
    navigate: (href) => seen.push(href), confirmedActionId: 'bo04:contatta:conv-2',
  });
  assert.equal(right.ok, true);
  assert.deepEqual(seen, ['#/modules/conversation/conv-2']);
});

test('azioni malformate rifiutano prima di eseguire', async () => {
  const client = stubClient({});
  await assert.rejects(runAssistantAction(client, null, {}), /non valida/);
  await assert.rejects(
    runAssistantAction(client, { id: 'x', kind: 'teleport', href: '#/', customerFacing: false }, {}),
    /non eseguibile/,
  );
  await assert.rejects(
    runAssistantAction(client, { id: 'x', kind: 'navigate', href: 'https://evil.example/', customerFacing: false }, {}),
    /destinazione non valida/,
  );
});

// Acceptance 4: without an LLM key the panel is usable, free questions off with a clear message.

test('probe: 404 o forma inattesa valgono dry-run, mai un errore', async () => {
  const missing = stubClient({});
  assert.deepEqual(await probeAssistantBackend(missing), {
    mode: 'dry-run', freeQuestions: 'disabled', endpoint: null, notice: FREE_QUESTION_DISABLED_NOTICE,
  });
  assert.ok(FREE_QUESTION_DISABLED_NOTICE.includes('chiave'));
  const odd = stubClient({ [ASSISTANT_STATUS_PATH]: { freeQuestions: 'enabled' } });
  assert.equal((await probeAssistantBackend(odd)).mode, 'dry-run');
  const live = stubClient({ [ASSISTANT_STATUS_PATH]: { freeQuestions: 'enabled', endpoint: '/api/assistant/ask' } });
  assert.deepEqual(await probeAssistantBackend(live), {
    mode: 'live', freeQuestions: 'enabled', endpoint: '/api/assistant/ask', notice: '',
  });
});

test('domanda libera in dry-run: rifiuto col messaggio chiave, zero richieste', async () => {
  const client = stubClient({
    [ASSISTANT_STATUS_PATH]: { freeQuestions: 'enabled', endpoint: '/api/assistant/ask' },
  });
  const outcome = await askFreeQuestion(client, { mode: 'dry-run' }, 'chi devo ricontattare?');
  assert.equal(outcome.disabled, true);
  assert.ok(outcome.notice.includes('chiave'));
  assert.ok(client.calls.every((call) => call.path !== '/api/assistant/ask'));
});

test('domanda vuota o troppo lunga rifiuta prima di ogni richiesta', async () => {
  const client = stubClient({
    [ASSISTANT_STATUS_PATH]: { freeQuestions: 'enabled', endpoint: '/api/assistant/ask' },
  });
  await assert.rejects(askFreeQuestion(client, { mode: 'live', endpoint: '/api/assistant/ask' }, '   '), /Scrivi una domanda/);
  await assert.rejects(askFreeQuestion(client, { mode: 'live', endpoint: '/api/assistant/ask' }, 'x'.repeat(501)), /troppo lunga/);
  assert.equal(client.calls.length, 0);
});

test('domanda libera live: cita solo fonti lette dal backend', async () => {
  const client = stubClient({
    '/api/assistant/ask': {
      lines: ['Ecco i thread aperti.'],
      sources: [
        { module: 'conversation', id: 'conv-1', label: 'Marco Rossi' },
        { module: 'conversation', id: '../../x', label: 'no' },
      ],
    },
  });
  const outcome = await askFreeQuestion(client, { mode: 'live', endpoint: '/api/assistant/ask' }, 'chi devo ricontattare?');
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.answer.sources.map((source) => source.id), ['conv-1']);
  assert.ok(outcome.answer.sources[0].href.includes('conv-1'));
});

// Panel rendering: suggestions, sources as links, two-step confirm, dry-run box.

test('pannello: suggerimenti per schermata, fonti cliccabili, box disabilitato in dry-run', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const navigated = [];
  const client = stubClient({
    '/api/modules/conversation/records?limit=50': CONVS,
    '/api/modules/interaction-call/records?limit=100': CALLS,
  });
  const panel = createAssistantPanel({
    doc, mount, client, navigate: (href) => navigated.push(href), notify: () => {},
  });
  await panel.open('clienti');
  const state = panel.getState();
  assert.equal(state.open, true);
  assert.equal(state.mode, 'dry-run');
  assert.equal(state.suggestionCount, 2);
  const buttons = mount.findAll('button').map((node) => node.textContent);
  assert.ok(buttons.includes('Chi devo ricontattare?'));
  assert.ok(buttons.includes('Quali lead mostrano segnali caldi?'));
  assert.ok(mount.textContent.includes('Le domande libere arrivano con la chiave'));

  const suggestion = mount.findByText('button', 'Chi devo ricontattare?');
  suggestion.dispatch('click', {});
  await tick();
  await tick();
  const after = panel.getState();
  assert.equal(after.answerTitle, 'Chi devo ricontattare?');
  assert.ok(after.sourceCount > 0);
  const links = mount.findAll('a');
  assert.ok(links.length > 0);
  for (const link of links) {
    assert.ok(String(link.getAttribute('href')).startsWith('#/'));
  }
  links[0].dispatch('click', { preventDefault() {} });
  assert.ok(navigated.length === 1 && navigated[0].startsWith('#/'));
});

test('pannello: contatta chiede conferma, naviga solo al secondo passo', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const navigated = [];
  const client = stubClient({ '/api/modules/conversation/records?limit=50': CONVS });
  const panel = createAssistantPanel({
    doc, mount, client, navigate: (href) => navigated.push(href), notify: () => {},
  });
  await panel.open('clienti');
  mount.findByText('button', 'Chi devo ricontattare?').dispatch('click', {});
  await tick();
  await tick();
  mount.findByText('button', 'Contatta il cliente').dispatch('click', {});
  await tick();
  assert.deepEqual(navigated, []);
  assert.ok(mount.textContent.includes('Conferma:'));
  mount.findByText('button', 'Conferma:').dispatch('click', {});
  await tick();
  await tick();
  assert.deepEqual(navigated, ['#/modules/conversation/conv-2']);
});

test('pannello: stringhe ostili restano testo, mai markup', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    '/api/modules/conversation/records?limit=50': {
      items: [{ id: 'conv-1', status: 'open', subjectLabel: '<script>alert(1)</script>', channel: 'whatsapp' }],
    },
    '/api/modules/data-quality-issue/records?limit=50': { items: [] },
  });
  const panel = createAssistantPanel({
    doc, mount, client, navigate: () => {}, notify: () => {},
  });
  await panel.open('oggi');
  mount.findByText('button', 'Cosa è più urgente oggi?').dispatch('click', {});
  await tick();
  await tick();
  assert.equal(mount.findAll('script').length, 0);
  assert.ok(mount.textContent.includes('<script>alert(1)</script>'));
});

test('pannello: chiudi svuota il mount', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({});
  const panel = createAssistantPanel({ doc, mount, client });
  await panel.open('oggi');
  assert.ok(mount.firstChild !== null);
  panel.close();
  assert.equal(mount.firstChild, null);
  assert.equal(panel.getState().open, false);
});
