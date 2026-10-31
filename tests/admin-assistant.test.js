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
import { requireSubmissionContext } from '../apps/admin/public/admin-submission.js';
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

test('chiudi thread: irreversibile, conferma nominativa prima di ogni esecuzione', async () => {
  const client = stubClient({
    '/api/modules/conversation/records?limit=50': CONVS,
    '/api/modules/conversation/records/conv-2/actions/close': { ok: true, id: 'conv-2', status: 'closed' },
  });
  const answer = await runSuggestion(client, 'bo04:clienti:ricontattare');
  const close = answer.actions.find((action) => action.id.startsWith('bo04:chiudi'));
  assert.ok(close);
  assert.equal(close.customerFacing, true);
  // The newest open thread is named, never a generic label.
  assert.ok(close.label.includes('Sara Bianchi'));
  assert.ok(close.confirmLabel.includes('Sara Bianchi'));
  const refused = await runAssistantAction(client, close, {});
  assert.equal(refused.needsConfirmation, true);
  assert.ok(!client.calls.some((call) => String(call.path).includes('/actions/close')));
  const done = await runAssistantAction(client, close, { confirmedActionId: close.id });
  assert.equal(done.ok, true);
  assert.ok(client.calls.some(
    (call) => call.path === '/api/modules/conversation/records/conv-2/actions/close',
  ));
});

test('titoli contano tutta la pagina letta, non solo i primi 5', async () => {
  const threads = {
    items: Array.from({ length: 6 }, (_, index) => ({
      id: `conv-${index}`, status: 'open', updatedAt: `2026-10-20T0${index}:00:00.000Z`,
    })),
  };
  const ricontattare = await runSuggestion(
    stubClient({ '/api/modules/conversation/records?limit=50': threads }),
    'bo04:clienti:ricontattare',
  );
  assert.ok(ricontattare.lines.some((line) => line.includes('6 thread aperti da ricontattare')));
  const messages = {
    items: Array.from({ length: 6 }, (_, index) => ({
      id: `msg-${index}`, direction: 'inbound', channel: 'website-form',
      body: `richiesta ${index}`, conversationId: 'conv-0',
    })),
  };
  const lead = await runSuggestion(
    stubClient({ '/api/modules/interaction-message/records?limit=100': messages }),
    'bo04:sequenze:lead-sito',
  );
  assert.ok(lead.lines.some((line) => line.includes('6 messaggi dal form del sito')));
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
        { id: 'opp-1', name: 'Prova costume', pipelineKey: 'b2b-sales', pipelineStage: 'proposal', stage: 'proposal', valueCents: 150000, currency: 'EUR' },
        { id: 'opp-2', name: 'Annuale', pipelineKey: 'b2b-sales', pipelineStage: 'proposal', stage: 'proposal', valueCents: 20000, currency: 'EUR' },
        { id: 'opp-3', name: 'Senza importo', pipelineKey: 'b2b-sales', pipelineStage: 'new', stage: 'new' },
      ],
    },
    '/api/schema': {
      pipelines: [{
        name: 'b2b-sales', module: 'opportunity',
        stages: [
          { key: 'new', type: 'open' },
          { key: 'proposal', type: 'open' },
          { key: 'won', type: 'won' },
          { key: 'lost', type: 'lost' },
        ],
      }],
    },
  });
  const answer = await runSuggestion(client, 'bo04:pipeline:chiusura');
  assert.ok(answer.lines.some((line) => line.includes('EUR 1,700.00')));
  assert.ok(!answer.lines.some((line) => line.includes('.000')));
  assert.ok(sourceIds(answer).every((id) => ['opp-1', 'opp-2', 'opp-3'].includes(id)));
  // Opportunity sources link the pipeline board that renders them, never the
  // dead generated-module detail route for a core module.
  for (const source of answer.sources) {
    assert.equal(source.href, '#/pipelines/b2b-sales');
  }
  assert.ok(answer.actions.some((action) => action.href === '#/pipelines/b2b-sales'));
});

test('chiusura: valute miste mai sommate, una riga per valuta', async () => {
  const client = stubClient({
    '/api/opportunities': {
      items: [
        { id: 'opp-1', name: 'Prova costume', stage: 'proposal', valueCents: 170000, currency: 'EUR' },
        { id: 'opp-2', name: 'US deal', stage: 'proposal', valueCents: 10000, currency: 'USD' },
      ],
    },
    '/api/schema': { pipelines: [{ name: 'b2b-sales', module: 'opportunity' }] },
  });
  const answer = await runSuggestion(client, 'bo04:pipeline:chiusura');
  assert.ok(answer.lines.some((line) => line.includes('EUR 1,700.00')));
  assert.ok(answer.lines.some((line) => line.includes('USD 100.00')));
  assert.ok(!answer.lines.some((line) => line.includes('EUR 1,800.00')));
  assert.ok(!answer.lines.some((line) => line.includes('USD 1,800.00')));
});

