import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogView, commercialBlock, bpsLabel, parseEuroToCents } from '../apps/admin/public/admin-catalog.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * Product catalog Admin (BO-F2-05): the backoffice product table renders from
 * `GET /api/catalog/products` only — sources, amounts and tier labels as
 * text, the Stripe invite from the summary, filters as query params.
 */

const SCHEMA = { commercial: { commercialContract: 1 } };

const RULES_SCHEMA = {
  commercial: {
    commercialContract: 1,
    discountPolicies: [
      {
        name: 'catalog-price-rules',
        version: 1,
        label: 'Catalog price rules (BO-F2-04)',
        fingerprint: 'abc123',
        config: { autoApproveMaxBps: 1000, ownerApprovalMaxBps: 3000, approvalKey: 'owner' },
      },
    ],
  },
};

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
              key: 'prezzo-pacchetto',
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
      const method = String(options.method ?? 'GET').toUpperCase();
      let body = options.body;
      if (typeof body === 'string' && body !== '') {
        try { body = JSON.parse(body); } catch { /* fingerprint the raw string */ }
      }
      calls.push({ path, method, body });
      if (fail && path.startsWith('/api/catalog/products')) {
        throw Object.assign(new Error(fail.message), fail);
      }
      if (path === '/api/schema') return schema;
      if (path.startsWith('/api/catalog/products')) {
        if (method !== 'GET') return { ok: true };
        const query = path.includes('?') ? path.slice(path.indexOf('?') + 1) : '';
        return tables[query] ?? tables[''] ?? { products: [], summary: {} };
      }
      if (path === '/api/catalog/sync' && method === 'POST') return { ok: true, synced: 1 };
      throw new Error(`unexpected request ${method} ${path}`);
    },
  };
}

async function flush(rounds = 30) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

function clickButton(mount, text) {
  const button = mount.findAll('button').find((node) => node.textContent === text);
  assert.ok(button, `a "${text}" button renders`);
  button.dispatch('click');
  return button;
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
  assert.ok(text.includes('Manuale'), 'the source renders as a pill');
  assert.ok(text.includes('99 €'), 'the server amount renders');
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
  assert.ok(text.includes('49 € / mese'), 'the recurring amount renders with its interval');
  assert.ok(text.includes('fino a 10: 12 €'), 'quantity tier labels render');
  assert.ok(text.includes('oltre: 10 €'), 'the open-ended tier renders');
  assert.equal(mount.findAll('input').length, 3, 'the only fields are the filters and the search — prices are text, never inputs');
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

const SEARCH_TABLE = {
  products: [
    MANUAL_TABLE.products[0],
    {
      productId: 'p2',
      sku: 'CORSO-1',
      name: 'Corso serale',
      description: 'A lezione.',
      category: 'corsi',
      source: 'manual',
      priceReadOnly: false,
      active: true,
      version: 1,
      offers: [
        {
          offerId: 'o9',
          name: 'Corso serale',
          active: true,
          currency: 'EUR',
          quoteEligible: true,
          unsupportedReason: null,
          components: [
            {
              key: 'quota',
              label: 'Quota',
              chargeType: 'one_time',
              pricingModel: 'flat_fee',
              interval: null,
              intervalCount: null,
              unitAmountCents: null,
              flatAmountCents: 5000,
              externalPriceId: null,
              sourcePricingModel: 'manual:flat_fee',
              tiers: [],
            },
          ],
        },
      ],
    },
  ],
  summary: { manual: 2, byProvider: {}, stripeConnected: false },
};

function findSearch(mount) {
  return mount.findAll('input').find((node) => node.getAttribute('name') === 'search');
}

function rowCount(mount) {
  return mount.findAll('div')
    .filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('catalog-row'))
    .length;
}

