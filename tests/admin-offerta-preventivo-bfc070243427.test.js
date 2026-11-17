import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOfferDetail } from '../apps/admin/public/admin-offer.js';
import { createQuoteView } from '../apps/admin/public/admin-quotes.js';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import { shellScreenFor } from '../apps/admin/public/admin-shell.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:bfc070243427 — offer/quote page follow-up: no empty fields, the
 * sidebar stays highlighted on the preventivo, the two top links never
 * touch. Only the points that do not collide with other items' locked
 * contracts are covered here (the duplicate «Apri il preventivo», the raw
 * policy tag in the history and the «progetto» wording stay as the existing
 * tests lock them — see the item's report).
 */

const SCHEMA = {
  pipelines: [{
    pipelineContract: 1,
    name: 'b2b-sales',
    label: 'B2B Sales',
    module: 'opportunity',
    defaultStage: 'discovery',
    stages: [
      { key: 'discovery', label: 'Scoperta', order: 10, type: 'open', probability: 10 },
    ],
  }],
};

function stubClient(record) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return SCHEMA;
      if (/^\/api\/opportunities\/[^/?]+$/.test(path)) return { ...record };
      if (path.startsWith('/api/audit')) return { items: [] };
      return { items: [] };
    },
  };
}

const flushAll = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('bfc070243427: an offer without a close date paints no «Chiusura prevista» row', async () => {
  const record = {
    id: 'off1',
    name: 'Cucina per Giulia',
    contactName: 'Giulia Verdi',
    companyName: null,
    pipelineKey: 'b2b-sales',
    pipelineStage: 'discovery',
    valueCents: 2750000,
    currency: 'EUR',
    expectedCloseDate: null,
    createdAt: '2026-10-02T09:15:00.000Z',
    updatedAt: '2026-10-28T18:40:00.000Z',
    owner: 'maria',
  };
  const mount = createMount();
  await createOfferDetail({ doc: createFakeDocument(), mount, client: stubClient(record) }).renderOfferDetail('off1');
  await flushAll();
  const text = mount.textContent;
  assert.ok(!text.includes('Chiusura prevista'), 'no empty close-date field is shown');
  assert.ok(!text.includes('chiusura prevista —'), 'no empty hero note either');
  assert.ok(text.includes('27.500 €'), 'the value still paints');
});

test('bfc070243427: the sidebar highlights Pipeline on the preventivo, like on the offer', () => {
  assert.deepEqual(shellScreenFor({ view: 'quote-detail' }), { id: 'pipeline', label: 'Preventivo' });
  assert.deepEqual(shellScreenFor({ view: 'offer-detail' }), { id: 'pipeline', label: 'Offerta' });
});

test('bfc070243427: the two top quote links are separated by the stylesheet', () => {
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.quote-back + .quote-offer-link'), 'an adjacent-sibling gap keeps «← cliente» and «Apri l’offerta» apart');
});

const OCCASION_QUOTE = (overrides = {}) => ({
  id: 'q1',
  opportunityId: 'off1',
  priceBookId: 'pb1',
  currency: 'EUR',
  status: 'draft',
  totalsJson: JSON.stringify({
    oneTimeTotal: { currency: 'EUR', listAmountCents: 500000, discountAmountCents: 0, netAmountCents: 500000 },
    recurringTotals: [],
  }),
  ...overrides,
});

/** backlog:bfc070243427 — the stub behind the repro tests: one offer, its quotes, readable books. */
function reproClient({ record, quotes = [], audit = [] } = {}) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      // The pilot composes the commercial block: the head carries the quote
      // actions, like on the live page the Mac checked.
      if (path === '/api/schema') return { ...SCHEMA, commercial: {} };
      if (/^\/api\/opportunities\/[^/?]+$/.test(path)) return { ...record };
      if (path.startsWith('/api/modules/quote/records')) return { items: quotes };
      if (path.startsWith('/api/modules/quote-line/records')) return { items: [] };
      if (path.startsWith('/api/modules/quote-version/records')) return { items: [] };
      if (path.startsWith('/api/modules/price-book/records')) {
        return { items: [{ id: 'pb1', name: 'Listino', currency: 'EUR', active: true }] };
      }
      if (path.startsWith('/api/audit')) return { items: audit };
      if (path === '/api/spine/memberships') return { items: [] };
      return { items: [] };
    },
  };
}

