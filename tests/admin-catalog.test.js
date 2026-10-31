import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogView, commercialBlock, bpsLabel, parseEuroToCents, parseProductSentence, buildCreateBody } from '../apps/admin/public/admin-catalog.js';
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

test('provider rows promise no Stripe edit while Stripe is disconnected', async () => {
  // A provider-priced row with a summary that says disconnected: the row
  // keeps its amounts as plain text but carries no "change it on Stripe"
  // note, since there is no connected Stripe source to change it on.
  const doc = createFakeDocument();
  const mount = createMount();
  const table = {
    products: STRIPE_TABLE.products,
    summary: { manual: 0, byProvider: {}, stripeConnected: false },
  };
  const client = stubClient({ tables: { '': table } });
  const view = createCatalogView({ doc, mount, client });
  await view.renderTable({});

  const text = mount.textContent;
  assert.ok(text.includes('Stripe non collegato'), 'the disconnected state renders');
  assert.ok(!text.includes('Sola lettura'), 'no row promises a Stripe edit while disconnected');
  assert.ok(!text.includes('sola lettura'), 'no row promises a Stripe edit while disconnected');
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

function fillCreateField(mount, label, value) {
  const input = mount.findAll('input').find((node) => node.getAttribute('aria-label') === label);
  assert.ok(input, `the ${label} field renders`);
  input.value = value;
}

test('Aggiungi prodotto creates a manual product after review and confirmation', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCatalogView({ doc, mount, client });
  await view.renderTable({});

  clickButton(mount, 'Aggiungi prodotto');
  fillCreateField(mount, 'Nome', 'Pacchetto 5 lezioni');
  fillCreateField(mount, 'Codice', 'PACCHETTO-5');
  fillCreateField(mount, 'Categoria', 'pacchetti');
  fillCreateField(mount, 'Prezzo', '120,50');
  fillCreateField(mount, 'Unità', 'ingressi');
  clickButton(mount, 'Rivedi');
  assert.ok(mount.textContent.includes('Creare Pacchetto 5 lezioni (PACCHETTO-5)'), 'the review names the product');
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'review sends nothing');
  clickButton(mount, 'Conferma');
  await flush();
  const created = client.calls.find((call) => call.path === '/api/catalog/products' && call.method === 'POST');
  assert.ok(created, 'confirmation sends the creation');
  assert.equal(created.body.sku, 'PACCHETTO-5');
  assert.equal(created.body.name, 'Pacchetto 5 lezioni');
  assert.equal(created.body.category, 'pacchetti');
  assert.equal(created.body.currency, 'EUR');
  assert.equal(created.body.unit, 'ingressi');
  assert.equal(created.body.components.length, 1, 'one price from the form');
  assert.equal(created.body.components[0].flatAmountCents, 12050, 'the comma decimal becomes cents');
  assert.equal(created.body.components[0].pricingModel, 'flat_fee');
  assert.equal(created.body.components[0].chargeType, 'one_time');
});

test('the create form refuses garbage without sending', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCatalogView({ doc, mount, client });
  await view.renderTable({});

  clickButton(mount, 'Aggiungi prodotto');
  fillCreateField(mount, 'Prezzo', '99.00');
  clickButton(mount, 'Rivedi');
  assert.ok(mount.textContent.includes('obbligatori'), 'an empty name and code refuse with a reason');
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'nothing is sent');

  fillCreateField(mount, 'Nome', 'Prova');
  fillCreateField(mount, 'Codice', 'PROVA-1');
  fillCreateField(mount, 'Prezzo', '12.345');
  clickButton(mount, 'Rivedi');
  assert.ok(mount.textContent.includes('non negativo'), 'three decimals refuse with a reason');
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'the hostile amount is never sent');

  fillCreateField(mount, 'Prezzo', '10.00');
  fillCreateField(mount, 'Valuta', 'eur');
  clickButton(mount, 'Rivedi');
  assert.ok(mount.textContent.includes('maiuscole'), 'a lowercase currency refuses with a reason');
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'nothing is sent');
});

