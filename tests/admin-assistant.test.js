import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_SPACE_DISABLED_NOTICE,
  ASSISTANT_STATUS_PATH,
  ASSISTANT_SUGGEST_ONLY_NOTICE,
  FREE_QUESTION_DISABLED_NOTICE,
  SUGGESTION_CATALOG,
  answerFreeLocal,
  askFreeQuestion,
  assistantDisabledNotice,
  createAssistantPanel,
  isSafeRecordId,
  italianDates,
  probeAssistantBackend,
  runAssistantAction,
  runSuggestion,
  suggestionsFor,
} from '../apps/admin/public/admin-assistant.js';
import { requireSubmissionContext } from '../apps/admin/public/admin-submission.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
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
      enforceAdminWriteGate(path, options);
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
    '/api/modules/contact/records?limit=50': {
      items: [{ id: 'lead-a', firstName: 'Marco', lastName: 'Rossi' }],
    },
    '/api/modules/company/records?limit=50': {
      items: [{ id: 'lead-b', name: 'Acme S.r.l.' }],
    },
  });
  const answer = await runSuggestion(client, 'bo04:clienti:segnali');
  assert.deepEqual(sourceIds(answer), ['sig-2', 'sig-3']);
  // Voce a684ecf5: le righe nominano i clienti, mai gli id grezzi.
  assert.ok(answer.lines.some((line) => line.includes('Marco Rossi') && line.includes('2 segnali')));
  assert.ok(!answer.lines.some((line) => line.includes('lead-a') || line.includes('lead-b')));
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
      enforceAdminWriteGate(path, options);
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

// Acceptance d8d9ddd0: without free questions the panel is usable, the free
// field hidden, one honest line. The key sentence appears only for a really
// missing key — never as the default.

test('probe: 404 o forma inattesa valgono dry-run, mai un errore', async () => {
  const missing = stubClient({});
  assert.deepEqual(await probeAssistantBackend(missing), {
    mode: 'dry-run', freeQuestions: 'disabled', endpoint: null, notice: ASSISTANT_SUGGEST_ONLY_NOTICE,
  });
  assert.ok(!ASSISTANT_SUGGEST_ONLY_NOTICE.includes('chiave OpenAI'));
  assert.ok(FREE_QUESTION_DISABLED_NOTICE.includes('finché la chiave OpenAI non è configurata'));
  const odd = stubClient({ [ASSISTANT_STATUS_PATH]: { freeQuestions: 'enabled' } });
  assert.equal((await probeAssistantBackend(odd)).mode, 'dry-run');
  const live = stubClient({ [ASSISTANT_STATUS_PATH]: { freeQuestions: 'enabled', endpoint: '/api/assistant/ask' } });
  assert.deepEqual(await probeAssistantBackend(live), {
    mode: 'live', freeQuestions: 'enabled', endpoint: '/api/assistant/ask', notice: '',
  });
});

test('probe: la riga dice la causa vera (chiave mancante, spazio non attivo, resto)', async () => {
  for (const field of ['code', 'reason', 'errorCode']) {
    const keyMissing = stubClient({
      [ASSISTANT_STATUS_PATH]: { freeQuestions: 'disabled', [field]: 'LLM_SECRET_UNAVAILABLE' },
    });
    assert.deepEqual(await probeAssistantBackend(keyMissing), {
      mode: 'dry-run', freeQuestions: 'disabled', endpoint: null, notice: FREE_QUESTION_DISABLED_NOTICE,
    }, field);
    const spaceOff = stubClient({
      [ASSISTANT_STATUS_PATH]: { freeQuestions: 'disabled', [field]: 'LLM_SPACE_DISABLED' },
    });
    assert.deepEqual(await probeAssistantBackend(spaceOff), {
      mode: 'dry-run', freeQuestions: 'disabled', endpoint: null, notice: ASSISTANT_SPACE_DISABLED_NOTICE,
    }, field);
  }
  assert.ok(ASSISTANT_SPACE_DISABLED_NOTICE.includes('non attivo in questo spazio'));
  // A refusal carrying the stable code names its reason too.
  const refused = new Error('spazio non attivo');
  Object.assign(refused, { status: 403, code: 'LLM_SPACE_DISABLED' });
  assert.equal((await probeAssistantBackend(stubClient({ [ASSISTANT_STATUS_PATH]: refused }))).notice,
    ASSISTANT_SPACE_DISABLED_NOTICE);
  const noKey = new Error('chiave assente');
  Object.assign(noKey, { status: 500, code: 'LLM_SECRET_UNAVAILABLE' });
  assert.equal((await probeAssistantBackend(stubClient({ [ASSISTANT_STATUS_PATH]: noKey }))).notice,
    FREE_QUESTION_DISABLED_NOTICE);
  assert.equal(assistantDisabledNotice(null), ASSISTANT_SUGGEST_ONLY_NOTICE);
  assert.equal(assistantDisabledNotice({ code: 'SOMETHING_ELSE' }), ASSISTANT_SUGGEST_ONLY_NOTICE);
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
    mode: 'dry-run', freeQuestions: 'disabled', endpoint: null, notice: ASSISTANT_SUGGEST_ONLY_NOTICE,
  });
  const lookalike = stubClient({
    [ASSISTANT_STATUS_PATH]: { freeQuestions: 'enabled', endpoint: '/api/assistant-evil/ask' },
  });
  assert.equal((await probeAssistantBackend(lookalike)).mode, 'dry-run');
});

