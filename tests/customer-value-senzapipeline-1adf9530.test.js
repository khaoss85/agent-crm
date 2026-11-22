import test from 'node:test';
import assert from 'node:assert/strict';
import { listCustomerRecords } from '../packages/customer-data/src/operations.js';
import { isOpenOfferRow } from '../packages/core/src/pipeline-registry.js';
import { createPipelineBoard } from '../apps/admin/public/admin-pipeline.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:1adf95307b31 (seguito 20/11, ANSWER supervisore 10:4xZ) —
 * VERIFIER_BACK repro: un'offerta aperta da 15 € SENZA pipeline conta in
 * Clienti ma la testata Pipeline la scartava («N offerte di altre
 * pipeline»). La cura: UNA sola regola per il valore (isOpenOfferRow),
 * usata da Clienti e testata, con lo stesso ripiego canonico. Reporting
 * resta fuori (remaining): le sue letture storage sono filtrate per
 * pipelineKey e le righe non portano lo stadio canonico.
 */

const SALES_LIKE = {
  name: 'accordo-sales',
  module: 'opportunity',
  defaultStage: 'richiesta-info',
  stages: [
    { key: 'richiesta-info', type: 'open', order: 10 },
    { key: 'prova', type: 'open', order: 20 },
    { key: 'proposta', type: 'open', order: 30 },
    { key: 'pagato', type: 'paid', order: 40 },
    { key: 'perso', type: 'lost', order: 50 },
  ],
};

const BOARD_PIPELINE = {
  pipelineContract: 1,
  name: 'b2b-sales',
  label: 'B2B Sales',
  module: 'opportunity',
  defaultStage: 'discovery',
  stages: [
    { key: 'discovery', label: 'Discovery', order: 10, type: 'open', probability: 10 },
    { key: 'demo', label: 'Demo', order: 20, type: 'open', probability: 30 },
    { key: 'won', label: 'Won', order: 50, type: 'won', probability: 100 },
    { key: 'lost', label: 'Lost', order: 60, type: 'lost', probability: 0 },
  ],
};

const matchShape = (rows, filters) => rows.filter((row) => Object.entries(filters ?? {}).every(([field, value]) => {
  if (Array.isArray(value)) return value.includes(row[field]);
  return row[field] === value;
}));

function fakeModules({ contacts, companies, opportunities = [] }) {
  return {
    get: (name) => {
      if (name === 'contact') return { service: { list: async () => contacts } };
      if (name === 'company') return { service: { list: async () => companies } };
      if (name === 'opportunity') {
        return {
          service: {
            listWhere: async (filters) => matchShape(opportunities, filters),
            createManaged: async () => { throw new Error('the list writes nothing'); },
          },
        };
      }
      throw Object.assign(new Error(`Unknown module ${name}`), { code: 'MODULE_NOT_FOUND' });
    },
  };
}

function stubBoard(records) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return { pipelineContract: 1, pipelines: [BOARD_PIPELINE] };
      if (options.method === 'POST') return { ok: true };
      return { items: records };
    },
  };
}

test('backlog:1adf95307b31: un\u2019offerta aperta senza pipeline conta uguale in Clienti e testata', async () => {
  // La prova del Mac sul live: un'offerta aperta da 15 € senza pipeline.
  const contacts = [
    { id: 'c1', companyId: 'co1', firstName: 'Ada', lastName: 'Rossi', email: 'ada@palestra-uno.example' },
  ];
  const companies = [{ id: 'co1', name: 'Palestra Uno', domain: 'palestra-uno.example' }];
  const offer = {
    id: 'op-15', companyId: 'co1', contactId: 'c1', valueCents: 1500, currency: 'EUR',
    stage: 'proposal',
  };
  const modules = fakeModules({ contacts, companies, opportunities: [offer] });
  const page = await listCustomerRecords(
    {
      modules,
      core: {},
      names: { identity: 'external-identity' },
      pipelines: { forModule: (name) => (name === 'opportunity' ? SALES_LIKE : null) },
    },
    { vista: 'tutti', sort: 'name', pageSize: '10' },
  );
  const ada = page.items.find((item) => item.id === 'c1');
  assert.equal(ada.offerValueCents, 1500, 'Clienti: la 15 € senza pipeline conta');
  assert.equal(ada.offerCurrency, 'EUR');

  const boardRecord = {
    id: 'op-15', name: 'Offerta 15', companyName: 'Palestra Uno',
    valueCents: 1500, currency: 'EUR', stage: 'proposal',
    pipelineKey: null, pipelineStage: null,
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubBoard([boardRecord]) });
  await board.renderBoard('b2b-sales');
  const summary = mount.findAll('p').find((node) => node.getAttribute('data-summary') !== null).textContent;
  assert.match(summary, /0 offerte/, 'il conteggio nomina ancora solo le card mostrate');
  assert.ok(summary.includes('15 €'), `la testata somma la 15 € senza pipeline: ${summary}`);
});