test('every row states its active flag, every non-Stripe row offers its actions', async () => {
  const inactiveManual = structuredClone(MANUAL_TABLE.products[0]);
  inactiveManual.productId = 'p3';
  inactiveManual.name = 'Pacchetto archiviato';
  inactiveManual.active = false;
  const importedOffer = structuredClone(MANUAL_TABLE.products[0].offers[0]);
  importedOffer.offerId = 'o4';
  const imported = {
    productId: 'p4',
    sku: 'PRESTI-1',
    name: 'Ingresso singolo',
    description: 'Listino importato.',
    category: 'ingressi',
    source: 'presti-listino',
    priceReadOnly: true,
    active: false,
    version: 1,
    offers: [importedOffer],
  };
  const table = {
    products: [MANUAL_TABLE.products[0], inactiveManual, imported],
    summary: { manual: 2, byProvider: { 'presti-listino': 1 }, stripeConnected: false },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCatalogView({ doc, mount, client: stubClient({ tables: { '': table } }) });
  await view.renderTable({});

  const states = mount.findAll('span')
    .filter((node) => node.getAttribute('class') === 'catalog-active-state')
    .map((node) => node.textContent);
  assert.deepEqual(states, ['Attivo', 'Non attivo', 'Non attivo'], 'every row states its flag, imported rows too');
  const labels = mount.findAll('button').map((node) => node.textContent);
  assert.ok(labels.includes('Disattiva'), 'the active manual row offers its toggle');
  assert.ok(labels.includes('Attiva'), 'the inactive manual row offers its toggle');
  const importedRows = mount.findAll('div')
    .filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('catalog-row'))
    .map((row) => row.textContent.includes('Ingresso singolo') ? row.textContent : null)
    .filter(Boolean);
  assert.equal(importedRows.length, 1, 'the imported row renders');
  assert.ok(importedRows[0].includes('Modifica prezzi'), 'the imported non-Stripe row offers its price edit');
  assert.ok(importedRows[0].includes('Attiva'), 'the imported non-Stripe row offers its toggle');
  assert.ok(importedRows[0].includes('Togli'), 'the imported non-Stripe row offers its removal');
  const togliCount = mount.findAll('button').filter((node) => node.textContent === 'Togli').length;
  assert.equal(togliCount, 3, 'every non-Stripe row offers Togli');
  assert.ok(
    mount.textContent.includes('Prezzi importati: alla prima modifica la riga passa alla gestione manuale.'),
    'the imported price edit names the takeover before anything is sent',
  );
  for (const button of mount.findAll('button').filter((node) => node.textContent === 'Attiva')) {
    button.dispatch('click');
  }
  const takeoverConfirms = mount.findAll('p')
    .filter((node) => node.getAttribute('class') === 'catalog-takeover-note'
      && node.textContent.includes('La riga importata passa alla gestione manuale'));
  assert.equal(takeoverConfirms.length, 1, 'only the imported toggle confirm names the takeover');
});

test('Stripe rows offer no action and stay read-only', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCatalogView({ doc, mount, client: stubClient({ tables: { '': STRIPE_TABLE } }) });
  await view.renderTable({});

  const labels = mount.findAll('button').map((node) => node.textContent);
  assert.ok(!labels.includes('Modifica prezzi'), 'no price edit on a Stripe row');
  assert.ok(!labels.includes('Attiva') && !labels.includes('Disattiva'), 'no toggle on a Stripe row');
  assert.ok(!labels.includes('Togli'), 'no removal on a Stripe row');
  assert.ok(!mount.textContent.includes('gestione manuale'), 'no takeover note on a Stripe row');
  const states = mount.findAll('span')
    .filter((node) => node.getAttribute('class') === 'catalog-active-state')
    .map((node) => node.textContent);
  assert.ok(states.length > 0 && states.every((state) => state === 'Attivo' || state === 'Non attivo'), 'Stripe rows still state their flag');
});

test('Togli archives a non-Stripe row through the active route, never a delete', async () => {
  // Products are stable identity and quoted evidence is never rewritten, so
  // removal archives: the row deactivates and its offers close via the
  // existing active route. No DELETE request exists anywhere in the stack.
  const importedOffer = structuredClone(MANUAL_TABLE.products[0].offers[0]);
  importedOffer.offerId = 'o4';
  const table = {
    products: [
      MANUAL_TABLE.products[0],
      {
        productId: 'p4',
        sku: 'PRESTI-1',
        name: 'Ingresso singolo',
        description: 'Listino importato.',
        category: 'ingressi',
        source: 'presti-listino',
        priceReadOnly: true,
        active: true,
        version: 1,
        offers: [importedOffer],
      },
    ],
    summary: { manual: 1, byProvider: { 'presti-listino': 1 }, stripeConnected: false },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ tables: { '': table } });
  const view = createCatalogView({ doc, mount, client });
  await view.renderTable({});

  const rows = mount.findAll('div')
    .filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('catalog-row'));
  assert.equal(rows.length, 2, 'both rows render');
  const importedRow = rows.find((row) => row.textContent.includes('Ingresso singolo'));
  assert.ok(importedRow, 'the imported row renders');
  const togli = importedRow.findAll('button').find((node) => node.textContent === 'Togli');
  assert.ok(togli, 'the imported row offers Togli');
  togli.dispatch('click');
  assert.ok(
    mount.textContent.includes('resta in archivio e non è più quotabile'),
    'the confirm names archiving instead of promising destruction',
  );
  assert.ok(
    mount.textContent.includes('La riga importata passa alla gestione manuale'),
    'the imported removal names the takeover before anything is sent',
  );
  clickButton(mount, 'Conferma');
  await flush();
  const posts = client.calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 1, 'a single write, never a blind retry');
  assert.equal(posts[0].path, '/api/catalog/products/p4/active', 'removal archives through the active route');
  assert.deepEqual(posts[0].body, { active: false }, 'the archive deactivates');
  assert.ok(
    !client.calls.some((call) => call.method === 'DELETE'),
    'no hard delete anywhere in the stack',
  );
});