const countOccurrences = (text, needle) => String(text ?? '').split(needle).length - 1;

/**
 * backlog:bfc070243427 VERIFIER_BACK 2026-11-17 (returns:1): the Mac saw
 * «Apri il preventivo» twice on one offer (the head action and the quote
 * card link). One quote already open means one action: the card of that
 * quote drops its own link. RED before the cure (2), GREEN after (1).
 */
test('bfc070243427 repro: a single-quote offer paints one «Apri il preventivo» action', async () => {
  const record = {
    id: 'off1', name: 'Cucina per Giulia', contactName: 'Giulia Verdi', companyName: null,
    pipelineKey: 'b2b-sales', pipelineStage: 'discovery', valueCents: 2750000, currency: 'EUR',
    expectedCloseDate: null, createdAt: '2026-10-02T09:15:00.000Z', updatedAt: '2026-10-28T18:40:00.000Z', owner: 'maria',
  };
  const mount = createMount();
  await createOfferDetail({ doc: createFakeDocument(), mount, client: reproClient({ record, quotes: [OCCASION_QUOTE()] }) }).renderOfferDetail('off1');
  await flushAll();
  assert.equal(countOccurrences(mount.textContent, 'Apri il preventivo'), 1, 'one quote on the page, one open action');
  const open = mount.findAll('a').find((node) => node.getAttribute('data-action') === 'offer-open-quote');
  assert.ok(open, 'the head keeps the main open action');
  assert.equal(open.getAttribute('href'), '#/quotes/q1', 'it opens the quote');
});

/**
 * backlog:bfc070243427 VERIFIER_BACK 2026-11-17: from the quotes list the top
 * link went to the customer scheda instead of back to the list. The list
 * route names the origin (`#/quotes/<id>/lista`, like the offer page names
 * its scheda origin). RED before the cure (invalid route), GREEN after.
 */
test('bfc070243427 repro: #/quotes/<id>/lista routes to the detail with the list as origin', () => {
  assert.deepEqual(
    parseModuleRoute('#/quotes/q1/lista'),
    { view: 'quote-detail', quoteId: 'q1', from: 'quotes' },
    'the list origin rides the route',
  );
  assert.deepEqual(
    parseModuleRoute('#/quotes/q1'),
    { view: 'quote-detail', quoteId: 'q1' },
    'a direct link keeps no origin',
  );
});

test('bfc070243427 repro: from the list the top link goes back to the list, not the customer', async () => {
  const record = OCCASION_QUOTE();
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return { commercial: {} };
      if (path.startsWith('/api/modules/quote/records/')) return { ...record };
      if (path.startsWith('/api/modules/quote/records')) return { items: [record] };
      if (path === '/api/opportunities/opp1') {
        return { id: 'opp1', name: 'Pacchetto 10 PT', contactName: 'Giulia Verdi', contactId: 'c1' };
      }
      if (path.startsWith('/api/opportunities')) return { items: [] };
      if (path.startsWith('/api/modules/quote-line/records')) return { items: [] };
      if (path.startsWith('/api/modules/offer/records')) return { items: [] };
      if (path.startsWith('/api/modules/quote-version/records')) return { items: [] };
      return { items: [] };
    },
  };
  const mount = createMount();
  await createQuoteView({ doc: createFakeDocument(), mount, client }).renderQuoteDetail('q1', { from: 'quotes' });
  await flushAll();
  const back = mount.findAll('a').find((node) => (node.getAttribute('class') ?? '') === 'quote-back');
  assert.ok(back, 'a way back is painted');
  assert.equal(back.getAttribute('href'), '#/quotes', 'it goes back to the list it came from');
  assert.equal(back.textContent, '← Preventivi', 'it says the list, never the customer');
});