test('chiusura: vinte, perse e chiuse escluse dai conteggi', async () => {
  const client = stubClient({
    '/api/opportunities': {
      items: [
        { id: 'opp-won', name: 'Vinta', pipelineKey: 'b2b-sales', pipelineStage: 'won', stage: 'won', valueCents: 500000, currency: 'EUR' },
        { id: 'opp-lost', name: 'Persa', pipelineKey: 'b2b-sales', pipelineStage: 'lost', stage: 'lost', valueCents: 300000, currency: 'EUR' },
        { id: 'opp-closed', name: 'Chiusa', pipelineKey: 'b2b-sales', pipelineStage: 'proposal', stage: 'proposal', valueCents: 200000, currency: 'EUR', closedAt: '2026-10-19T10:00:00.000Z' },
        { id: 'opp-open', name: 'Aperta', pipelineKey: 'b2b-sales', pipelineStage: 'proposal', stage: 'proposal', valueCents: 100000, currency: 'EUR' },
      ],
    },
    '/api/schema': {
      pipelines: [{
        name: 'b2b-sales', module: 'opportunity',
        stages: [
          { key: 'proposal', type: 'open' },
          { key: 'won', type: 'won' },
          { key: 'lost', type: 'lost' },
        ],
      }],
    },
  });
  const answer = await runSuggestion(client, 'bo04:pipeline:chiusura');
  assert.ok(answer.lines.some((line) => line.includes('1 opportunità aperta in pipeline')));
  assert.ok(answer.lines.some((line) => line.includes('su 4 lette')));
  assert.ok(answer.lines.some((line) => line.includes('EUR 1,000.00')));
  assert.ok(!answer.lines.some((line) => line.includes('5,000') || line.includes('3,000') || line.includes('2,000')));
  assert.deepEqual(sourceIds(answer), ['opp-open']);
});

test('chiusura senza board: record come testo, nessun link morto', async () => {
  const client = stubClient({
    '/api/opportunities': {
      items: [{ id: 'opp-1', name: 'Prova costume', stage: 'proposal', valueCents: 150000, currency: 'EUR' }],
    },
    '/api/schema': { pipelines: [{ name: 'other-board', module: 'lead' }] },
  });
  const answer = await runSuggestion(client, 'bo04:pipeline:chiusura');
  assert.deepEqual(answer.sources, []);
  assert.ok(!answer.actions.some((action) => String(action.href ?? '').includes('opportunity')));
  assert.ok(answer.lines.some((line) => line.includes('Prova costume')));
});