test('Aggiungi prodotto stays available once Stripe is connected', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCatalogView({ doc, mount, client: stubClient({ tables: { '': STRIPE_TABLE } }) });
  await view.renderTable({});

  assert.ok(mount.findAll('button').some((node) => node.textContent === 'Aggiungi prodotto'), 'manual products coexist with Stripe');
  assert.ok(mount.textContent.includes('sola lettura'), 'Stripe rows stay read-only and the page says so');
});

test('the rows read the r2 row fields: unit, sconto max, quantità', async () => {
  // Spec catalogo.md C11/C12/C14-C16 (voce figlia c7deb9c21f3b): the table
  // renders the product-version r2 row fields as read-only text on every
  // row, manual and provider alike — each in its own column, never repeating
  // the column name. A hostile unit stays text, never markup.
  const withFields = structuredClone(MANUAL_TABLE.products[0]);
  withFields.unit = 'ingressi';
  withFields.maxDiscountBps = 1000;
  withFields.stockQuantity = 7;
  const hostile = structuredClone(MANUAL_TABLE.products[0]);
  hostile.productId = 'p5';
  hostile.name = 'Ostfang';
  hostile.sku = 'OST-1';
  hostile.unit = '<img src=x>';
  hostile.maxDiscountBps = null;
  hostile.stockQuantity = null;
  const table = {
    products: [withFields, hostile],
    summary: { manual: 2, byProvider: {}, stripeConnected: false },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCatalogView({ doc, mount, client: stubClient({ tables: { '': table } }) });
  await view.renderTable({});

  const text = mount.textContent;
  const units = mount.findAll('p')
    .filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('catalog-unit'))
    .map((node) => node.textContent);
  assert.deepEqual(units, ['ingressi', '<img src=x>'], 'the unit reads in its own column');
  assert.ok(!text.includes('· per'), 'no unit suffix repeats the column in the price cell');
  const discounts = mount.findAll('p')
    .filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('catalog-max-discount'))
    .map((node) => node.textContent);
  assert.deepEqual(discounts, ['10%', '—'], 'the discount ceiling reads as a bare value with an honest dash');
  const stocks = mount.findAll('p')
    .filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('catalog-stock'))
    .map((node) => node.textContent);
  assert.deepEqual(stocks, ['7', '—'], 'the stock count reads as a bare value with a dash for services');
  assert.equal(mount.findAll('img').length, 0, 'no markup from the unit reaches the DOM');
});

test('an empty catalog is a gentle note with the action, never a bare header', async () => {
  // Spec catalogo.md C19 (voce figlia c7deb9c21f3b): with zero products the
  // list names the empty state and points at «Aggiungi prodotto», which
  // stays on the page above.
  const table = { products: [], summary: { manual: 0, byProvider: {}, stripeConnected: false } };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCatalogView({ doc, mount, client: stubClient({ tables: { '': table } }) });
  await view.renderTable({});

  assert.ok(mount.textContent.includes('Nessun prodotto in catalogo'), 'the empty state names itself');
  assert.ok(mount.findAll('button').some((node) => node.textContent === 'Aggiungi prodotto'), 'the create action stays reachable');
});

