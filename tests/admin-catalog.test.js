import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogView, commercialBlock } from '../apps/admin/public/admin-catalog.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * Product catalog Admin (BO-F2-05): the backoffice product table renders from
 * `GET /api/catalog/products` only — sources, amounts and tier labels as
 * text, the Stripe invite from the summary, filters as query params.
 */

const SCHEMA = { commercial: { commercialContract: 1 } };

const MANUAL_TABLE = {
  products: [
    {
      productId: 'p1',
      sku: 'YOGA-10',
      name: 'Pacchetto 10 lezioni',
      description: 'Dieci ingressi.',
      category: 'pacchetti',
      source: 'manual',
      priceReadOnly: false,
      active: true,
      version: 2,
      offers: [
        {
          offerId: 'o1',
          name: 'Pacchetto 10 lezioni',
          active: true,
          currency: 'EUR',
          quoteEligible: true,
          unsupportedReason: null,
          components: [
            {
              label: 'Prezzo del pacchetto',
              chargeType: 'one_time',
              pricingModel: 'flat_fee',
              interval: null,
              intervalCount: null,
              unitAmountCents: null,
              flatAmountCents: 9900,
              externalPriceId: null,
              sourcePricingModel: 'manual:flat_fee',
              tiers: [],
            },
          ],
        },
      ],
    },
  ],
  summary: { manual: 1, byProvider: {}, stripeConnected: false },
};

const STRIPE_TABLE = {
  products: [
    {
      productId: 'p2',
      sku: 'YOGA',
      name: 'Corso Yoga',
      description: 'Abbonamento.',
      category: 'corsi',
      source: 'stripe-test',
      priceReadOnly: true,
      active: true,
      version: 1,
      offers: [
        {
          offerId: 'o2',
          name: 'Corso Yoga — Canone mensile',
          active: true,
          currency: 'EUR',
          quoteEligible: true,
          unsupportedReason: null,
          components: [
            {
              label: 'Canone mensile',
              chargeType: 'recurring',
              pricingModel: 'per_unit',
              interval: 'month',
              intervalCount: 1,
              unitAmountCents: 4900,
              flatAmountCents: null,
              externalPriceId: 'price_yoga_mese',
              sourcePricingModel: 'stripe:recurring.per_unit',
              tiers: [],
            },
          ],
        },
        {
          offerId: 'o3',
          name: 'Corso Yoga — Pacchetto 10 lezioni',
          active: true,
          currency: 'EUR',
          quoteEligible: true,
          unsupportedReason: null,
          components: [
            {
              label: 'Pacchetto 10 lezioni',
              chargeType: 'one_time',
              pricingModel: 'volume',
              interval: null,
              intervalCount: null,
              unitAmountCents: null,
              flatAmountCents: null,
              externalPriceId: 'price_pilates_pacchetto',
              sourcePricingModel: 'stripe:one_time.volume',
              tiers: [
                { upTo: 10, unitAmountCents: 1200, flatAmountCents: null },
                { upTo: null, unitAmountCents: 1000, flatAmountCents: null },
              ],
            },
          ],
        },
      ],
    },
  ],
  summary: { manual: 0, byProvider: { 'stripe-test': 1 }, stripeConnected: true },
};

function stubClient({ schema = SCHEMA, tables = { '': MANUAL_TABLE }, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET' });
      if (fail && path.startsWith('/api/catalog/products')) {
        throw Object.assign(new Error(fail.message), fail);
      }
      if (path === '/api/schema') return schema;
      if (path.startsWith('/api/catalog/products')) {
        const query = path.includes('?') ? path.slice(path.indexOf('?') + 1) : '';
        return tables[query] ?? tables[''] ?? { products: [], summary: {} };
      }
      throw new Error(`unexpected request ${path}`);
    },
  };
}

test('the table renders products with amounts, and the Stripe invite when no source is connected', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCatalogView({ doc, mount, client });
  await view.renderTable({});

  const text = mount.textContent;
  assert.ok(text.includes('Catalogo prodotti'), 'the screen names itself');
  assert.ok(text.includes('Pacchetto 10 lezioni'), 'the product renders');
  assert.ok(text.includes('Fonte: manual'), 'the source renders');
  assert.ok(text.includes('EUR 99.00'), 'the server amount renders');
  assert.ok(text.includes('Stripe non è collegato'), 'the connect-Stripe invite renders when no source is connected');
  assert.ok(!text.includes('sola lettura'), 'manual rows carry no read-only note');
});

test('provider rows render read-only with tier labels and no invite once Stripe is connected', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ tables: { '': STRIPE_TABLE } });
  const view = createCatalogView({ doc, mount, client });
  await view.renderTable({});

  const text = mount.textContent;
  assert.ok(!text.includes('Stripe non è collegato'), 'no invite once a Stripe source is connected');
  assert.ok(text.includes('sola lettura'), 'provider rows say prices are read-only');
  assert.ok(text.includes('EUR 49.00 / month'), 'the recurring amount renders with its interval');
  assert.ok(text.includes('fino a 10: EUR 12.00'), 'quantity tier labels render');
  assert.ok(text.includes('oltre: EUR 10.00'), 'the open-ended tier renders');
  assert.equal(mount.findAll('input').length, 2, 'the only fields are the filters — prices are text, never inputs');
  assert.equal(mount.findAll('select').length, 1, 'the active filter is a bounded select');
});

test('filters travel as query params and hostile values stay text', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const hostile = '<script>alert(1)</script>';
  const client = stubClient({ tables: { '': { products: [], summary: { manual: 0, byProvider: {}, stripeConnected: true } } } });
  const view = createCatalogView({ doc, mount, client });
  await view.renderTable({ category: hostile, active: 'true', source: 'manual' });

  const requested = client.calls.map((call) => call.path).find((path) => path.startsWith('/api/catalog/products'));
  const query = new URL(requested, 'http://admin.test');
  assert.equal(query.searchParams.get('category'), hostile, 'category round-trips through the query');
  assert.equal(query.searchParams.get('active'), 'true', 'active travels');
  assert.equal(query.searchParams.get('source'), 'manual', 'source travels');
  // The hostile category round-trips through the filter input's value, not
  // through markup: with the fake DOM every value is text by construction,
  // and no script element is ever created.
  assert.equal(mount.findAll('script').length, 0, 'no script element is created');
  const categoryInput = mount.findAll('input').find((node) => node.getAttribute('name') === 'category');
  assert.equal(categoryInput.value, hostile, 'the hostile value sits in the field value, never in markup');
});

test('an unavailable catalog says so instead of a blank screen', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCatalogView({ doc, mount, client: stubClient({ schema: {} }) });
  await view.renderTable({});
  assert.ok(mount.textContent.includes('non è attivo'), 'missing commercial block is an honest note');

  const failing = createMount();
  const failingView = createCatalogView({
    doc,
    mount: failing,
    client: stubClient({ fail: { message: 'boom', status: 500 } }),
  });
  await failingView.renderTable({});
  assert.ok(failing.textContent.includes('non leggibile'), 'a failed read is visible with the cause');
});

test('the nav gate reads the same domains block the view gates on', () => {
  // The server publishes commercial only under domains.commercial (the
  // ambient top-level block is gone): the shell nav and the view must agree,
  // or the Catalogo link never appears while the table would render.
  assert.equal(commercialBlock({ domains: { commercial: { commercialContract: 1 } } })?.commercialContract, 1);
  assert.equal(commercialBlock({ commercial: { commercialContract: 1 } })?.commercialContract, 1);
  assert.equal(commercialBlock({}), undefined);
  assert.equal(commercialBlock(null), undefined);
});