test('the search field filters the loaded rows by name and code as you type', async () => {
  // BO-F6-15 acceptance (spec catalogo.md C9/C21): the field carries the
  // prototype placeholder and typing narrows the rows, with no refetch.
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ tables: { '': SEARCH_TABLE } });
  const view = createCatalogView({ doc, mount, client });
  await view.renderTable({});

  const search = findSearch(mount);
  assert.ok(search, 'the search field renders');
  assert.equal(search.getAttribute('placeholder'), 'Cerca prodotto o codice', 'the placeholder matches the prototype text');
  assert.equal(search.getAttribute('type'), 'search', 'the field reads as a search control');
  assert.equal(rowCount(mount), 2, 'both rows render before searching');
  const reads = client.calls.filter((call) => call.path.startsWith('/api/catalog/products')).length;

  search.value = 'yoga-10';
  search.dispatch('input');
  assert.equal(rowCount(mount), 1, 'the code narrows the list');
  assert.ok(mount.textContent.includes('Pacchetto 10 lezioni'), 'the matching row stays');
  assert.ok(!mount.textContent.includes('Corso serale'), 'the other row leaves');

  search.value = 'corso';
  search.dispatch('input');
  assert.equal(rowCount(mount), 1, 'the name narrows the list');
  assert.ok(mount.textContent.includes('Corso serale'), 'the matching row stays');

  search.value = '  ';
  search.dispatch('input');
  assert.equal(rowCount(mount), 2, 'blank search reads unfiltered');
  assert.equal(
    client.calls.filter((call) => call.path.startsWith('/api/catalog/products')).length,
    reads,
    'typing never refetches: the match runs over the loaded page',
  );
});

test('a search with no match is a gentle note with an action, never a blank table', async () => {
  // Spec catalogo.md C19: no table, a kind note naming the query, and a
  // working action — never a technical text.
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCatalogView({ doc, mount, client: stubClient({ tables: { '': SEARCH_TABLE } }) });
  await view.renderTable({});

  const search = findSearch(mount);
  search.value = 'zzz';
  search.dispatch('input');
  assert.equal(rowCount(mount), 0, 'no rows render');
  assert.ok(mount.textContent.includes('Nessun risultato per «zzz»'), 'the gentle note names the query');
  assert.ok(mount.textContent.includes('Prova con un altro nome o codice.'), 'the note suggests the next step');
  assert.ok(!/NOT_FOUND|non composto/i.test(mount.textContent), 'no technical text reaches the screen');

  clickButton(mount, 'Cancella ricerca');
  assert.equal(rowCount(mount), 2, 'clearing restores the rows');
  assert.equal(findSearch(mount).value, '', 'clearing empties the field');
});

test('a hostile search string stays text and matches nothing', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCatalogView({ doc, mount, client: stubClient({ tables: { '': SEARCH_TABLE } }) });
  await view.renderTable({});

  const hostile = '<script>alert(1)</script>';
  const search = findSearch(mount);
  search.value = hostile;
  search.dispatch('input');
  assert.equal(mount.findAll('script').length, 0, 'no script element is created');
  assert.equal(rowCount(mount), 0, 'the hostile query matches nothing');
  assert.ok(mount.textContent.includes('Nessun risultato per'), 'the hostile query reads as text in the gentle note');
});

test('the search text survives a chip filter change', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCatalogView({ doc, mount, client: stubClient({ tables: { '': SEARCH_TABLE } }) });
  await view.renderTable({});

  const search = findSearch(mount);
  search.value = 'corso';
  search.dispatch('input');
  assert.equal(rowCount(mount), 1, 'the search narrows first');
  const tutti = mount.findAll('button')
    .find((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('catalog-chip')
      && node.textContent.startsWith('Tutti'));
  assert.ok(tutti, 'the Tutti chip renders');
  tutti.dispatch('click');
  await flush();
  assert.equal(findSearch(mount).value, 'corso', 'the chip re-render keeps the search text');
  assert.equal(rowCount(mount), 1, 'the search still filters after the re-render');
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
  assert.ok(failing.textContent.includes('non si è potuto leggere'), 'a failed read is visible, human, without the cause');
  assert.ok(!failing.textContent.includes('boom'), 'the server message never renders');
});