test('an uncertain creation reconciles the created row instead of retrying blindly', async () => {
  // The create route has no replay protection, so a second Conferma after a
  // lost response would create a duplicate product. On COMMIT_OUTCOME_UNKNOWN
  // the view re-reads the catalog: a NEW row (not on screen before) carrying
  // every submitted field reconciles, so it renders as created with a single
  // attempt.
  const created = { ...MANUAL_TABLE.products[0], productId: 'p9', sku: 'PACCHETTO-5', name: 'Pacchetto 5 lezioni' };
  const reconciled = { products: [...MANUAL_TABLE.products, created], summary: MANUAL_TABLE.summary };
  const doc = createFakeDocument();
  const mount = createMount();
  // The initial load shows the table without the new row; only the reload
  // after the uncertain outcome carries it, so it reads as new.
  const base = stubClient({ tables: { '': MANUAL_TABLE } });
  let loads = 0;
  const client = {
    calls: base.calls,
    async request(path, options = {}) {
      if (String(options.method ?? 'GET').toUpperCase() === 'GET' && path.startsWith('/api/catalog/products')) {
        loads += 1;
        if (loads > 1) return reconciled;
      }
      return base.request(path, options);
    },
  };
  let attempts = 0;
  const submissions = {
    async submit() {
      attempts += 1;
      throw Object.assign(new Error('commit outcome unknown'), { code: 'COMMIT_OUTCOME_UNKNOWN' });
    },
  };
  const view = createCatalogView({ doc, mount, client, submissions });
  await view.renderTable({});

  clickButton(mount, 'Aggiungi prodotto');
  fillCreateField(mount, 'Nome', 'Pacchetto 5 lezioni');
  fillCreateField(mount, 'Codice', 'PACCHETTO-5');
  fillCreateField(mount, 'Categoria', 'pacchetti');
  fillCreateField(mount, 'Prezzo', '99.00');
  clickButton(mount, 'Rivedi');
  clickButton(mount, 'Conferma');
  await flush();

  assert.equal(attempts, 1, 'a single creation attempt, never a blind retry');
  assert.ok(!mount.textContent.includes('Esito incerto'), 'no uncertain warning when the row reconciles');
  assert.ok(mount.textContent.includes('Pacchetto 5 lezioni'), 'the created row renders as created');
});

test('an uncertain creation with only the code matching stays locked', async () => {
  // SKUs may repeat, so a pre-existing row with the submitted code but
  // different details never reconciles an uncertain outcome: the form stays
  // locked instead of closing on a row this submission did not create.
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ tables: { '': MANUAL_TABLE } });
  let attempts = 0;
  const submissions = {
    async submit() {
      attempts += 1;
      throw Object.assign(new Error('commit outcome unknown'), { code: 'COMMIT_OUTCOME_UNKNOWN' });
    },
  };
  const view = createCatalogView({ doc, mount, client, submissions });
  await view.renderTable({});

  clickButton(mount, 'Aggiungi prodotto');
  fillCreateField(mount, 'Nome', 'Lezioni serali');
  fillCreateField(mount, 'Codice', 'YOGA-10');
  fillCreateField(mount, 'Prezzo', '10.00');
  clickButton(mount, 'Rivedi');
  clickButton(mount, 'Conferma');
  await flush();

  assert.equal(attempts, 1, 'a single creation attempt, never a blind retry');
  assert.ok(mount.textContent.includes('Esito incerto'), 'a code-only match never reconciles');
  const yes = mount.findAll('button').find((node) => node.textContent === 'Conferma');
  assert.ok(yes, 'the confirm button is still there');
  assert.equal(yes.disabled, true, 'retry stays locked until the operator reloads');
});

test('an uncertain creation without the row stays locked instead of duplicating', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ tables: { '': MANUAL_TABLE } });
  let attempts = 0;
  const submissions = {
    async submit() {
      attempts += 1;
      throw Object.assign(new Error('commit outcome unknown'), { code: 'COMMIT_OUTCOME_UNKNOWN' });
    },
  };
  const view = createCatalogView({ doc, mount, client, submissions });
  await view.renderTable({});

  clickButton(mount, 'Aggiungi prodotto');
  fillCreateField(mount, 'Nome', 'Pacchetto 5 lezioni');
  fillCreateField(mount, 'Codice', 'PACCHETTO-5');
  fillCreateField(mount, 'Prezzo', '10.00');
  clickButton(mount, 'Rivedi');
  clickButton(mount, 'Conferma');
  await flush();

  assert.equal(attempts, 1, 'a single creation attempt, never a blind retry');
  assert.ok(mount.textContent.includes('Esito incerto'), 'the operator is told to reload and check first');
  const yes = mount.findAll('button').find((node) => node.textContent === 'Conferma');
  assert.ok(yes, 'the confirm button is still there');
  assert.equal(yes.disabled, true, 'retry stays locked until the operator reloads');
});

