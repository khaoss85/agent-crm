import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfferDetail } from '../apps/admin/public/admin-offer.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:ea616e16ebac — the offer page showed «Apri il preventivo» twice
 * for the same quote: once as the main action in the quotes head, once as
 * a plain link in the quote card. One visible action per quote.
 */

const SCHEMA = {
  commercial: {},
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

function offerRecord() {
  return {
    id: 'off1',
    name: 'Cucina per Giulia',
    contactName: 'Giulia Verdi',
    companyName: null,
    pipelineKey: 'b2b-sales',
    pipelineStage: 'discovery',
    valueCents: 2750000,
    currency: 'EUR',
    expectedCloseDate: '2026-11-20',
    createdAt: '2026-10-02T09:15:00.000Z',
    updatedAt: '2026-10-28T18:40:00.000Z',
    owner: 'maria',
  };
}

function quoteRow(id, createdAt) {
  return {
    id,
    opportunityId: 'off1',
    priceBookId: 'pb1',
    currency: 'EUR',
    status: 'draft',
    createdAt,
    totalsJson: JSON.stringify({
      oneTimeTotal: { currency: 'EUR', listAmountCents: 500000, discountAmountCents: 0, netAmountCents: 500000 },
      recurringTotals: [],
    }),
  };
}

function stubClient({ schema = SCHEMA, quotes = [], books = [{ id: 'pb1', name: 'Listino', currency: 'EUR', active: true }] } = {}) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return schema;
      if (/^\/api\/opportunities\/[^/?]+$/.test(path)) return { ...offerRecord() };
      if (path.startsWith('/api/modules/price-book/records')) return { items: books };
      if (path.startsWith('/api/modules/quote/records')) {
        const params = new URLSearchParams(path.includes('?') ? path.slice(path.indexOf('?') + 1) : '');
        const field = [...params.keys()].find((key) => key.startsWith('filter.'));
        const value = field ? params.get(field) : null;
        const key = field ? field.slice('filter.'.length) : null;
        return { items: key ? quotes.filter((row) => String(row[key] ?? '') === value) : quotes };
      }
      if (path.startsWith('/api/audit')) return { items: [] };
      return { items: [] };
    },
  };
}

const flushAll = async (rounds = 10) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const countOpen = (mount) => mount.textContent.split('Apri il preventivo').length - 1;

test('ea616e16ebac: a single quote is opened by one visible action only', async () => {
  const mount = createMount();
  const view = createOfferDetail({ doc: createFakeDocument(), mount, client: stubClient({ quotes: [quoteRow('q1', '2026-11-01T00:00:00.000Z')] }) });
  await view.renderOfferDetail('off1');
  await flushAll();
  assert.equal(countOpen(mount), 1, '«Apri il preventivo» paints exactly once');
  const open = mount.findAll('a').find((node) => node.textContent === 'Apri il preventivo');
  assert.ok(open, 'the single action is there');
  assert.equal(open.getAttribute('href'), '#/quotes/q1', 'it opens the quote');
  assert.equal(open.getAttribute('data-action'), 'offer-open-quote', 'it stays the main action');
});

test('ea616e16ebac: with two quotes every quote stays reachable exactly once', async () => {
  const mount = createMount();
  const view = createOfferDetail({
    doc: createFakeDocument(),
    mount,
    client: stubClient({ quotes: [quoteRow('q-old', '2026-11-01T00:00:00.000Z'), quoteRow('q-new', '2026-11-10T00:00:00.000Z')] }),
  });
  await view.renderOfferDetail('off1');
  await flushAll();
  assert.equal(countOpen(mount), 2, 'one action per quote, never two for the same one');
  const main = mount.findAll('a').find((node) => node.getAttribute('data-action') === 'offer-open-quote');
  assert.equal(main?.getAttribute('href'), '#/quotes/q-new', 'the main action opens the newest quote');
  const older = mount.findAll('a').find((node) => node.getAttribute('href') === '#/quotes/q-old');
  assert.equal(older?.textContent, 'Apri il preventivo', 'the older quote keeps its own link');
  assert.equal(
    mount.findAll('a').filter((node) => node.getAttribute('href') === '#/quotes/q-new').length,
    1,
    'the newest quote is linked once',
  );
});

test('review-992-P2: the newest quote stays reachable while the price books are slow', async () => {
  let releaseBooks;
  const booksGate = new Promise((resolve) => { releaseBooks = resolve; });
  const client = stubClient({ quotes: [quoteRow('q-new', '2026-11-10T00:00:00.000Z')] });
  const slow = {
    request(path, options = {}) {
      if (path.startsWith('/api/modules/price-book/records')) return booksGate.then(() => ({ items: [{ id: 'pb1', name: 'Listino', currency: 'EUR', active: true }] }));
      return client.request(path, options);
    },
  };
  const mount = createMount();
  const view = createOfferDetail({ doc: createFakeDocument(), mount, client: slow });
  const rendering = view.renderOfferDetail('off1');
  await flushAll(25);
  assert.equal(countOpen(mount), 1, 'one «Apri il preventivo» before the books land');
  const early = mount.findAll('a').find((node) => node.getAttribute('href') === '#/quotes/q-new');
  assert.equal(early?.textContent, 'Apri il preventivo', 'the newest quote is already openable');
  releaseBooks();
  await rendering;
  await flushAll();
  assert.equal(countOpen(mount), 1, 'still one «Apri il preventivo» after the books land');
  assert.equal(
    mount.findAll('a').filter((node) => node.getAttribute('href') === '#/quotes/q-new').length,
    1,
    'the newest quote is linked once',
  );
});

test('ea616e16ebac: without the commercial block the card keeps its link', async () => {
  const { commercial, ...schemaWithoutCommercial } = SCHEMA;
  void commercial;
  const mount = createMount();
  const view = createOfferDetail({
    doc: createFakeDocument(),
    mount,
    client: stubClient({ schema: schemaWithoutCommercial, quotes: [quoteRow('q1', '2026-11-01T00:00:00.000Z')] }),
  });
  await view.renderOfferDetail('off1');
  await flushAll();
  const open = mount.findAll('a').find((node) => node.getAttribute('href') === '#/quotes/q1');
  assert.ok(open, 'the quote stays reachable when the head paints no action');
  assert.equal(open.textContent, 'Apri il preventivo', 'the link says where it goes');
});