test('a connected Stripe source names its provider with a confirm-gated sync', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ tables: { '': STRIPE_TABLE } });
  const view = createCatalogView({ doc, mount, client });
  await view.renderTable({});

  assert.ok(mount.textContent.includes('Collegato a Stripe'), 'the connected state renders');
  assert.ok(mount.findAll('button').some((node) => node.getAttribute?.('data-provider') === 'stripe-test'), 'the sync button carries the provider');
  clickButton(mount, 'Sincronizza');
  assert.ok(mount.textContent.includes('Sincronizzare i prodotti da Stripe?'), 'sync asks for confirmation first');
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'nothing is sent before confirmation');
  clickButton(mount, 'Conferma');
  await flush();
  const sync = client.calls.find((call) => call.path === '/api/catalog/sync');
  assert.ok(sync, 'confirmation sends the sync');
  assert.equal(sync.method, 'POST');
  assert.deepEqual(sync.body, { provider: 'stripe-test' });
});

test('the price rules section reads the live bands from the schema', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCatalogView({ doc, mount, client: stubClient({ schema: RULES_SCHEMA }) });
  await view.renderTable({});

  assert.ok(mount.textContent.includes('Regole di prezzo'), 'the rules section renders');
  assert.ok(!mount.textContent.includes('catalog-price-rules@1'), 'the policy identity is not customer text');
  assert.ok(mount.findAll('div').some((node) => node.getAttribute?.('data-policy') === 'catalog-price-rules@1'), 'the policy identity rides an attribute');
  assert.ok(mount.textContent.includes('fino al 10%'), 'the auto-approve band renders');
  assert.ok(mount.textContent.includes('fino al 30%'), 'the owner band renders');
  assert.ok(mount.textContent.includes('bloccano anche l'), 'the AI-blocking note renders');

  const bareDoc = createFakeDocument();
  const bareMount = createMount();
  const bareView = createCatalogView({ doc: bareDoc, mount: bareMount, client: stubClient() });
  await bareView.renderTable({});
  assert.ok(bareMount.textContent.includes('Nessuna regola di prezzo pubblicata'), 'no policies is an honest note, not a blank section');
});

test('manual rows edit prices through review and confirmation, provider rows never', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCatalogView({ doc, mount, client });
  await view.renderTable({});

  clickButton(mount, 'Modifica prezzi');
  const amount = mount.findAll('input').find((node) => node.getAttribute('aria-label') === 'Prezzo del pacchetto');
  assert.ok(amount, 'the manual amount renders as an editable field');
  assert.equal(amount.value, '99.00', 'the field starts from the server amount');
  amount.value = '120,50';
  clickButton(mount, 'Rivedi');
  assert.ok(mount.textContent.includes('99 € → 120,50 €'), 'the review shows old then new');
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'review sends nothing');
  clickButton(mount, 'Conferma');
  await flush();
  const prices = client.calls.find((call) => call.path === '/api/catalog/products/p1/prices');
  assert.ok(prices, 'confirmation sends the price replacement');
  assert.deepEqual(prices.body.offerIds, ['o1']);
  assert.equal(prices.body.offers.length, 1);
  assert.equal(prices.body.offers[0].components[0].key, 'prezzo-pacchetto', 'the declared component key round-trips');
  assert.equal(prices.body.offers[0].components[0].flatAmountCents, 12050, 'the comma decimal becomes cents');

  const providerDoc = createFakeDocument();
  const providerMount = createMount();
  const providerView = createCatalogView({ doc: providerDoc, mount: providerMount, client: stubClient({ tables: { '': STRIPE_TABLE } }) });
  await providerView.renderTable({});
  const labels = providerMount.findAll('button').map((node) => node.textContent);
  assert.ok(!labels.includes('Modifica prezzi'), 'provider rows offer no price edit');
  assert.ok(!labels.some((label) => label === 'Attiva' || label === 'Disattiva'), 'provider rows offer no flag toggle');
});

test('a hostile amount never leaves the form', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCatalogView({ doc, mount, client });
  await view.renderTable({});

  clickButton(mount, 'Modifica prezzi');
  const amount = mount.findAll('input').find((node) => node.getAttribute('aria-label') === 'Prezzo del pacchetto');
  amount.value = '12.345';
  clickButton(mount, 'Rivedi');
  assert.ok(mount.textContent.includes('non negativo'), 'three decimals refuse with a reason');
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'the hostile amount is never sent');
});