test('an uncertain creation never reconciles a matching imported row', async () => {
  // This form only creates manual rows: a reloaded row that matches every
  // submitted field but is still owned by its import source is a
  // pre-existing import, not this creation. Reconciling it would hide the
  // uncertainty and the operator would never reload and check.
  const imported = {
    ...structuredClone(MANUAL_TABLE.products[0]),
    productId: 'p9',
    sku: 'PACCHETTO-5',
    name: 'Pacchetto 5 lezioni',
    source: 'presti-listino',
    priceReadOnly: true,
  };
  const reloaded = { products: [...MANUAL_TABLE.products, imported], summary: MANUAL_TABLE.summary };
  const doc = createFakeDocument();
  const mount = createMount();
  const base = stubClient({ tables: { '': MANUAL_TABLE } });
  let loads = 0;
  const client = {
    calls: base.calls,
    async request(path, options = {}) {
      if (String(options.method ?? 'GET').toUpperCase() === 'GET' && path.startsWith('/api/catalog/products')) {
        loads += 1;
        if (loads > 1) return reloaded;
      }
      return base.request(path, options);
    },
  };
  let attempts = 0;
  const submissions = {
    async submit() {
      attempts += 1;
      throw Object.assign(new Error('commit outcome unknown'), { code: 'COMMIT_OUTCOME_UNKNOWN' });
    },
  };
  const view = createCatalogView({ doc, mount, client, submissions });
  await view.renderTable({});

  clickButton(mount, 'Aggiungi prodotto');
  fillCreateField(mount, 'Nome', 'Pacchetto 5 lezioni');
  fillCreateField(mount, 'Codice', 'PACCHETTO-5');
  fillCreateField(mount, 'Categoria', 'pacchetti');
  fillCreateField(mount, 'Prezzo', '99.00');
  clickButton(mount, 'Rivedi');
  clickButton(mount, 'Conferma');
  await flush();

  assert.equal(attempts, 1, 'a single creation attempt, never a blind retry');
  assert.ok(mount.textContent.includes('Esito incerto'), 'a matching imported row never reconciles');
  const yes = mount.findAll('button').find((node) => node.textContent === 'Conferma');
  assert.ok(yes, 'the confirm button is still there');
  assert.equal(yes.disabled, true, 'retry stays locked until the operator reloads');
});

test('an uncertain creation reloads with the table filters', async () => {
  // knownProductIds only covers the filtered page the operator saw: the
  // reconcile reloads with the same filters, so a filtered-out pre-existing
  // row never reads as new.
  const doc = createFakeDocument();
  const mount = createMount();
  const base = stubClient({ tables: { '': MANUAL_TABLE } });
  const loads = [];
  const client = {
    calls: base.calls,
    async request(path, options = {}) {
      if (String(options.method ?? 'GET').toUpperCase() === 'GET' && path.startsWith('/api/catalog/products')) {
        loads.push(path);
      }
      return base.request(path, options);
    },
  };
  const submissions = {
    async submit() {
      throw Object.assign(new Error('commit outcome unknown'), { code: 'COMMIT_OUTCOME_UNKNOWN' });
    },
  };
  const view = createCatalogView({ doc, mount, client, submissions });
  await view.renderTable({ source: 'manual', category: 'pacchetti' });

  clickButton(mount, 'Aggiungi prodotto');
  fillCreateField(mount, 'Nome', 'Pacchetto 5 lezioni');
  fillCreateField(mount, 'Codice', 'PACCHETTO-5');
  fillCreateField(mount, 'Prezzo', '10.00');
  clickButton(mount, 'Rivedi');
  clickButton(mount, 'Conferma');
  await flush();

  assert.equal(loads.length, 2, 'the initial load plus one reconcile reload');
  const reload = new URL(loads[1], 'http://admin.test');
  assert.equal(reload.searchParams.get('source'), 'manual', 'the reconcile reload keeps the source filter');
  assert.equal(reload.searchParams.get('category'), 'pacchetti', 'the reconcile reload keeps the category filter');
  assert.equal(reload.searchParams.get('limit'), '200', 'the reconcile reload keeps the row limit');
});

test('the header names the eight columns in order and every row carries eight cells', async () => {
  // Supervisor review on main after #506: the header wrapped over two lines
  // and Fonte/Attivo/Togli fell on a second row, because the grid declared
  // fewer columns than the cells. The header and every row now share the
  // same eight columns, in the reviewed order.
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCatalogView({ doc, mount, client: stubClient({ tables: { '': SEARCH_TABLE } }) });
  await view.renderTable({});

  const heads = mount.findAll('div')
    .filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('catalog-thead'));
  assert.equal(heads.length, 1, 'one header');
  const labels = heads[0].childNodes.map((node) => node.textContent);
  assert.deepEqual(
    labels,
    ['Prodotto', 'Categoria', 'Prezzo', 'Unità', 'Sconto max', 'Quantità', 'Fonte', 'Attivo'],
    'the reviewed column order',
  );
  const rows = mount.findAll('div')
    .filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('catalog-row'));
  assert.equal(rows.length, 2, 'one row per product');
  for (const row of rows) {
    assert.equal(row.childNodes.length, 8, 'every row carries exactly the eight grid cells');
  }
});