test('backlog:1adf95307b31: solo vinte «—», valute miste con unità in Clienti e testata', async () => {
  // Accettazione madre: solo offerte vinte o nessuna aperta → «—», mai
  // «0 €»; valute miste → ogni importo con la sua valuta, mai un numero
  // nudo. Vale anche senza pipeline, in entrambe le viste.
  const contacts = [
    { id: 'c1', companyId: 'co1', firstName: 'Ada', lastName: 'Rossi', email: 'ada@palestra-uno.example' },
    { id: 'c2', companyId: 'co2', firstName: 'Leo', lastName: 'Verdi', email: 'leo@palestra-due.example' },
  ];
  const companies = [
    { id: 'co1', name: 'Palestra Uno', domain: 'palestra-uno.example' },
    { id: 'co2', name: 'Palestra Due', domain: 'palestra-due.example' },
  ];
  const opportunities = [
    { id: 'op-won', companyId: 'co1', contactId: 'c1', valueCents: 2000, currency: 'EUR', stage: 'won' },
    { id: 'op-eur', companyId: 'co2', contactId: 'c2', valueCents: 1500, currency: 'EUR', stage: 'proposal' },
    { id: 'op-usd', companyId: 'co2', contactId: 'c2', valueCents: 2000, currency: 'USD', stage: 'proposal' },
  ];
  const modules = fakeModules({ contacts, companies, opportunities });
  const page = await listCustomerRecords(
    {
      modules,
      core: {},
      names: { identity: 'external-identity' },
      pipelines: { forModule: (name) => (name === 'opportunity' ? SALES_LIKE : null) },
    },
    { vista: 'tutti', sort: 'name', pageSize: '10' },
  );
  const ada = page.items.find((item) => item.id === 'c1');
  assert.equal(ada.offerValueCents, null, 'Clienti: solo vinte → nessun valore, la cella legge «—»');
  assert.equal(ada.offerCurrency, null);
  assert.equal(ada.offerParts, null);
  const leo = page.items.find((item) => item.id === 'c2');
  assert.equal(leo.offerCurrency, null, 'Clienti: valute miste → nessuna valuta singola');
  assert.deepEqual(
    [...leo.offerParts].sort((a, b) => String(a.currency).localeCompare(String(b.currency))),
    [{ valueCents: 1500, currency: 'EUR' }, { valueCents: 2000, currency: 'USD' }],
    'Clienti: ogni subtotale con il suo codice, mai un numero nudo',
  );

  const boardRecords = [
    { id: 'op-eur', name: 'Offerta EUR', companyName: 'Palestra Due', valueCents: 1500, currency: 'EUR', stage: 'proposal', pipelineKey: null, pipelineStage: null },
    { id: 'op-usd', name: 'Offerta USD', companyName: 'Palestra Due', valueCents: 2000, currency: 'USD', stage: 'proposal', pipelineKey: null, pipelineStage: null },
  ];
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubBoard(boardRecords) });
  await board.renderBoard('b2b-sales');
  const summary = mount.findAll('p').find((node) => node.getAttribute('data-summary') !== null).textContent;
  assert.ok(summary.includes('15 €'), `la testata mostra gli euro con unità: ${summary}`);
  assert.ok(summary.includes('20 USD'), `la testata mostra i dollari con unità: ${summary}`);
});

test('backlog:1adf95307b31: la regola riga decide uguale ovunque', () => {
  // La stessa riga, lo stesso esito in ogni vista che la legge.
  assert.equal(isOpenOfferRow(SALES_LIKE, { pipelineKey: 'accordo-sales', pipelineStage: 'proposta', stage: 'qualification' }), true, 'sulla pipeline: il tipo open tiene il valore');
  assert.equal(isOpenOfferRow(SALES_LIKE, { pipelineKey: 'accordo-sales', pipelineStage: 'pagato', stage: 'qualification' }), false, 'sulla pipeline: Pagato e vinta, nessun valore aperto');
  assert.equal(isOpenOfferRow(SALES_LIKE, { pipelineKey: 'other', pipelineStage: 'pagato', stage: 'qualification' }), true, 'altra pipeline: decide lo stadio canonico aperto');
  assert.equal(isOpenOfferRow(SALES_LIKE, { stage: 'proposal' }), true, 'senza chiave: decide lo stadio canonico aperto');
  assert.equal(isOpenOfferRow(SALES_LIKE, { pipelineKey: 'accordo-sales', pipelineStage: 'vecchio-stadio', stage: 'proposal' }), true, 'stadio fuori definizione: decide lo stadio canonico aperto');
  assert.equal(isOpenOfferRow(SALES_LIKE, { stage: 'won' }), false, 'senza chiave ma vinta: nessun valore aperto');
  assert.equal(isOpenOfferRow(SALES_LIKE, {}), false, 'senza stadio: chiuso, mai aperto');
  assert.equal(isOpenOfferRow(SALES_LIKE, null), false, 'riga nulla: chiusa, mai aperta');
});