test('the active flag toggles only after confirmation', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCatalogView({ doc, mount, client });
  await view.renderTable({});

  clickButton(mount, 'Disattiva');
  assert.ok(mount.textContent.includes('Disattivare Pacchetto 10 lezioni?'), 'the toggle asks first');
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'nothing is sent before confirmation');
  clickButton(mount, 'Conferma');
  await flush();
  const toggle = client.calls.find((call) => call.path === '/api/catalog/products/p1/active');
  assert.ok(toggle, 'confirmation sends the flag change');
  assert.deepEqual(toggle.body, { active: false });
});

test('band labels and euro parsing fail closed', () => {
  assert.equal(bpsLabel(1000), '10%');
  assert.equal(bpsLabel(250), '2.5%');
  assert.equal(bpsLabel(-1), null);
  assert.equal(bpsLabel('1000'), null);
  assert.equal(bpsLabel(NaN), null);
  assert.equal(parseEuroToCents('99.00'), 9900);
  assert.equal(parseEuroToCents('120,50'), 12050);
  assert.equal(parseEuroToCents('0'), 0);
  assert.equal(parseEuroToCents('12.345'), null);
  assert.equal(parseEuroToCents('-3'), null);
  assert.equal(parseEuroToCents(''), null);
  assert.equal(parseEuroToCents('abc'), null);
  assert.equal(parseEuroToCents(42), null);
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

test('the catalog screen renders no raw control', async () => {
  // BO-F6-15 acceptance (spec catalogo.md C10): nessun button/select/input
  // senza le classi del sistema visivo nella schermata. Every control
  // reaches the DOM through the shared `el` library, which normalizes
  // legacy classes onto `ui-*` (see admin-calendario.test.js:735).
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
  const view = createCatalogView({ doc, mount, client: stubClient() });
  await view.renderTable({});
  assert.deepEqual(rawControls(mount), [], 'every catalog control of the list carries a ui-* class');
  clickButton(mount, 'Modifica prezzi');
  await flush();
  assert.deepEqual(rawControls(mount), [], 'the price editor form adds no raw control');
  const stripeDoc = createFakeDocument();
  const stripeMount = createMount();
  const stripeView = createCatalogView({ doc: stripeDoc, mount: stripeMount, client: stubClient({ tables: { '': STRIPE_TABLE } }) });
  await stripeView.renderTable({});
  assert.deepEqual(rawControls(stripeMount), [], 'every catalog control of the Stripe state carries a ui-* class');
  clickButton(stripeMount, 'Sincronizza');
  assert.deepEqual(rawControls(stripeMount), [], 'the sync confirm dialog adds no raw control');
});

test('Stripe pricing models and intervals read in Italian, unknown models stay out', async () => {
  const table = structuredClone(STRIPE_TABLE);
  const offers = (table.rows ?? table.items ?? table.products)[0].offers;
  offers[0].components = [
    { ...offers[0].components[0], label: 'Trimestrale', interval: 'month', intervalCount: 3, unitAmountCents: 4000 },
    { label: 'Spazio', chargeType: 'recurring', pricingModel: 'graduated', interval: 'year', intervalCount: 1, unitAmountCents: null, flatAmountCents: null, externalPriceId: 'price_spazio', sourcePricingModel: 'stripe:recurring.graduated', tiers: [{ upTo: 5, unitAmountCents: 200, flatAmountCents: null }, { upTo: null, unitAmountCents: 100, flatAmountCents: null }] },
    { label: 'Strano', chargeType: 'one_time', pricingModel: 'mystery', interval: 'fortnight', intervalCount: 1, unitAmountCents: 500, flatAmountCents: null, externalPriceId: 'price_strano', sourcePricingModel: 'stripe:x', tiers: [] },
  ];
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCatalogView({ doc, mount, client: stubClient({ tables: { '': table } }) });
  await view.renderTable({});
  const text = mount.textContent;
  assert.ok(text.includes('40 € / ogni 3 mesi'), `a 3-month interval says so (${text})`);
  assert.ok(text.includes('(a scaglioni) / anno'), 'graduated reads a scaglioni');
  assert.ok(text.includes('Strano: 5 €'), 'an unknown model and interval are left out, the amount stays');
  assert.ok(!/mystery|fortnight|graduated/.test(text), 'no machine word reaches the screen');
});