test('no cell repeats its column name', async () => {
  // Supervisor acceptance: each value reads bare, never prefixed with the
  // column label. The review runs on texts, so the check reads texts.
  const table = structuredClone(MANUAL_TABLE);
  table.products[0].unit = 'ingressi';
  table.products[0].maxDiscountBps = 1000;
  table.products[0].stockQuantity = 7;
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCatalogView({ doc, mount, client: stubClient({ tables: { '': table } }) });
  await view.renderTable({});

  const valueOf = (cls) => mount.findAll('p')
    .filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes(cls))
    .map((node) => node.textContent);
  for (const text of valueOf('catalog-max-discount')) {
    assert.ok(!text.toLowerCase().includes('sconto'), `the discount cell never names its column (${text})`);
  }
  for (const text of valueOf('catalog-stock')) {
    assert.ok(!text.toLowerCase().includes('quantit'), `the stock cell never names its column (${text})`);
  }
  for (const text of valueOf('catalog-unit')) {
    assert.ok(!/unit|ingressi:/i.test(text) || text === 'ingressi', `the unit cell reads the bare unit (${text})`);
  }
  assert.equal(valueOf('catalog-unit')[0], 'ingressi', 'the unit reads bare');
  assert.equal(valueOf('catalog-max-discount')[0], '10%', 'the ceiling reads bare');
  assert.equal(valueOf('catalog-stock')[0], '7', 'the stock reads bare');
});

test('the Stripe count and the Fonte chips stay coherent', async () => {
  // The Stripe block and every Fonte chip read the same derivation: rows
  // whose source names Stripe, counted by provider.
  const striped = structuredClone(STRIPE_TABLE.products[0]);
  const second = structuredClone(striped);
  second.productId = 'p9';
  second.name = 'Corso Pilates';
  const table = {
    products: [striped, second],
    summary: { manual: 0, byProvider: { 'stripe-test': 2 }, stripeConnected: true },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCatalogView({ doc, mount, client: stubClient({ tables: { '': table } }) });
  await view.renderTable({});

  assert.ok(mount.textContent.includes('2 prodotti importati da Stripe'), 'the block counts the Stripe rows');
  const chips = mount.findAll('span')
    .filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('catalog-source'))
    .map((node) => node.textContent);
  assert.deepEqual(chips, ['Stripe', 'Stripe'], 'every Stripe row carries the Fonte chip');
});

test('the Stripe block falls back to the same by-provider derivation as the chips', async () => {
  // A summary without the stripeConnected flag (older payloads) still reads
  // connected when a provider names Stripe — exactly like the row chips do.
  const table = {
    products: structuredClone(STRIPE_TABLE.products),
    summary: { manual: 0, byProvider: { 'stripe-test': 1 } },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCatalogView({ doc, mount, client: stubClient({ tables: { '': table } }) });
  await view.renderTable({});

  assert.ok(mount.textContent.includes('Collegato a Stripe'), 'the block derives the connection like the chips');
  assert.ok(mount.textContent.includes('1 prodotto importato da Stripe'), 'the count matches the single Stripe row');
  assert.ok(!mount.textContent.includes('non collegato'), 'no conflicting invite while a Stripe row is on screen');
});

test('category and source filter while typing, the state select re-reads at once', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ tables: { '': SEARCH_TABLE } });
  const view = createCatalogView({ doc, mount, client });
  await view.renderTable({});

  const byName = (name) => mount.findAll('input').find((node) => node.getAttribute('name') === name);
  const reads = () => client.calls.filter((call) => call.path.startsWith('/api/catalog/products')).length;
  const before = reads();

  byName('category').value = 'pacchetti';
  byName('category').dispatch('input');
  assert.equal(rowCount(mount), 1, 'the category narrows the loaded rows while typing');
  assert.ok(mount.textContent.includes('Pacchetto 10 lezioni'), 'the matching row stays');
  assert.equal(reads(), before, 'typing never refetches');

  byName('category').value = '';
  byName('category').dispatch('input');
  byName('source').value = 'manual';
  byName('source').dispatch('input');
  assert.equal(rowCount(mount), 2, 'the source matches both manual rows');

  byName('source').value = 'stripe';
  byName('source').dispatch('input');
  assert.equal(rowCount(mount), 0, 'a source with no loaded rows reads empty');
  assert.ok(mount.textContent.includes('Nessun risultato per questi filtri'), 'the gentle note covers text filters without a query');

  const select = mount.findAll('select').find((node) => node.getAttribute('name') === 'active');
  assert.ok(select, 'the state select renders');
  select.value = 'true';
  select.dispatch('change');
  await flush();
  assert.equal(reads(), before + 1, 'choosing a state re-reads from the server at once');
  const reread = new URL(client.calls.filter((call) => call.path.startsWith('/api/catalog/products')).at(-1).path, 'http://admin.test');
  assert.equal(reread.searchParams.get('active'), 'true', 'the state travels as a query param');
});