test('bfc070243427: inactive commercial functions speak plain words without «progetto»', () => {
  const src = readFileSync(new URL('../apps/admin/public/admin-quotes.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('non è attiva in questo progetto'), 'no «progetto» in inactive messages');
  assert.ok(src.includes('La parte commerciale non è attiva qui.'), 'commercial off message is plain');
  assert.ok(src.includes('La firma non è attiva qui.'), 'signature off message is plain');
});

/**
 * backlog:bfc070243427 VERIFIER_BACK 2026-11-17 (AC-1): the Mac saw
 * «CREATA DA —». An author the reads cannot name paints no row — like the
 * dateless «Chiusura prevista» — never an empty field. RED before (the row
 * paints «—»), GREEN after (no row). What the cure does not cover: naming
 * an existing-but-unresolved author stays with backlog:a2ea75f705fd and the
 * person-identifier family (backlog:91f4e2f0d650); once they name them, the
 * row paints again.
 */
test('bfc070243427 repro: an unknown author paints no «Creata da» row, never «—»', async () => {
  const record = {
    id: 'off1', name: 'Cucina per Giulia', contactName: 'Giulia Verdi', companyName: null,
    pipelineKey: 'b2b-sales', pipelineStage: 'discovery', valueCents: 2750000, currency: 'EUR',
    expectedCloseDate: '2026-11-20', createdAt: '2026-10-02T09:15:00.000Z', updatedAt: '2026-10-28T18:40:00.000Z', owner: 'maria',
  };
  const mount = createMount();
  await createOfferDetail({ doc: createFakeDocument(), mount, client: reproClient({ record, quotes: [], audit: [] }) }).renderOfferDetail('off1');
  await flushAll();
  assert.ok(!mount.textContent.includes('Creata da'), 'no empty author field');
  assert.ok(mount.textContent.includes('Creata il'), 'the dated facts stay');
});

test('bfc070243427: the skeleton with a dateless offer skips «Chiusura prevista» instead of a vanishing bar', async () => {
  const record = {
    id: 'off1',
    name: 'Cucina per Giulia',
    contactName: 'Giulia Verdi',
    companyName: null,
    pipelineKey: 'b2b-sales',
    pipelineStage: 'discovery',
    valueCents: 2750000,
    currency: 'EUR',
    expectedCloseDate: null,
    createdAt: '2026-10-02T09:15:00.000Z',
    updatedAt: '2026-10-28T18:40:00.000Z',
    owner: 'maria',
  };
  const held = [];
  let releaseHeld = () => {};
  const gate = new Promise((resolve) => { releaseHeld = resolve; });
  const base = stubClient(record);
  const client = {
    request(path, options = {}) {
      if (path === '/api/schema' || path === '/api/spine/memberships' || path.startsWith('/api/modules/price-book/records')) {
        held.push(path);
        return gate.then(() => base.request(path, options));
      }
      return base.request(path, options);
    },
  };
  const mount = createMount();
  const view = createOfferDetail({ doc: createFakeDocument(), mount, client });
  const done = view.renderOfferDetail('off1');
  await flushAll(12);
  const skeleton = mount.findAll('div').find((node) => node.getAttribute('data-offer-skeleton') === 'true');
  assert.ok(skeleton, 'the second skeleton (offer read, rest in flight) is on screen');
  assert.ok(mount.textContent.includes('Cucina per Giulia'), 'the headline is already read');
  assert.ok(!mount.textContent.includes('Chiusura prevista'), 'no close-date row while the date is known to be missing');
  releaseHeld();
  await done;
  await flushAll();
  assert.ok(!mount.textContent.includes('Chiusura prevista'), 'the final paint has no close-date row either');
});