test('ai-puo: registri llm-call-audit reali + capability deterministiche', async () => {
  const client = stubClient({
    '/api/modules/llm-call-audit/records?limit=20': {
      items: [
        { id: 'audit-1', purpose: 'assistant', model: 'gpt-6-luna', dryRun: true },
        { id: 'audit-2', purpose: 'suggest', model: 'gpt-6-luna', dryRun: true },
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

/**
 * The real Admin client (app.js moduleClient) refuses mutations whose
 * Idempotency-Key is not submission-owned (admin-submission.js
 * requireSubmissionContext, KEY_RE). This wrapper mirrors that gate so the
 * panel tests prove the keys work on the real code path, not only on the
 * permissive stub.
 */
function gatedClient(routes) {
  const inner = stubClient(routes);
  return {
    calls: inner.calls,
    async request(path, options = {}) {
      const method = String(options.method ?? 'GET').toUpperCase();
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        requireSubmissionContext(options);
      }
      return inner.request(path, options);
    },
  };
}

test('azione api passa il gate reale del client (chiave submission-owned)', async () => {
  const client = gatedClient({
    '/api/modules/conversation/records/conv-2/actions/mark-read': { read: { id: 'conv-2' } },
  });
  const outcome = await runAssistantAction(
    client,
    {
      id: 'bo04:segna-letta:conv-2', label: 'Segna come letta', kind: 'api',
      request: { path: '/api/modules/conversation/records/conv-2/actions/mark-read', method: 'POST', body: {} },
      customerFacing: false,
    },
    {},
  );
  assert.equal(outcome.ok, true);
  assert.equal(client.calls.length, 1);
  const key = client.calls[0].options.idempotencyKey;
  assert.equal(requireSubmissionContext({ idempotencyKey: key }), key);
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

test('probe: dot-segment o suffissi sotto /api/assistant/ restano dry-run', async () => {
  for (const endpoint of [
    '/api/assistant/../modules/conversation/records/conv-1/actions/close',
    '/api/assistant/ask/extra',
    '/api/assistant/ask?x=1',
    '/api/assistant/ask#frag',
    '/api/assistant/',
    '/api/assistant',
  ]) {
    const client = stubClient({ [ASSISTANT_STATUS_PATH]: { freeQuestions: 'enabled', endpoint } });
    assert.equal((await probeAssistantBackend(client)).mode, 'dry-run', endpoint);
    assert.equal(client.calls.length, 1, endpoint);
  }
});

test('domanda libera: endpoint fuori contratto rifiuta senza richieste', async () => {
  const client = stubClient({ '/api/assistant/ask': { lines: ['ok'], sources: [] } });
  for (const endpoint of [
    '/api/assistant/../modules/conversation/records/conv-1/actions/close',
    '/api/modules/conversation/records/conv-1/actions/close',
    '/api/outbox/send',
    '/api/assistant/ask/extra',
  ]) {
    const outcome = await askFreeQuestion(client, { mode: 'live', endpoint }, 'chi devo ricontattare?');
    assert.equal(outcome.disabled, true, endpoint);
  }
  assert.equal(client.calls.length, 0);
});

test('azione api fuori allowlist rifiuta anche con conferma, zero richieste', async () => {
  const client = stubClient({
    '/api/outbox/send': { ok: true },
    '/api/modules/conversation/records/conv-2/actions/delete': { ok: true },
  });
  for (const request of [
    { path: '/api/outbox/send', method: 'POST', body: {} },
    { path: '/api/modules/conversation/records/conv-2/actions/delete', method: 'POST', body: {} },
    { path: '/api/modules/conversation/records/..%2F..%2Fx/actions/close', method: 'POST', body: {} },
    { path: '/api/modules/conversation/records/conv-2/actions/mark-read', method: 'GET', body: {} },
    { path: '/api/modules/conversation/records/conv-2/actions/mark-read', method: 'POST', body: { text: 'ciao' } },
  ]) {
    await assert.rejects(
      runAssistantAction(
        client,
        { id: 'evil', label: 'Evil', kind: 'api', request, customerFacing: true },
        { confirmedActionId: 'evil' },
      ),
      /non consentita/,
      request.path,
    );
  }
  assert.equal(client.calls.length, 0);
});

test('titoli a tappo dicono la pagina, non il totale', async () => {
  const callsAtCap = {
    items: Array.from({ length: 100 }, (_, index) => ({
      id: `call-${index}`, outcome: 'completed', teamAuthorId: 'guido', remoteHandle: '+39 333 000 0001',
    })),
  };
  const chiamate = await runSuggestion(
    stubClient({ '/api/modules/interaction-call/records?limit=100': callsAtCap }),
    'bo04:oggi:chiamate',
  );
  assert.ok(chiamate.lines.some((line) => line.includes('(prime 100 lette)')), JSON.stringify(chiamate.lines));
  const report = await runSuggestion(
    stubClient({ '/api/modules/interaction-call/records?limit=100': callsAtCap }),
    'bo04:reporting:call',
  );
  assert.ok(report.lines.some((line) => line.includes('(prime 100 lette)')), JSON.stringify(report.lines));
  const signals = await runSuggestion(
    stubClient({
      '/api/modules/behavioral-signal/records?limit=100': {
        items: Array.from({ length: 100 }, (_, index) => ({
          id: `sig-${index}`, leadId: 'lead-a', signalType: 'pricing-page-visited',
          observedAt: '2026-10-20T08:00:00.000Z',
        })),
      },
    }),
    'bo04:clienti:segnali',
  );
  assert.ok(signals.lines.some((line) => line.includes('(prime 100 lette)')), JSON.stringify(signals.lines));
  const chiusura = await runSuggestion(
    stubClient({
      '/api/opportunities': {
        items: Array.from({ length: 100 }, (_, index) => ({
          id: `opp-${index}`, name: `Affare ${index}`, stage: 'proposal', valueCents: 10000, currency: 'EUR',
        })),
      },
      '/api/schema': { pipelines: [{ name: 'b2b-sales', module: 'opportunity' }] },
    }),
    'bo04:pipeline:chiusura',
  );
  assert.ok(chiusura.lines.some((line) => line.includes('(prime 100 lette)')), JSON.stringify(chiusura.lines));
  // Below the cap the headline stays bare: no page qualifier invented.
  const few = await runSuggestion(
    stubClient({ '/api/modules/interaction-call/records?limit=100': CALLS }),
    'bo04:oggi:chiamate',
  );
  assert.ok(!few.lines.some((line) => line.includes('prime ')), JSON.stringify(few.lines));
});

test('probe: un endpoint arbitrario sotto /api/ resta dry-run', async () => {
  const sneaky = stubClient({
    [ASSISTANT_STATUS_PATH]: { freeQuestions: 'enabled', endpoint: '/api/modules/conversation/records/conv-1/actions/close' },
  });
  assert.deepEqual(await probeAssistantBackend(sneaky), {
    mode: 'dry-run', freeQuestions: 'disabled', endpoint: null, notice: FREE_QUESTION_DISABLED_NOTICE,
  });
  const lookalike = stubClient({
    [ASSISTANT_STATUS_PATH]: { freeQuestions: 'enabled', endpoint: '/api/assistant-evil/ask' },
  });
  assert.equal((await probeAssistantBackend(lookalike)).mode, 'dry-run');
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

test('domande libere distinte hanno identità distinte e valide', async () => {
  const seen = [];
  const client = gatedClient({
    '/api/assistant/ask': (path, options) => {
      seen.push(options.idempotencyKey);
      return { lines: ['ok'], sources: [] };
    },
  });
  const live = { mode: 'live', endpoint: '/api/assistant/ask' };
  // Same length, same first 32 chars: the old length+prefix scheme collided.
  await askFreeQuestion(client, live, `${'A'.repeat(32)}${'X'.repeat(100)}`);
  await askFreeQuestion(client, live, `${'A'.repeat(32)}${'Y'.repeat(100)}`);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  for (const key of seen) requireSubmissionContext({ idempotencyKey: key });
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

test('pannello: open with a draft prefills the free-question input as text', async () => {
  // BO-F5-01 (backlog:8691acfc, P2 admin-reporting.js:289): the description
  // typed on the "+ Nuovo modulo" screen lands in the panel input, so the
  // user never retypes it there. Text only — never markup, never a submit.
  const doc = createFakeDocument();
  const mount = createMount();
  const panel = createAssistantPanel({
    doc,
    mount,
    client: stubClient({
      '/api/modules/conversation/records?limit=50': CONVS,
      '/api/modules/interaction-call/records?limit=100': CALLS,
    }),
    navigate: () => {},
    notify: () => {},
  });
  await panel.open('nuovo-modulo', 'un modulo sonde per i KPI del pilota');
  const inputs = mount.findAll('input');
  assert.equal(inputs.length, 1, 'the panel has its free-question input');
  assert.equal(inputs[0].value, 'un modulo sonde per i KPI del pilota', 'the draft is prefilled');
  // A hostile draft lands as input text, never markup.
  await panel.open('nuovo-modulo', '<img src=x onerror=alert(1)>');
  assert.equal(mount.findAll('input')[0].value, '<img src=x onerror=alert(1)>', 'hostile text stays text');
  // Opening without a draft clears the prefill.
  await panel.open('nuovo-modulo');
  assert.equal(mount.findAll('input')[0].value, '', 'no stale draft survives');
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

// Review findings rev-agent-crm-299-41143348c226: regression probes.

test('chiudi con flag falso resta confermata per effetto, mai eseguita', async () => {
  const client = stubClient({
    '/api/modules/conversation/records/conv-2/actions/close': { ok: true, id: 'conv-2', status: 'closed' },
  });
  const forged = {
    id: 'bo04:chiudi:conv-2', label: 'Chiudi', kind: 'api',
    request: { path: '/api/modules/conversation/records/conv-2/actions/close', method: 'POST', body: {} },
    customerFacing: false,
  };
  const refused = await runAssistantAction(client, forged, {});
  assert.equal(refused.needsConfirmation, true);
  assert.ok(!client.calls.some((call) => String(call.path).includes('/actions/close')));
  const done = await runAssistantAction(client, forged, { confirmedActionId: forged.id });
  assert.equal(done.ok, true);
  assert.ok(client.calls.some(
    (call) => call.path === '/api/modules/conversation/records/conv-2/actions/close',
  ));
});

test('slot: fissati sono booked più confirmed, mai undefined', async () => {
  const client = stubClient({
    '/api/modules/appointment/records?limit=50': {
      items: [
        { id: 'appt-1', status: 'booked', startsAt: '2026-10-21T10:00:00.000Z' },
        { id: 'appt-2', status: 'confirmed', startsAt: '2026-10-22T10:00:00.000Z' },
        { id: 'appt-3', status: 'done', startsAt: '2026-10-19T10:00:00.000Z' },
        { id: 'appt-4', status: 'cancelled', startsAt: '2026-10-23T10:00:00.000Z' },
        { id: 'appt-5', startsAt: '2026-10-24T10:00:00.000Z' },
        { id: 'appt-6', status: 'no-show', startsAt: '2026-10-20T10:00:00.000Z' },
      ],
    },
  });
  const answer = await runSuggestion(client, 'bo04:calendario:slot');
  assert.ok(answer.lines.some((line) => line.includes('2 appuntamenti fissati letti')), JSON.stringify(answer.lines));
  assert.deepEqual([...sourceIds(answer)].sort(), ['appt-1', 'appt-2']);
});

test('chiusura: come la board (solo pipelineKey, gruppi per pipelineStage)', async () => {
  const client = stubClient({
    '/api/opportunities': {
      items: [
        { id: 'opp-off', name: 'Legacy diretta', pipelineKey: null, stage: 'proposal', valueCents: 100000, currency: 'EUR' },
        { id: 'opp-demo', name: 'Demo vera', pipelineKey: 'b2b-sales', pipelineStage: 'demo', stage: 'qualification', valueCents: 200000, currency: 'EUR' },
        { id: 'opp-won', name: 'Vinta', pipelineKey: 'b2b-sales', pipelineStage: 'won', stage: 'proposal', valueCents: 500000, currency: 'EUR' },
        { id: 'opp-drift', name: 'Fase vecchia', pipelineKey: 'b2b-sales', pipelineStage: 'vecchia', valueCents: 50000, currency: 'EUR' },
      ],
    },
    '/api/schema': {
      pipelines: [{
        name: 'b2b-sales', module: 'opportunity',
        stages: [
          { key: 'demo', label: 'Demo', type: 'open' },
          { key: 'proposal', label: 'Proposta', type: 'open' },
          { key: 'won', label: 'Vinta', type: 'won' },
          { key: 'lost', label: 'Persa', type: 'lost' },
        ],
      }],
    },
  });
  const answer = await runSuggestion(client, 'bo04:pipeline:chiusura');
  // Headline counts only the placed open row, on the read page of 4.
  assert.ok(
    answer.lines.some((line) => line.includes('1 opportunità aperta in pipeline b2b-sales') && line.includes('su 4 lette')),
    JSON.stringify(answer.lines),
  );
  // Grouped by pipelineStage (board label), never by the legacy stage.
  assert.ok(answer.lines.some((line) => line.includes('Demo: 1')), JSON.stringify(answer.lines));
  assert.ok(!answer.lines.some((line) => line.includes('qualification: 1')), JSON.stringify(answer.lines));
  // Off-pipeline disclosed as text, terminal and drift excluded from totals.
  assert.ok(answer.lines.some((line) => line.includes('fuori pipeline b2b-sales')), JSON.stringify(answer.lines));
  assert.ok(answer.lines.some((line) => line.includes('fase fuori definizione')), JSON.stringify(answer.lines));
  assert.deepEqual(sourceIds(answer), ['opp-demo']);
  for (const source of answer.sources) {
    assert.equal(source.href, '#/pipelines/b2b-sales');
  }
  assert.ok(answer.lines.some((line) => line.includes('EUR 2,000.00')), JSON.stringify(answer.lines));
  assert.ok(!answer.lines.some((line) => line.includes('5,000.00')), JSON.stringify(answer.lines));
  assert.ok(!answer.lines.some((line) => line.includes('500.00')), JSON.stringify(answer.lines));
});

// BO-F4-04 — execution trace: every read behind an answer is recorded.

test('traccia: ogni lettura registrata con superficie, limite e righe', async () => {
  const client = stubClient({
    '/api/modules/conversation/records?limit=50': CONVS,
    '/api/modules/data-quality-issue/records?limit=50': ISSUES,
  });
  const answer = await runSuggestion(client, 'bo04:oggi:urgenti');
  assert.equal(answer.trace.suggestionId, 'bo04:oggi:urgenti');
  assert.ok(typeof answer.trace.at === 'string' && answer.trace.at !== '');
  const byTarget = Object.fromEntries(answer.trace.reads.map((read) => [read.target, read]));
  assert.deepEqual(byTarget.conversation, { target: 'conversation', limit: 50, status: 'ok', rows: 3 });
  assert.deepEqual(byTarget['data-quality-issue'], { target: 'data-quality-issue', limit: 50, status: 'ok', rows: 2 });
  // Every cited source comes from a read of this same run, never invented.
  const readIds = [...CONVS.items, ...ISSUES.items].map((row) => row.id);
  for (const source of answer.sources) {
    assert.ok(readIds.includes(source.id), `invented source ${source.id}`);
  }
});

test('traccia: modulo illeggibile registrato come mancante, la risposta resta', async () => {
  const client = stubClient({ '/api/modules/conversation/records?limit=50': CONVS });
  const answer = await runSuggestion(client, 'bo04:oggi:urgenti');
  const byTarget = Object.fromEntries(answer.trace.reads.map((read) => [read.target, read]));
  assert.deepEqual(byTarget['data-quality-issue'], { target: 'data-quality-issue', limit: 50, status: 'missing', rows: 0 });
  assert.ok(answer.sources.length > 0);
  assert.ok(answer.unavailable.some((note) => note.includes('data-quality-issue')));
});

test('traccia: chiusura registra opportunità e schema', async () => {
  const client = stubClient({
    '/api/opportunities': { items: [{ id: 'opp-1', name: 'Prova', pipelineKey: 'b2b-sales', pipelineStage: 'proposal', stage: 'proposal' }] },
    '/api/schema': { pipelines: [] },
  });
  const answer = await runSuggestion(client, 'bo04:pipeline:chiusura');
  const byTarget = Object.fromEntries(answer.trace.reads.map((read) => [read.target, read]));
  assert.deepEqual(byTarget.opportunities, { target: 'opportunities', limit: null, status: 'ok', rows: 1 });
  assert.deepEqual(byTarget.schema.status, 'ok');
});

test('traccia: opportunità illeggibili registrate come mancanti', async () => {
  const client = stubClient({ '/api/schema': { pipelines: [] } });
  const answer = await runSuggestion(client, 'bo04:pipeline:chiusura');
  const byTarget = Object.fromEntries(answer.trace.reads.map((read) => [read.target, read]));
  assert.deepEqual(byTarget.opportunities, { target: 'opportunities', limit: null, status: 'missing', rows: 0 });
  assert.ok(answer.unavailable.some((note) => note.includes('Opportunità')));
});

test('traccia: risposta non valida registrata come invalida', async () => {
  const client = stubClient({ '/api/modules/conversation/records?limit=50': { items: 'no' } });
  const answer = await runSuggestion(client, 'bo04:oggi:urgenti');
  const byTarget = Object.fromEntries(answer.trace.reads.map((read) => [read.target, read]));
  assert.deepEqual(byTarget.conversation, { target: 'conversation', limit: 50, status: 'invalid', rows: 0 });
});

test('traccia: esecuzione registrata — attesa, esecuzione, rifiuto', async () => {
  const client = stubClient({
    '/api/modules/conversation/records/conv-2/actions/close': { ok: true, id: 'conv-2', status: 'closed' },
  });
  const trace = [];
  const close = {
    id: 'bo04:chiudi:conv-2', label: 'Chiudi il thread', kind: 'api',
    request: { path: '/api/modules/conversation/records/conv-2/actions/close', method: 'POST', body: {} },
    customerFacing: true,
  };
  const gated = await runAssistantAction(client, close, { trace });
  assert.equal(gated.needsConfirmation, true);
  assert.deepEqual(trace.map((entry) => entry.outcome), ['needs-confirmation']);
  const done = await runAssistantAction(client, close, { confirmedActionId: close.id, trace });
  assert.equal(done.ok, true);
  assert.deepEqual(trace.map((entry) => entry.outcome), ['needs-confirmation', 'executed']);
  assert.ok(trace.every((entry) => entry.actionId === close.id && typeof entry.at === 'string'));
  const forged = { ...close, id: 'bo04:chiudi:forged', request: { path: '/api/modules/x', method: 'POST', body: {} } };
  await assert.rejects(runAssistantAction(client, forged, { confirmedActionId: forged.id, trace }), /non consentita/);
  assert.equal(trace[trace.length - 1].outcome, 'failed');
  assert.equal(trace[trace.length - 1].actionId, forged.id);
});

test('traccia: domanda libera live registra endpoint e righe', async () => {
  const client = stubClient({
    '/api/assistant/ask': {
      lines: ['Ecco i thread aperti.'],
      sources: [{ module: 'conversation', id: 'conv-1', label: 'Marco Rossi' }],
    },
  });
  const outcome = await askFreeQuestion(client, { mode: 'live', endpoint: '/api/assistant/ask' }, 'chi devo ricontattare?');
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.answer.trace.reads, [{ target: 'assistant-ask', limit: null, status: 'ok', rows: 1 }]);
  assert.equal(outcome.answer.trace.suggestionId, 'bo04:domanda-libera');
});

test('pannello: traccia ispezionabile e cronologia conservata', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    '/api/modules/conversation/records?limit=50': CONVS,
    '/api/modules/data-quality-issue/records?limit=50': ISSUES,
  });
  const panel = createAssistantPanel({ doc, mount, client, navigate: () => {}, notify: () => {} });
  await panel.open('clienti');
  mount.findByText('button', 'Chi devo ricontattare?').dispatch('click', {});
  await tick();
  await tick();
  assert.ok(mount.textContent.includes('Traccia di esecuzione'));
  assert.ok(mount.textContent.includes('conversation: 3 righe lette (limite 50)'));
  assert.equal(panel.getState().traceReads, 1);
  assert.equal(panel.getState().historyCount, 1);
  mount.findByText('button', 'Quali lead mostrano segnali caldi?').dispatch('click', {});
  await tick();
  await tick();
  // behavioral-signal is not composed here: the trace names the missing
  // read instead of failing, and the answer is kept anyway.
  assert.ok(mount.textContent.includes('behavioral-signal: non leggibile in questo spazio'));
  assert.ok(mount.textContent.includes('Cronologia'));
  assert.equal(panel.getState().historyCount, 2);
  const historyButtons = mount.findAll('button').filter(
    (node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-assistant-history-open'),
  );
  assert.equal(historyButtons.length, 2);
  historyButtons[0].dispatch('click', {});
  // Reopening a past answer shows its conserved trace without new reads.
  const readsBefore = client.calls.length;
  assert.equal(panel.getState().answerTitle, 'Chi devo ricontattare?');
  assert.ok(mount.textContent.includes('conversation: 3 righe lette (limite 50)'));
  assert.equal(client.calls.length, readsBefore);
  assert.equal(panel.getState().historyCount, 2);
});

// Voce d525f4aa48b2: le proposte della scheda leggono la scheda viva con il
// cliente nel contesto, e ogni azione collegata chiede conferma prima di
// toccare il cliente.

const SCHEDA_CARD = {
  customerCardContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  name: 'Guido Presti',
  phone: { available: true, value: '+39 333 1234567' },
  // Production shape: the card never serves notes (packages/customer-hub/src/card.js).
  notes: { available: false, items: null },
};

const SCHEDA_TIMELINE = {
  customerTimelineContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  entries: {
    available: true,
    count: 3,
    truncated: false,
    items: [
      { entry: 'note', id: 'n1', body: 'Prima nota' },
      { entry: 'message', id: 'm1' },
      { entry: 'note', id: 'n2', body: 'Seconda nota' },
    ],
  },
};

const schedaClient = (card = SCHEDA_CARD, timeline = SCHEDA_TIMELINE) => stubClient({
  '/api/customer-hub/card/contact/c1': card,
  '/api/customer-hub/timeline/contact/c1': timeline,
});

test('scheda-cliente: le due proposte leggono la scheda viva e citano la scheda', async () => {
  assert.deepEqual(
    suggestionsFor('scheda-cliente').map((suggestion) => suggestion.id),
    ['bo04:scheda:cambia-telefono', 'bo04:scheda:aggiungi-nota']);
  const phone = await runSuggestion(schedaClient(), 'bo04:scheda:cambia-telefono', { resource: 'contact', id: 'c1' });
  assert.ok(phone.lines.join('\n').includes('+39 333 1234567'), 'the live number is named');
  assert.deepEqual(phone.sources.map((source) => source.href), ['#/customer-card/contact/c1']);
  assert.equal(phone.trace.reads.length, 1);
  assert.equal(phone.trace.reads[0].status, 'ok');
  const note = await runSuggestion(schedaClient(), 'bo04:scheda:aggiungi-nota', { resource: 'contact', id: 'c1' });
  // Only timeline entries with entry==='note' count: the message stays out.
  assert.ok(note.lines.join('\n').includes('Note registrate per Guido Presti: 2.'));
  assert.equal(note.unavailable.length, 0);
  assert.deepEqual(note.trace.reads.map((read) => read.target), ['customer-hub/card', 'customer-hub/timeline']);
});

test('scheda-cliente: la cronologia troncata dichiara il minimo, non il totale', async () => {
  const truncated = {
    ...SCHEDA_TIMELINE,
    entries: { ...SCHEDA_TIMELINE.entries, truncated: true },
  };
  const note = await runSuggestion(
    schedaClient(SCHEDA_CARD, truncated),
    'bo04:scheda:aggiungi-nota', { resource: 'contact', id: 'c1' });
  assert.ok(note.lines.join('\n').includes('Note registrate per Guido Presti: almeno 2 (cronologia troncata).'));
});

test('scheda-cliente: senza cliente nel contesto nessuna lettura, nessuna azione', async () => {
  for (const customer of [null, undefined, {}, { resource: 'contact' }, { resource: '../../x', id: 'c1' }]) {
    const client = schedaClient();
    const answer = await runSuggestion(client, 'bo04:scheda:cambia-telefono', customer);
    assert.ok(answer.unavailable.join('\n').includes('Nessun cliente nel contesto'));
    assert.deepEqual(answer.actions, []);
    assert.equal(client.calls.length, 0, 'a hostile or missing context never reaches a route');
  }
});

test('scheda-cliente: scheda illeggibile nominata, mai inventata', async () => {
  const missing = stubClient({});
  const phone = await runSuggestion(missing, 'bo04:scheda:cambia-telefono', { resource: 'contact', id: 'c1' });
  assert.ok(phone.unavailable.join('\n').includes('Scheda non leggibile'));
  assert.deepEqual(phone.actions, []);
  assert.deepEqual(phone.sources, []);
  const noPhone = await runSuggestion(
    schedaClient({ ...SCHEDA_CARD, phone: { available: false, value: null } }),
    'bo04:scheda:cambia-telefono', { resource: 'contact', id: 'c1' });
  assert.ok(noPhone.lines.join('\n').includes('non ha un telefono collegato'));
  // The timeline route is not served here, so the note count has no honest
  // source even though the card itself reads fine.
  const noTimeline = stubClient({ '/api/customer-hub/card/contact/c1': SCHEDA_CARD });
  const noNotes = await runSuggestion(
    noTimeline, 'bo04:scheda:aggiungi-nota', { resource: 'contact', id: 'c1' });
  assert.ok(noNotes.lines.join('\n').includes('non sono leggibili in questo spazio'));
});

test('scheda-cliente: ogni azione collegata chiede conferma prima di toccare il cliente', async () => {
  for (const suggestionId of ['bo04:scheda:cambia-telefono', 'bo04:scheda:aggiungi-nota']) {
    const client = schedaClient();
    const answer = await runSuggestion(client, suggestionId, { resource: 'contact', id: 'c1' });
    assert.ok(answer.actions.length > 0, `${suggestionId} links an action`);
    for (const action of answer.actions) {
      assert.equal(action.customerFacing, true, `${action.id} is customer-facing`);
      const seen = [];
      const gated = await runAssistantAction(client, action, { navigate: (href) => seen.push(href) });
      assert.equal(gated.ok, false);
      assert.equal(gated.needsConfirmation, true);
      assert.ok(gated.confirmLabel.includes('Guido Presti'));
      assert.deepEqual(seen, [], 'nothing navigates without confirmation');
    }
    // The phone proposal reads the card only; the note proposal also reads
    // the live timeline for the count, and nothing else.
    const expectedCalls = suggestionId === 'bo04:scheda:aggiungi-nota' ? 2 : 1;
    assert.equal(client.calls.length, expectedCalls, 'only the card and timeline reads run');
    const confirmed = await runAssistantAction(client, answer.actions[0], {
      navigate: () => {},
      confirmedActionId: answer.actions[0].id,
    });
    assert.equal(confirmed.ok, true, 'the confirmed action runs');
  }
});

test('scheda-cliente: il pannello tiene il cliente della scheda e lo dimentica alla schermata dopo', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const panel = createAssistantPanel({ doc, mount, client: schedaClient(), navigate: () => {}, notify: () => {} });
  await panel.open('scheda-cliente', 'Cliente Guido Presti (contact/c1)', { resource: 'contact', id: 'c1' });
  assert.deepEqual(panel.getState().customerCtx, { resource: 'contact', id: 'c1' });
  assert.ok(mount.textContent.includes('Cambia il telefono in …'));
  assert.ok(mount.textContent.includes('Aggiungi una nota: …'));
  await panel.open('clienti');
  assert.equal(panel.getState().customerCtx, null, 'no stale customer on the next screen');
});

test('scheda-cliente: un nome ostile resta testo e non entra negli href', async () => {
  const nasty = '<img src=x onerror=alert(1)>';
  const answer = await runSuggestion(
    schedaClient({ ...SCHEDA_CARD, name: nasty }),
    'bo04:scheda:cambia-telefono', { resource: 'contact', id: 'c1' });
  assert.ok(answer.lines.join('\n').includes(nasty), 'the name is named, not dropped');
  for (const source of answer.sources) {
    assert.equal(source.href, '#/customer-card/contact/c1');
    assert.ok(!source.href.includes(nasty));
  }
  for (const action of answer.actions) {
    assert.ok(!action.href.includes(nasty));
  }
});