test('parseProductSentence reads a sentence fail-closed', () => {
  const full = parseProductSentence('Pacchetto 10 lezioni PACCHETTO-10 a 99 euro categoria pacchetti per ingressi');
  assert.equal(full.ok, true, 'a complete sentence parses');
  assert.equal(full.fields.name, 'Pacchetto 10 lezioni', 'the name is what is left over');
  assert.equal(full.fields.sku, 'PACCHETTO-10', 'the uppercase token is the code');
  assert.equal(full.fields.cents, 9900, 'the price becomes cents');
  assert.equal(full.fields.currency, 'EUR', 'euro reads EUR');
  assert.equal(full.fields.category, 'pacchetti', 'categoria reads the category');
  assert.equal(full.fields.unit, 'ingressi', 'per reads the unit');

  const short = parseProductSentence('YOGA a 49,50 €');
  assert.equal(short.ok, false, 'a sentence without a code refuses');
  assert.deepEqual(short.missing, ['codice'], 'only the missing field is named');

  const hostile = parseProductSentence('<script>alert(1)</script> PROVA-1 a 10 euro');
  assert.equal(hostile.ok, true, 'markup never blocks a complete sentence');
  assert.ok(!/<script>/.test(hostile.fields.sku ?? ''), 'the markup leaves through the name, never a field');
});

test('buildCreateBody posts the single one-time flat component', () => {
  const body = buildCreateBody({ sku: 'X-1', name: 'Prova', category: 'c', currency: 'EUR', unit: 'u', cents: 100 });
  assert.equal(body.sku, 'X-1');
  assert.equal(body.components.length, 1, 'one price from the sentence or the fields');
  assert.equal(body.components[0].pricingModel, 'flat_fee', 'manual creations stay one-time flat');
  assert.equal(body.components[0].flatAmountCents, 100);
});

test('✦ Aggiungi con l\u2019AI creates a product from a sentence after confirmation', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCatalogView({ doc, mount, client });
  await view.renderTable({});

  clickButton(mount, '✦ Aggiungi con l\u2019AI');
  const sentence = mount.findAll('input').find((node) => node.getAttribute('name') === 'sentence');
  assert.ok(sentence, 'the sentence field renders');
  sentence.value = 'Pacchetto 5 lezioni PACCHETTO-5 a 120,50 euro categoria pacchetti';
  clickButton(mount, 'Interpreta');
  assert.ok(mount.textContent.includes('Creare Pacchetto 5 lezioni (PACCHETTO-5)'), 'the review echoes the parsed sentence');
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'interpreting sends nothing');
  clickButton(mount, 'Conferma');
  await flush();
  const created = client.calls.find((call) => call.path === '/api/catalog/products' && call.method === 'POST');
  assert.ok(created, 'confirmation sends the creation');
  assert.equal(created.body.sku, 'PACCHETTO-5');
  assert.equal(created.body.name, 'Pacchetto 5 lezioni');
  assert.equal(created.body.category, 'pacchetti');
  assert.equal(created.body.currency, 'EUR');
  assert.equal(created.body.components.length, 1, 'one price from the sentence');
  assert.equal(created.body.components[0].flatAmountCents, 12050, 'the comma decimal becomes cents');
  assert.equal(created.body.components[0].pricingModel, 'flat_fee');
});

test('✦ Aggiungi con l\u2019AI names what is missing and sends nothing', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCatalogView({ doc, mount, client });
  await view.renderTable({});

  clickButton(mount, '✦ Aggiungi con l\u2019AI');
  const sentence = mount.findAll('input').find((node) => node.getAttribute('name') === 'sentence');
  sentence.value = 'una cosa bella';
  clickButton(mount, 'Interpreta');
  assert.ok(mount.textContent.includes('Dalla frase mancano: codice, prezzo'), 'the missing fields are named');
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'an unreadable sentence sends nothing');
});