test('domanda libera in dry-run: rifiuto onesto, zero richieste', async () => {
  const client = stubClient({
    [ASSISTANT_STATUS_PATH]: { freeQuestions: 'enabled', endpoint: '/api/assistant/ask' },
  });
  const outcome = await askFreeQuestion(client, { mode: 'dry-run' }, 'chi devo ricontattare?');
  assert.equal(outcome.disabled, true);
  assert.equal(outcome.notice, ASSISTANT_SUGGEST_ONLY_NOTICE);
  assert.ok(client.calls.every((call) => call.path !== '/api/assistant/ask'));
  // With a key-missing status the refusal carries the key line.
  const keyed = await askFreeQuestion(
    client, { mode: 'dry-run', notice: FREE_QUESTION_DISABLED_NOTICE }, 'chi devo ricontattare?',
  );
  assert.ok(keyed.notice.includes('finché la chiave OpenAI non è configurata'));
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

test('pannello: suggerimenti per schermata, fonti cliccabili, niente campo libero in dry-run', async () => {
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
  // No free-question field: one honest line, never the key sentence.
  assert.equal(mount.findAll('input').length, 0);
  assert.ok(!mount.textContent.includes('Domanda libera'));
  assert.ok(mount.textContent.includes('suggerisce le risposte ai messaggi (Suggerisci)'));
  assert.ok(!mount.textContent.includes('finché la chiave OpenAI non è configurata'));

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

test('pannello: i tre stati (attivo solo Suggerisci, spazio non attivo, chiave mancante)', async () => {
  async function openWith(status) {
    const doc = createFakeDocument();
    const mount = createMount();
    const panel = createAssistantPanel({
      doc,
      mount,
      client: stubClient({ [ASSISTANT_STATUS_PATH]: status }),
      navigate: () => {},
      notify: () => {},
    });
    await panel.open('clienti');
    return { panel, mount };
  }
  // Attivo con soli suggerimenti: niente campo libero, una riga onesta.
  const suggestOnly = await openWith({ freeQuestions: 'disabled' });
  assert.equal(suggestOnly.panel.getState().mode, 'dry-run');
  assert.equal(suggestOnly.mount.findAll('input').length, 0);
  assert.equal(suggestOnly.mount.findAll('form').length, 0);
  assert.ok(suggestOnly.mount.textContent.includes('suggerisce le risposte ai messaggi (Suggerisci)'));
  assert.ok(!suggestOnly.mount.textContent.includes('finché la chiave OpenAI non è configurata'));
  assert.ok(!suggestOnly.mount.textContent.includes('non attivo in questo spazio'));
  // Spazio non attivo (voce a684ecf5): spento + come si accende, senza chiave e senza dire cosa farebbe da acceso.
  const spaceOff = await openWith({ freeQuestions: 'disabled', code: 'LLM_SPACE_DISABLED' });
  assert.equal(spaceOff.panel.getState().mode, 'dry-run');
  assert.equal(spaceOff.mount.findAll('input').length, 0);
  assert.ok(spaceOff.mount.textContent.includes('non attivo in questo spazio'));
  assert.ok(spaceOff.mount.textContent.includes('titolare'));
  assert.ok(!spaceOff.mount.textContent.includes('(Suggerisci)'));
  assert.ok(!spaceOff.mount.textContent.includes('suggerisce'));
  assert.ok(!spaceOff.mount.textContent.includes('finché la chiave OpenAI non è configurata'));
  // Chiave mancante: solo qui compare la frase della chiave.
  const noKey = await openWith({ freeQuestions: 'disabled', code: 'LLM_SECRET_UNAVAILABLE' });
  assert.equal(noKey.panel.getState().mode, 'dry-run');
  assert.equal(noKey.mount.findAll('input').length, 0);
  assert.ok(noKey.mount.textContent.includes('finché la chiave OpenAI non è configurata'));
  // Live: il campo libero c'è e nessuna riga di scusa.
  const live = await openWith({ freeQuestions: 'enabled', endpoint: '/api/assistant/ask' });
  assert.equal(live.panel.getState().mode, 'live');
  assert.equal(live.mount.findAll('input').length, 1);
  assert.ok(live.mount.textContent.includes('Domanda libera'));
  assert.ok(!live.mount.textContent.includes('suggerisce le risposte ai messaggi (Suggerisci)'));
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
      [ASSISTANT_STATUS_PATH]: { freeQuestions: 'enabled', endpoint: '/api/assistant/ask' },
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

test('pannello: in dry-run il draft resta visibile come testo inerte, mai perso', async () => {
  // BO-F5-01 sul percorso reale di oggi (nessun backend live: solo dry-run):
  // senza campo libero il testo del chiamante non deve sparire in silenzio —
  // resta come testo inerte di sola lettura, mai markup, mai un invio.
  function openDryRun() {
    const doc = createFakeDocument();
    const mount = createMount();
    const panel = createAssistantPanel({
      doc,
      mount,
      client: stubClient({
        [ASSISTANT_STATUS_PATH]: { freeQuestions: 'disabled' },
        '/api/modules/conversation/records?limit=50': CONVS,
        '/api/modules/interaction-call/records?limit=100': CALLS,
      }),
      navigate: () => {},
      notify: () => {},
    });
    return { doc, mount, panel };
  }
  const { mount, panel } = openDryRun();
  await panel.open('nuovo-modulo', 'un modulo sonde per i KPI del pilota');
  assert.equal(panel.getState().mode, 'dry-run');
  assert.equal(mount.findAll('input').length, 0, 'no free-question field in dry-run');
  assert.equal(mount.findAll('form').length, 0, 'no free-question form in dry-run');
  const draft = mount.querySelector('.bo-assistant-draft');
  assert.ok(draft, 'the draft is shown');
  assert.equal(draft.textContent, 'un modulo sonde per i KPI del pilota');
  assert.equal(draft.childNodes.length, 0, 'draft is text, never markup');
  // A hostile draft lands as inert text, never markup, never a submit.
  await panel.open('nuovo-modulo', '<img src=x onerror=alert(1)>');
  assert.equal(mount.findAll('input').length, 0);
  const hostile = mount.querySelector('.bo-assistant-draft');
  assert.ok(hostile, 'the hostile draft is shown');
  assert.equal(hostile.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(hostile.childNodes.length, 0, 'hostile draft is text, never markup');
  // Opening without a draft shows no draft line.
  await panel.open('nuovo-modulo');
  assert.equal(mount.querySelector('.bo-assistant-draft'), null, 'no stale draft survives');
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

test('review #596 P1: a top-bar question asked during a confirmed action waits and then runs', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const navigated = [];
  const client = stubClient({ '/api/modules/conversation/records?limit=50': CONVS });
  const panel = createAssistantPanel({ doc, mount, client, navigate: (href) => navigated.push(href), notify: () => {} });
  await panel.open('clienti');
  mount.findByText('button', 'Chi devo ricontattare?').dispatch('click', {});
  await tick();
  await tick();
  mount.findByText('button', 'Contatta il cliente').dispatch('click', {});
  await tick();
  mount.findByText('button', 'Conferma:').dispatch('click', {});
  // The action is busy right now: the new question must wait, not vanish.
  const queued = panel.open('clienti', undefined, undefined, 'meteo a Milano');
  assert.ok(mount.textContent.includes('Finisco la risposta in corso'), 'the question waits visibly');
  await queued;
  for (let i = 0; i < 8; i += 1) await tick();
  assert.deepEqual(navigated, ['#/modules/conversation/conv-2'], 'the confirmed action ran');
  assert.ok(mount.textContent.includes('«meteo a Milano»'), 'the waiting question started after the action');
  assert.ok(!mount.textContent.includes('Finisco la risposta in corso'), 'nothing is left stranded');
});

test('review #596 P2: closing the panel cancels a waiting question; it never reopens by itself', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const base = stubClient({ '/api/modules/conversation/records?limit=50': CONVS });
  const client = {
    async request(path, options) {
      if (path.startsWith('/api/modules/conversation/records')) await gate;
      return base.request(path, options);
    },
  };
  const panel = createAssistantPanel({ doc, mount, client, navigate: () => {}, notify: () => {} });
  const first = panel.open('clienti', undefined, undefined, 'chi devo ricontattare oggi?');
  for (let i = 0; i < 6; i += 1) await tick();
  await panel.open('clienti', undefined, undefined, 'meteo a Milano');
  panel.close();
  release();
  await first;
  for (let i = 0; i < 8; i += 1) await tick();
  assert.equal(panel.getState().open, false, 'an explicit close stays closed');
  assert.equal(mount.textContent, '', 'nothing paints after close');
});

test('review #596 P2: the header ✕ cancels a waiting question and a slow probe like close()', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const base = stubClient({ '/api/modules/conversation/records?limit=50': CONVS });
  const client = {
    async request(path, options) {
      if (path.startsWith('/api/modules/conversation/records')) await gate;
      return base.request(path, options);
    },
  };
  const panel = createAssistantPanel({ doc, mount, client, navigate: () => {}, notify: () => {} });
  const first = panel.open('clienti', undefined, undefined, 'chi devo ricontattare oggi?');
  for (let i = 0; i < 6; i += 1) await tick();
  await panel.open('clienti', undefined, undefined, 'meteo a Milano');
  mount.findAll('button').find((node) => String(node.getAttribute('class') ?? '').includes('bo-assistant-close')).dispatch('click', {});
  release();
  await first;
  for (let i = 0; i < 8; i += 1) await tick();
  assert.equal(panel.getState().open, false, 'the ✕ close stays closed');
  await panel.open('clienti');
  assert.ok(!mount.textContent.includes('Finisco la risposta in corso'), 'no ghost waiting bubble on the next open');
  assert.ok(!mount.textContent.includes('«meteo a Milano»'), 'the cancelled question never runs');
});

// Voce 34fd687c: domande libere sui dati, con i nomi dei clienti e il
// contesto su più turni. Date locali a mezzogiorno: mai sul confine.

const pad2 = (part) => String(part).padStart(2, '0');
const localYmd = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
const LEAD_TODAY = localYmd(new Date());
const LEAD_YESTERDAY = localYmd(new Date(Date.now() - 86400000));
const atHour = (day, hour) => `${day}T${pad2(hour)}:00:00`;

const LEAD_CLIENT = {
  '/api/modules/contact/records?limit=50': {
    items: [
      { id: 'c-sara', firstName: 'Sara', lastName: 'Bianchi', email: 'sara@example.it', createdAt: atHour(LEAD_TODAY, 9) },
      { id: 'c-marco', firstName: 'Marco', lastName: 'Rossi', email: 'marco@example.it', createdAt: atHour(LEAD_TODAY, 8) },
      { id: 'c-ada', firstName: 'Ada', lastName: 'Neri', email: 'ada@example.it', createdAt: atHour(LEAD_YESTERDAY, 15) },
      { id: 'c-vecchio', firstName: 'Vecchio', lastName: 'Lead', createdAt: '2025-01-01T10:00:00' },
    ],
  },
  '/api/modules/company/records?limit=50': {
    items: [
      { id: 'co-olimpia', name: 'Palestra Olimpia', createdAt: atHour(LEAD_TODAY, 10) },
    ],
  },
};

function shownText(answer) {
  return [...answer.lines, ...answer.sources.map((source) => source.label),
    ...answer.actions.map((action) => `${action.label} ${action.confirmLabel ?? ''}`)].join('\n');
}

test('voce 34fd687c: «quanti lead oggi?» nomina i clienti, mai UUID', async () => {
  const client = stubClient(LEAD_CLIENT);
  const outcome = await askFreeQuestion(client, { mode: 'dry-run' }, 'quanti lead oggi??');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.disabled, false);
  const text = shownText(outcome.answer);
  assert.ok(outcome.answer.lines.some((line) => line.includes('3 lead nuovi oggi')), JSON.stringify(outcome.answer.lines));
  assert.ok(text.includes('Marco Rossi'));
  assert.ok(text.includes('Sara Bianchi'));
  assert.ok(text.includes('Palestra Olimpia'));
  assert.ok(!text.includes('Ada Neri'), 'yesterday stays out of today');
  for (const raw of ['c-marco', 'c-sara', 'co-olimpia', 'c-ada']) {
    assert.ok(!text.includes(raw), `raw id leaked: ${raw}`);
  }
  assert.ok(outcome.answer.sources.length > 0);
  for (const source of outcome.answer.sources) {
    assert.ok(source.href.startsWith('#/customer-card/'), source.href);
  }
  const action = outcome.answer.actions[0];
  assert.ok(action.label.includes('Marco Rossi'), 'the button names the first customer');
  assert.ok(action.href.includes('c-marco'));
});

test('voce 34fd687c: tre turni tengono il contesto (oggi, e ieri, chi è il primo)', async () => {
  const client = stubClient(LEAD_CLIENT);
  const dry = { mode: 'dry-run' };
  const first = await askFreeQuestion(client, dry, 'quanti lead oggi?');
  assert.equal(first.ok, true);
  assert.ok(first.answer.context && first.answer.context.kind === 'lead-day');
  const second = await askFreeQuestion(client, dry, 'e ieri?', first.answer.context);
  assert.equal(second.ok, true);
  assert.ok(shownText(second.answer).includes('Ada Neri'));
  assert.ok(!shownText(second.answer).includes('Marco Rossi'));
  const third = await askFreeQuestion(client, dry, 'chi è il primo?', second.answer.context);
  assert.equal(third.ok, true);
  assert.ok(third.answer.lines.some((line) => line.includes('Ada Neri')), JSON.stringify(third.answer.lines));
  assert.ok(third.answer.actions[0].label.includes('Ada Neri'));
});

test('voce 34fd687c: «chi è il primo?» senza contesto guida in italiano', async () => {
  const outcome = await askFreeQuestion(stubClient(LEAD_CLIENT), { mode: 'dry-run' }, 'chi è il primo?');
  assert.equal(outcome.ok, true);
  assert.ok(outcome.answer.lines.some((line) => line.includes('quanti lead oggi')), JSON.stringify(outcome.answer.lines));
  assert.deepEqual(outcome.answer.sources, []);
});

test('voce 34fd687c: ieri vuoto poi «chi è il primo?» non riusa il giorno prima', async () => {
  const dry = { mode: 'dry-run' };
  const todayOnly = stubClient({
    '/api/modules/contact/records?limit=50': {
      items: [
        { id: 'c-marco', firstName: 'Marco', lastName: 'Rossi', email: 'marco@example.it', createdAt: atHour(LEAD_TODAY, 8) },
      ],
    },
    '/api/modules/company/records?limit=50': { items: [] },
  });
  const first = await askFreeQuestion(todayOnly, dry, 'quanti lead oggi?');
  assert.equal(first.ok, true);
  assert.ok(first.answer.context && first.answer.context.ids.length === 1);
  const second = await askFreeQuestion(todayOnly, dry, 'e ieri?', first.answer.context);
  assert.equal(second.ok, true);
  assert.ok(second.answer.lines.some((line) => line.includes('Nessun lead nuovo ieri')), JSON.stringify(second.answer.lines));
  assert.ok(second.answer.context && second.answer.context.day === LEAD_YESTERDAY, 'empty yesterday carries context');
  assert.deepEqual(second.answer.context.ids, []);
  const third = await askFreeQuestion(todayOnly, dry, 'chi è il primo?', second.answer.context);
  assert.equal(third.ok, true);
  const text = shownText(third.answer);
  assert.ok(!text.includes('Marco Rossi'), `stale name leaked: ${text}`);
  assert.ok(third.answer.lines.some((line) => line.includes('Nessun lead')), JSON.stringify(third.answer.lines));
});

test('voce 34fd687c: moduli illeggibili portano contesto vuoto invece di tenere il giorno prima', async () => {
  const failing = stubClient({
    '/api/modules/contact/records?limit=50': new Error('forbidden'),
    '/api/modules/company/records?limit=50': new Error('forbidden'),
  });
  const outcome = await askFreeQuestion(failing, { mode: 'dry-run' }, 'quanti lead oggi?');
  assert.equal(outcome.ok, true);
  assert.ok(outcome.answer.context && outcome.answer.context.kind === 'lead-day');
  assert.deepEqual(outcome.answer.context.ids, []);
  assert.equal(outcome.answer.context.unreadable, true);
  const primo = await askFreeQuestion(failing, { mode: 'dry-run' }, 'chi è il primo?', outcome.answer.context);
  assert.ok(!shownText(primo.answer).includes('Dimmi prima'), 'a day context answers for that day');
  assert.ok(!shownText(primo.answer).includes('Nessun lead'), `unknown re-reported as zero: ${shownText(primo.answer)}`);
  assert.ok(primo.answer.lines.some((line) => line.includes('Non riesco a leggere i lead')), JSON.stringify(primo.answer.lines));
  assert.ok(primo.answer.unavailable.length > 0, 'the primo answer keeps the day unavailable notes');
});

test('voce 34fd687c: thread senza nomi non mostrano mai UUID', async () => {
  const uuid = '712e1f90-1111-2222-3333-444455556666';
  const client = stubClient({
    '/api/modules/conversation/records?limit=50': {
      items: [{ id: uuid, status: 'open', channel: 'whatsapp' }],
    },
  });
  const answer = await runSuggestion(client, 'bo04:clienti:ricontattare');
  const text = [...answer.lines, ...answer.sources.map((s) => s.label), ...answer.actions.map((a) => a.label)].join('\n');
  assert.ok(!text.includes(uuid), `UUID leaked: ${text}`);
  assert.ok(text.includes('WhatsApp') || text.includes('Conversazione'), text);
  const close = answer.actions.find((action) => action.id.startsWith('bo04:chiudi'));
  assert.ok(close && !close.label.includes(uuid) && !close.confirmLabel.includes(uuid));
});

test('voce 34fd687c: due thread senza nome sullo stesso canale hanno etichette diverse', async () => {
  const uuidA = '712e1f90-1111-2222-3333-444455556666';
  const uuidB = '823f0a01-2222-3333-4444-555566667777';
  const client = stubClient({
    '/api/modules/conversation/records?limit=50': {
      items: [
        { id: uuidA, status: 'open', channel: 'whatsapp', remoteHandle: '+393331111111', updatedAt: `${LEAD_TODAY}T10:00:00` },
        { id: uuidB, status: 'open', channel: 'whatsapp', remoteHandle: '+393332222222', updatedAt: `${LEAD_TODAY}T09:00:00` },
      ],
    },
  });
  const answer = await runSuggestion(client, 'bo04:clienti:ricontattare');
  const text = shownText(answer);
  assert.ok(!text.includes(uuidA) && !text.includes(uuidB), `UUID leaked: ${text}`);
  assert.ok(!text.includes('+393331111111') && !text.includes('+393332222222'), `full handle leaked: ${text}`);
  const closeLabels = answer.actions.filter((action) => action.id.startsWith('bo04:chiudi'))
    .map((action) => `${action.label} ${action.confirmLabel ?? ''}`);
  assert.equal(answer.lines.filter((line) => line.startsWith('•')).length, 2);
  const listed = answer.lines.filter((line) => line.startsWith('•'));
  assert.notEqual(listed[0], listed[1], `identical labels: ${JSON.stringify(listed)}`);
  assert.ok(closeLabels.length === 1 && closeLabels[0].includes(answer.sources[0].label),
    `close does not name its target: ${JSON.stringify(closeLabels)} vs ${answer.sources[0].label}`);
});

test('voce 34fd687c: due thread senza handle né data restano distinguibili', async () => {
  const client = stubClient({
    '/api/modules/conversation/records?limit=50': {
      items: [
        { id: 't-primo-thread', status: 'open', channel: 'whatsapp' },
        { id: 't-secondo-thread', status: 'open', channel: 'whatsapp' },
      ],
    },
  });
  const answer = await runSuggestion(client, 'bo04:clienti:ricontattare');
  const listed = answer.lines.filter((line) => line.startsWith('•'));
  assert.equal(listed.length, 2);
  assert.notEqual(listed[0], listed[1], `identical labels: ${JSON.stringify(listed)}`);
  const text = shownText(answer);
  assert.ok(!text.includes('t-primo-thread') && !text.includes('t-secondo-thread'), `id leaked: ${text}`);
});

test('voce 34fd687c: «il primo lead» e «chi è il primo lead» nominano una persona sola', async () => {
  const client = stubClient(LEAD_CLIENT);
  const dry = { mode: 'dry-run' };
  for (const question of ['il primo lead', 'chi è il primo lead', 'chi è il primo lead di oggi?', 'chi è il primo lead di ieri?']) {
    const outcome = await askFreeQuestion(client, dry, question);
    assert.equal(outcome.ok, true, question);
    const text = shownText(outcome.answer);
    const isIeri = question.includes('ieri');
    const expected = isIeri ? 'Ada Neri' : 'Marco Rossi';
    const excluded = isIeri ? 'Marco Rossi' : 'Ada Neri';
    assert.ok(text.includes(expected), `${question}: ${JSON.stringify(outcome.answer.lines)}`);
    assert.ok(!text.includes(excluded), `${question} mixes days: ${text}`);
    assert.ok(outcome.answer.lines.some((line) => line.includes('Il primo')), `${question}: ${JSON.stringify(outcome.answer.lines)}`);
  }
});

test('voce 34fd687c: domanda non dati in dry-run resta avviso chiaro in italiano', async () => {
  const client = stubClient(LEAD_CLIENT);
  const outcome = await askFreeQuestion(client, { mode: 'dry-run' }, 'che tempo fa?');
  assert.equal(outcome.disabled, true);
  assert.equal(outcome.notice, ASSISTANT_SUGGEST_ONLY_NOTICE);
  assert.equal(await answerFreeLocal(client, 'che tempo fa?'), null);
});

test('voce 34fd687c: la barra AI risponde sui dati anche senza backend', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const panel = createAssistantPanel({ doc, mount, client: stubClient(LEAD_CLIENT), navigate: () => {}, notify: () => {} });
  await panel.open('clienti', undefined, undefined, 'quanti lead oggi?');
  for (let i = 0; i < 6; i += 1) await tick();
  assert.ok(mount.textContent.includes('Marco Rossi'), mount.textContent.slice(0, 400));
  assert.ok(!mount.textContent.includes('non ancora attive'), 'no stale notice on a data answer');
  assert.ok(!mount.textContent.includes('c-marco'), 'no raw id on screen');
});

// Giro 4 (testa 3c16b1c8): «primo» insieme a «lead» tiene la traccia del
// giorno — letture e note non leggibili viaggiano nella risposta primo.
test('voce 34fd687c: «il primo lead di oggi» tiene letture e note del giorno', async () => {
  const client = stubClient({
    '/api/modules/contact/records?limit=50': {
      items: [
        { id: 'c-marco', firstName: 'Marco', lastName: 'Rossi', email: 'marco@example.it', createdAt: atHour(LEAD_TODAY, 8) },
      ],
    },
    '/api/modules/company/records?limit=50': new Error('forbidden'),
  });
  const outcome = await askFreeQuestion(client, { mode: 'dry-run' }, 'il primo lead di oggi?');
  assert.equal(outcome.ok, true);
  const text = shownText(outcome.answer);
  assert.ok(text.includes('Marco Rossi'), `the primo names its lead: ${JSON.stringify(outcome.answer.lines)}`);
  assert.equal(outcome.answer.trace.reads.length, 2, 'both day reads are kept, not discarded');
  assert.ok(outcome.answer.unavailable.some((note) => note.includes('company')),
    `the company note survives: ${JSON.stringify(outcome.answer.unavailable)}`);
  for (const raw of ['c-marco']) {
    assert.ok(!text.includes(raw), `raw id leaked: ${text}`);
  }
});

// Giro 4 (testa 3c16b1c8): giorno illeggibile e giorno vuoto sono due stati
// diversi — mai uno zero misurato quando niente era leggibile.
test('voce 34fd687c: giorno vuoto e giorno illeggibile rispondono diverso al «primo»', async () => {
  const failing = stubClient({
    '/api/modules/contact/records?limit=50': new Error('forbidden'),
    '/api/modules/company/records?limit=50': new Error('forbidden'),
  });
  const unreadable = await askFreeQuestion(failing, { mode: 'dry-run' }, 'quanti lead oggi?');
  assert.equal(unreadable.answer.context.unreadable, true);
  const primoUnreadable = await askFreeQuestion(failing, { mode: 'dry-run' }, 'chi è il primo?', unreadable.answer.context);
  assert.ok(!shownText(primoUnreadable.answer).includes('Nessun lead'));
  assert.ok(primoUnreadable.answer.lines.some((line) => line.includes('Non riesco a leggere i lead')));
  const emptyClient = stubClient({
    '/api/modules/contact/records?limit=50': { items: [] },
    '/api/modules/company/records?limit=50': { items: [] },
  });
  const empty = await askFreeQuestion(emptyClient, { mode: 'dry-run' }, 'quanti lead oggi?');
  assert.ok(!('unreadable' in (empty.answer.context ?? {})));
  const primoEmpty = await askFreeQuestion(emptyClient, { mode: 'dry-run' }, 'chi è il primo?', empty.answer.context);
  assert.ok(primoEmpty.answer.lines.some((line) => line.includes('Nessun lead')));
  assert.ok(!shownText(primoEmpty.answer).includes('Non riesco a leggere'));
});

// Giro 4 (testa 3c16b1c8): un lead senza etichetta resta nel conteggio, con
// il riferimento mascherato o «Lead senza nome» — il totale è sempre vero.
test('voce 34fd687c: i lead senza nome contano nel totale, mai UUID', async () => {
  const client = stubClient({
    '/api/modules/contact/records?limit=50': {
      items: [
        { id: 'c-marco', firstName: 'Marco', lastName: 'Rossi', email: 'marco@example.it', createdAt: atHour(LEAD_TODAY, 8) },
        { id: 'c-senza-nome', firstName: '', lastName: '', email: '', createdAt: atHour(LEAD_TODAY, 9) },
      ],
    },
    '/api/modules/company/records?limit=50': {
      items: [{ id: 'co-senza-nome', name: '', createdAt: atHour(LEAD_TODAY, 10) }],
    },
  });
  const outcome = await askFreeQuestion(client, { mode: 'dry-run' }, 'quanti lead oggi?');
  assert.equal(outcome.ok, true);
  assert.ok(outcome.answer.lines.some((line) => line.includes('3 lead nuovi oggi')), JSON.stringify(outcome.answer.lines));
  const text = shownText(outcome.answer);
  assert.ok(text.includes('Marco Rossi'));
  assert.ok(text.includes('Lead senza nome'), `fallback label shown: ${text}`);
  for (const raw of ['c-marco', 'c-senza-nome', 'co-senza-nome']) {
    assert.ok(!text.includes(raw), `raw id leaked: ${text}`);
  }
  const listed = outcome.answer.lines.filter((line) => line.startsWith('•'));
  assert.equal(new Set(listed).size, listed.length, `duplicate labels: ${JSON.stringify(listed)}`);
  for (const source of outcome.answer.sources) {
    assert.ok(source.href.startsWith('#/customer-card/'), source.href);
  }
});

// Tabella unica (giri 2-4): ogni riga del giorno conta una volta sola, con
// un'etichetta senza id grezzi; due righe uguali restano distinguibili.
test('voce 34fd687c: tabella etichette lead — nominati, senza nome, duplicati', async () => {
  const cases = [
    {
      name: 'solo senza nome',
      items: [{ id: 'c-x1', firstName: '', lastName: '', email: '', createdAt: atHour(LEAD_TODAY, 9) }],
      headline: '1 lead nuovo oggi', mustShow: ['Lead senza nome'], mustHide: ['c-x1'],
    },
    {
      name: 'due senza nome distinguibili',
      items: [
        { id: 'c-x1', firstName: '', lastName: '', email: '', createdAt: atHour(LEAD_TODAY, 9) },
        { id: 'c-x2', firstName: '', lastName: '', email: '', createdAt: atHour(LEAD_TODAY, 10) },
      ],
      headline: '2 lead nuovi oggi', mustShow: ['Lead senza nome · 1', 'Lead senza nome · 2'], mustHide: ['c-x1', 'c-x2'],
    },
    {
      name: 'solo email come etichetta esistente',
      items: [{ id: 'c-x3', firstName: '', lastName: '', email: 'nascosto@example.it', createdAt: atHour(LEAD_TODAY, 9) }],
      headline: '1 lead nuovo oggi', mustShow: ['nascosto@example.it'], mustHide: ['c-x3'],
    },
  ];
  for (const { name, items, headline, mustShow, mustHide } of cases) {
    const client = stubClient({
      '/api/modules/contact/records?limit=50': { items },
      '/api/modules/company/records?limit=50': { items: [] },
    });
    const outcome = await askFreeQuestion(client, { mode: 'dry-run' }, 'quanti lead oggi?');
    assert.equal(outcome.ok, true, name);
    assert.ok(outcome.answer.lines.some((line) => line.includes(headline)), `${name}: ${JSON.stringify(outcome.answer.lines)}`);
    const text = shownText(outcome.answer);
    for (const shown of mustShow) assert.ok(text.includes(shown), `${name} shows ${shown}: ${text}`);
    for (const hidden of mustHide) assert.ok(!text.includes(hidden), `${name} leaks ${hidden}: ${text}`);
  }
});

// Giro 4 (testa 3c16b1c8): la finestra occupata della barra in alto non perde
// la domanda in coda — parte quando la prima finisce, anche senza risposta.
test('voce 34fd687c: la coda della barra parte dopo una domanda senza risposta', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const panel = createAssistantPanel({ doc, mount, client: stubClient(LEAD_CLIENT), navigate: () => {}, notify: () => {} });
  const first = panel.open('clienti', undefined, undefined, 'zzz qqq assente wxyz');
  await Promise.resolve();
  await Promise.resolve();
  const second = panel.open('clienti', undefined, undefined, 'quanti lead oggi?');
  assert.ok(mount.textContent.includes('Finisco la risposta in corso'), 'the second question really queued behind the first');
  await first;
  await second;
  for (let i = 0; i < 12; i += 1) await tick();
  assert.ok(!mount.textContent.includes('Finisco la risposta in corso'), 'nothing is left stranded');
  assert.ok(mount.textContent.includes('Marco Rossi'), `the queued question ran: ${mount.textContent.slice(0, 400)}`);
});

test('5a1e6d8dc42e: FONTI e «Apri:» dicono le date in italiano, mai l’ISO grezzo', async () => {
  const client = stubClient({
    '/api/modules/appointment/records?limit=50': {
      items: [{ id: 'appt-1', status: 'booked', startsAt: '2026-11-07T13:30:00.000Z', subjectLabel: 'Ada Rossi' }],
    },
  });
  const answer = await runSuggestion(client, 'bo04:calendario:slot');
  const source = answer.sources.find((item) => item.id === 'appt-1');
  assert.equal(source.label, '7 nov, 14:30 Ada Rossi', 'the source reads the Rome day and time');
  const open = answer.actions.find((action) => action.id === 'bo04:apri-primo');
  assert.equal(open.label, 'Apri: 7 nov, 14:30 Ada Rossi', 'the Apri action reads the same words');
  for (const text of [source.label, open.label]) assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(text), text);
  // Any label with an ISO instant (the server's free answer too) reads Italian.
  assert.equal(italianDates('Appuntamento 2026-11-07T13:30:00Z con Ada'), 'Appuntamento 7 nov, 14:30 con Ada');
  assert.equal(italianDates('Nota senza data'), 'Nota senza data');
});

// Voce a684ecf5 (verifica Mac 09/11 sul rilascio f88eb0f): nel pannello
// Assistente mai un id grezzo, solo il nome del cliente. Il messaggio da
// spento dice che è spento e come si accende, senza descrivere cosa
// farebbe da acceso.

function visibleTexts(answer) {
  return [
    ...(answer.lines ?? []),
    ...(answer.sources ?? []).map((source) => source.label),
    ...(answer.actions ?? []).map((action) => action.label),
    ...(answer.actions ?? []).map((action) => action.confirmLabel ?? ''),
  ].join('\n');
}

test('a684ecf5: segnali con nomi cliente, mai id grezzi', async () => {
  const client = stubClient({
    '/api/modules/behavioral-signal/records?limit=100': {
      items: [
        { id: 'sig-1', leadId: 'contact-9', signalType: 'pricing-page-visited', observedAt: '2026-10-20T07:00:00.000Z' },
        { id: 'sig-2', leadId: 'contact-9', signalType: 'demo-requested', observedAt: '2026-10-20T08:00:00.000Z' },
        { id: 'sig-3', leadId: 'contact-7', signalType: 'pricing-page-visited', observedAt: '2026-10-20T08:30:00.000Z' },
      ],
    },
    '/api/modules/contact/records?limit=50': {
      items: [
        { id: 'contact-9', firstName: 'Marco', lastName: 'Rossi' },
        { id: 'contact-7', firstName: 'Sara', lastName: 'Bianchi' },
      ],
    },
    '/api/modules/company/records?limit=50': { items: [] },
  });
  const answer = await runSuggestion(client, 'bo04:clienti:segnali');
  const visible = visibleTexts(answer);
  assert.ok(!visible.includes('contact-9'), visible);
  assert.ok(!visible.includes('contact-7'), visible);
  assert.ok(visible.includes('Marco Rossi'), visible);
  assert.ok(visible.includes('Sara Bianchi'), visible);
});

test('a684ecf5: segnali senza nome restano neutri, mai id', async () => {
  const client = stubClient({
    '/api/modules/behavioral-signal/records?limit=100': {
      items: [
        { id: 'sig-1', leadId: 'contact-sconosciuto', signalType: 'pricing-page-visited', observedAt: '2026-10-20T07:00:00.000Z' },
      ],
    },
    '/api/modules/contact/records?limit=50': { items: [] },
    '/api/modules/company/records?limit=50': { items: [] },
  });
  const answer = await runSuggestion(client, 'bo04:clienti:segnali');
  const visible = visibleTexts(answer);
  assert.ok(!visible.includes('contact-sconosciuto'), visible);
  assert.ok(visible.includes('Lead senza nome'), visible);
});

test('a684ecf5: opportunita senza nome resta neutra, mai id', async () => {
  const client = stubClient({
    '/api/opportunities': {
      items: [
        { id: 'opp-grezzo', stage: 'proposal', pipelineKey: 'b2b-sales', pipelineStage: 'proposal', valueCents: 100000, currency: 'EUR' },
      ],
    },
    '/api/schema': {
      pipelines: [{
        name: 'b2b-sales', module: 'opportunity',
        stages: [
          { key: 'proposal', type: 'open', label: 'Proposta' },
          { key: 'won', type: 'won', label: 'Vinta' },
          { key: 'lost', type: 'lost', label: 'Persa' },
        ],
      }],
    },
  });
  const answer = await runSuggestion(client, 'bo04:pipeline:chiusura');
  const visible = visibleTexts(answer);
  assert.ok(!visible.includes('opp-grezzo'), visible);
});

test('a684ecf5: messaggio senza testo resta neutro, mai id', async () => {
  const client = stubClient({
    '/api/modules/interaction-message/records?limit=100': {
      items: [
        { id: 'msg-grezzo', direction: 'inbound', channel: 'website-form', conversationId: 'conv-1' },
      ],
    },
  });
  const answer = await runSuggestion(client, 'bo04:sequenze:lead-sito');
  const visible = visibleTexts(answer);
  assert.ok(!visible.includes('msg-grezzo'), visible);
});

test('a684ecf5: problema senza titolo resta neutro, mai id', async () => {
  const client = stubClient({
    '/api/modules/conversation/records?limit=50': { items: [] },
    '/api/modules/data-quality-issue/records?limit=50': {
      items: [{ id: 'issue-grezzo', status: 'open' }],
    },
  });
  const answer = await runSuggestion(client, 'bo04:oggi:urgenti');
  const visible = visibleTexts(answer);
  assert.ok(!visible.includes('issue-grezzo'), visible);
});

test('a684ecf5: spazio non attivo dice spento e come si accende', () => {
  assert.ok(ASSISTANT_SPACE_DISABLED_NOTICE.includes('non attivo in questo spazio'));
  assert.ok(ASSISTANT_SPACE_DISABLED_NOTICE.includes('titolare'));
  assert.ok(!ASSISTANT_SPACE_DISABLED_NOTICE.includes('suggerisce'), ASSISTANT_SPACE_DISABLED_NOTICE);
});