test('a partial category matches nothing live and the state change re-reads it as exact', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ tables: { '': SEARCH_TABLE } });
  const view = createCatalogView({ doc, mount, client });
  await view.renderTable({});

  const byName = (name) => mount.findAll('input').find((node) => node.getAttribute('name') === name);
  const reads = () => client.calls.filter((call) => call.path.startsWith('/api/catalog/products')).length;
  const before = reads();

  byName('category').value = 'pac';
  byName('category').dispatch('input');
  assert.equal(rowCount(mount), 0, 'a substring is not an exact category: nothing matches live');
  assert.ok(mount.textContent.includes('Nessun risultato per questi filtri'), 'the gentle note covers text filters without a query');
  assert.equal(reads(), before, 'typing never refetches');

  const select = mount.findAll('select').find((node) => node.getAttribute('name') === 'active');
  select.value = 'true';
  select.dispatch('change');
  await flush();
  assert.equal(reads(), before + 1, 'choosing a state re-reads from the server at once');
  const reread = new URL(client.calls.filter((call) => call.path.startsWith('/api/catalog/products')).at(-1).path, 'http://admin.test');
  assert.equal(reread.searchParams.get('category'), 'pac', 'the live text travels as the exact server filter');
  assert.equal(reread.searchParams.get('active'), 'true', 'the state travels as a query param');
  assert.equal(rowCount(mount), 0, 'the reload hides nothing that was visible: nothing was');
});

test('the source box matches the visible Fonte label, not only the raw source', async () => {
  const stripeRow = {
    productId: 'p3',
    sku: 'YOGA-1',
    name: 'Corso Yoga',
    description: 'Abbonamento.',
    category: 'corsi',
    source: 'stripe-test',
    priceReadOnly: true,
    active: true,
    version: 1,
    offers: [],
  };
  const mixed = { products: [...SEARCH_TABLE.products, stripeRow], summary: { manual: 2, byProvider: { 'stripe-test': 1 }, stripeConnected: true } };
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ tables: { '': mixed } });
  const view = createCatalogView({ doc, mount, client });
  await view.renderTable({});

  const byName = (name) => mount.findAll('input').find((node) => node.getAttribute('name') === name);
  const reads = () => client.calls.filter((call) => call.path.startsWith('/api/catalog/products')).length;
  const before = reads();

  byName('source').value = 'manuale';
  byName('source').dispatch('input');
  assert.equal(rowCount(mount), 2, 'the visible label Manuale matches both manual rows');
  assert.ok(mount.textContent.includes('Pacchetto 10 lezioni'), 'a manual row stays');
  assert.ok(mount.textContent.includes('Corso serale'), 'the other manual row stays');

  byName('source').value = 'stripe';
  byName('source').dispatch('input');
  assert.equal(rowCount(mount), 1, 'stripe matches the provider row by raw source and label');
  assert.ok(mount.textContent.includes('Corso Yoga'), 'the provider row stays');
  assert.equal(reads(), before, 'typing never refetches');
});

test('✦ Aggiungi con l\u2019AI locks the sentence after Interpreta and refuses a stale confirmation', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCatalogView({ doc, mount, client });
  await view.renderTable({});

  clickButton(mount, '✦ Aggiungi con l\u2019AI');
  const sentence = mount.findAll('input').find((node) => node.getAttribute('name') === 'sentence');
  sentence.value = 'Pacchetto 5 lezioni PACCHETTO-5 a 120,50 euro categoria pacchetti';
  clickButton(mount, 'Interpreta');
  assert.ok(mount.textContent.includes('Creare Pacchetto 5 lezioni (PACCHETTO-5)'), 'the review echoes the parsed sentence');
  assert.equal(sentence.disabled, true, 'the interpreted sentence locks: no silent edit after review');

  sentence.value = 'Pacchetto 5 lezioni PACCHETTO-5 a 9,99 euro categoria pacchetti';
  clickButton(mount, 'Conferma');
  await flush();
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'a sentence changed after Interpreta sends nothing');
  assert.ok(mount.textContent.includes('premi di nuovo Interpreta'), 'the stale confirmation names the way back');
  assert.equal(sentence.disabled, false, 'the sentence unlocks so it can be re-interpreted');
  assert.ok(mount.findAll('button').some((node) => node.textContent === 'Interpreta'), 'Interpreta is back for the corrected sentence');

  sentence.value = 'Pacchetto 5 lezioni PACCHETTO-5 a 120,50 euro categoria pacchetti';
  clickButton(mount, 'Conferma');
  await flush();
  const created = client.calls.find((call) => call.path === '/api/catalog/products' && call.method === 'POST');
  assert.ok(created, 'the unchanged review still confirms');
  assert.equal(created.body.components[0].flatAmountCents, 12050, 'the confirmed price is the reviewed one, never the stale edit');
});
