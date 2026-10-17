import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPriceListCatalogProvider,
  validatePriceListConfig,
  COMMERCIAL_RESOURCES,
  CommercialRegistries,
} from '../packages/commercial/src/index.js';
import { validateCatalogProvider } from '../packages/commercial/src/registry.js';
import { normalizeCatalog } from '../packages/commercial/src/catalog-sync.js';
import { createDatabase } from '../packages/core/src/database.js';

/**
 * Workspace price lists (accordo D1): a gym listino as plain JSON
 * configuration, served through the SAME product / price-book / offer
 * records — with a test that forbids a parallel catalog.
 *
 * The example below is gym-shaped on purpose (lesson packs, memberships,
 * trial sessions): it is the shape the pilot's workspace configuration
 * will carry, exercised here against the real sync validator.
 */

const GYM_PRICE_LIST = {
  priceBook: { name: 'Listino Palestra EUR', currency: 'EUR' },
  products: [
    { key: 'pacchetto-10-lezioni', name: 'Pacchetto 10 lezioni', category: 'pacchetti', description: 'Dieci ingressi con istruttore.' },
    { key: 'abbonamento-mensile', name: 'Abbonamento mensile', category: 'abbonamenti' },
    { key: 'lezione-prova', name: 'Lezione di prova', category: 'prove' },
    { key: 'lezione-singola', name: 'Lezione singola', category: 'pacchetti' },
  ],
  offers: [
    {
      key: 'pack-10', product: 'pacchetto-10-lezioni', name: 'Pacchetto 10 lezioni',
      components: [{ key: 'prezzo-pacchetto', label: 'Prezzo del pacchetto', charge: 'one_time', model: 'flat_fee', amountCents: 9900 }],
    },
    {
      key: 'mensile', product: 'abbonamento-mensile', name: 'Abbonamento mensile',
      components: [{ key: 'canone', label: 'Canone mensile', charge: 'recurring', model: 'flat_fee', interval: 'month', intervalCount: 1, amountCents: 4900 }],
    },
    {
      key: 'prova', product: 'lezione-prova', name: 'Lezione di prova',
      components: [{ key: 'prezzo-prova', label: 'Prezzo della prova', charge: 'one_time', model: 'flat_fee', amountCents: 1000 }],
    },
    {
      key: 'singola', product: 'lezione-singola', name: 'Lezione singola',
      components: [{ key: 'prezzo-lezione', label: 'Prezzo per lezione', charge: 'one_time', model: 'per_unit', unitAmountCents: 1200 }],
    },
  ],
};

const provider = (priceList = GYM_PRICE_LIST, overrides = {}) => createPriceListCatalogProvider({
  name: 'palestra-listino',
  version: 1,
  priceList,
  ...overrides,
});

test('workspace price list serves through the real sync contract', async () => {
  const built = provider();
  assert.doesNotThrow(() => validateCatalogProvider(built));
  // The oracle is not a copy of the rules: it IS the validator catalog sync
  // runs before persisting anything.
  const catalog = normalizeCatalog(await built.fetchCatalog({}));
  assert.deepEqual(Object.keys(catalog).sort(), ['offers', 'priceBooks', 'products', 'sourceRef']);
  assert.equal(catalog.priceBooks.length, 1);
  assert.equal(catalog.priceBooks[0].currency, 'EUR');
  assert.equal(catalog.products.length, 4);
  assert.equal(catalog.offers.length, 4);
  assert.ok(
    catalog.offers.every((offer) => offer.quoteEligible === true),
    'plain packs, memberships and trials quote with no unsupported model',
  );
  const byKey = new Map(catalog.products.map((product) => [product.sourceKey, product]));
  for (const offer of catalog.offers) {
    assert.ok(byKey.has(offer.productSourceKey), `offer ${offer.sourceKey} resolves its product`);
    assert.ok(offer.sourceKey.startsWith('pricelist.palestra-listino.offer.'));
  }
  assert.deepEqual(
    catalog.products.map((product) => product.category).sort(),
    ['abbonamenti', 'pacchetti', 'pacchetti', 'prove'],
  );
  // Every fetch is a fresh copy: a caller that mutates the payload cannot
  // poison the next sync.
  catalog.offers[0].name = 'mutated';
  const again = normalizeCatalog(await built.fetchCatalog({}));
  assert.notEqual(again.offers[0].name, 'mutated');
});

test('the listino data is fingerprinted: a silent price change is drift', (t) => {
  const database = createDatabase({ path: ':memory:' });
  t.after(() => database.close());
  const first = new CommercialRegistries({ catalogProviders: [provider()] });
  first.persistFingerprints(database);
  assert.doesNotThrow(() => first.persistFingerprints(database));
  const fingerprintOf = (registries) => registries.getCatalogProvider('palestra-listino').fingerprint;
  const changed = structuredClone(GYM_PRICE_LIST);
  changed.offers[1].components[0].amountCents = 5900;
  const drifted = new CommercialRegistries({ catalogProviders: [provider(changed)] });
  assert.notEqual(fingerprintOf(drifted), fingerprintOf(first), 'the amount lives in the fingerprinted config');
  assert.throws(() => drifted.persistFingerprints(database), /source changed after registration/);
  assert.doesNotThrow(() => new CommercialRegistries({
    catalogProviders: [provider(changed, { version: 2 })],
  }).persistFingerprints(database), 'a price change ships as a new version');
});

test('misconfigured listini fail closed with the field path', () => {
  const cases = [
    [null, /plain object/],
    [{ ...GYM_PRICE_LIST, priceBook: { name: 'x', currency: 'euros' } }, /currency/],
    [{ ...GYM_PRICE_LIST, priceBook: { name: 'x', currency: 'EUR', active: 'yes' } }, /boolean/],
    [{ ...GYM_PRICE_LIST, products: [] }, /non-empty products/],
    [{ ...GYM_PRICE_LIST, offers: [] }, /non-empty offers/],
    [(() => { const next = structuredClone(GYM_PRICE_LIST); next.products[0].key = '__proto__'; return next; })(), /slug/],
    [(() => { const next = structuredClone(GYM_PRICE_LIST); next.products.push({ ...next.products[0] }); return next; })(), /duplicate product key/],
    [(() => { const next = structuredClone(GYM_PRICE_LIST); next.products[0].externalId = 'stripe-prod-1'; next.products[2].externalId = 'stripe-prod-1'; return next; })(), /products\[2\]\.externalId duplicates/],
    [(() => { const next = structuredClone(GYM_PRICE_LIST); next.offers.push({ ...next.offers[0] }); return next; })(), /duplicate offer key/],
    [(() => { const next = structuredClone(GYM_PRICE_LIST); next.offers[0].product = 'inesistente'; return next; })(), /unknown product/],
    [(() => { const next = structuredClone(GYM_PRICE_LIST); next.offers[0].components = []; return next; })(), /at least one price component/],
    [(() => { const next = structuredClone(GYM_PRICE_LIST); next.offers[0].components[0].amountCents = 99.99; return next; })(), /non-negative safe integer/],
    [(() => { const next = structuredClone(GYM_PRICE_LIST); next.offers[1].components[0].interval = 'week'; return next; })(), /interval/],
    [(() => { const next = structuredClone(GYM_PRICE_LIST); next.offers[0].components[0].interval = 'month'; return next; })(), /must not declare interval/],
    [(() => { const next = structuredClone(GYM_PRICE_LIST); next.offers[0].components[0].unitAmountCents = 99999; return next; })(), /unitAmountCents is not supported/],
    [(() => { const next = structuredClone(GYM_PRICE_LIST); next.offers[3].components[0].amountCents = 500; return next; })(), /amountCents is not supported/],
    [(() => { const next = structuredClone(GYM_PRICE_LIST); next.offers[0].components[0] = { key: 'soglie', label: 'Soglie', charge: 'one_time', model: 'volume', amountCents: 9900, tiers: [{ upTo: 10, unitAmountCents: 1200 }, { upTo: null, unitAmountCents: 900 }] }; return next; })(), /amounts in tiers/],
    [(() => { const next = structuredClone(GYM_PRICE_LIST); next.offers[0].components[0] = { key: 'soglie', label: 'Soglie', charge: 'one_time', model: 'graduated', unitAmountCents: 1200, tiers: [{ upTo: 10, unitAmountCents: 1200 }, { upTo: null, unitAmountCents: 900 }] }; return next; })(), /amounts in tiers/],
    [(() => { const next = structuredClone(GYM_PRICE_LIST); next.products[0].active = 1; return next; })(), /boolean/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(() => validatePriceListConfig(input), pattern);
  }
  assert.throws(() => provider(GYM_PRICE_LIST, { name: 'NOT-A-NAME!' }), /name must match/);
  assert.throws(() => provider(GYM_PRICE_LIST, { version: 0 }), /positive integer/);
});

test('the normalized listino is frozen in depth: nested amounts cannot drift', async () => {
  const normalized = validatePriceListConfig(GYM_PRICE_LIST);
  assert.ok(Object.isFrozen(normalized.priceBook), 'price book is frozen');
  for (const product of normalized.products) {
    assert.ok(Object.isFrozen(product), `product ${product.key} is frozen`);
  }
  for (const offer of normalized.offers) {
    assert.ok(Object.isFrozen(offer.components), `components of ${offer.key} are frozen`);
    for (const component of offer.components) {
      assert.ok(Object.isFrozen(component), `component ${component.key} is frozen`);
    }
  }
  // Modules are strict: mutating the fingerprinted config throws instead of
  // silently changing the next sync's prices.
  assert.throws(() => { normalized.products[0].name = 'mutated'; }, TypeError);
  assert.throws(() => { normalized.offers[0].components.push({ key: 'extra' }); }, TypeError);
  assert.throws(() => { normalized.offers[1].components[0].flatAmountCents = 1; }, TypeError);
  const built = provider();
  const catalog = normalizeCatalog(await built.fetchCatalog({}));
  assert.equal(catalog.offers[1].components[0].flatAmountCents, 4900, 'amounts survive unchanged');
});

test('no parallel catalog: the listino reuses product, price-book and offer', () => {
  assert.deepEqual([...COMMERCIAL_RESOURCES].sort(), [
    'catalog-sync-run', 'offer', 'price-book', 'price-component', 'price-tier',
    'product', 'product-version', 'quote', 'quote-approval', 'quote-line',
    'quote-term', 'quote-version', 'quote-version-component', 'quote-version-line',
    'quote-version-term', 'quote-version-total',
  ].sort(), 'no new commercial resource may arrive with the listino');
  const modulesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'commercial', 'modules');
  const manifests = readdirSync(modulesDir).filter((entry) => entry.endsWith('.module.json'));
  assert.ok(
    manifests.every((entry) => !/price-list|pricelist|listino/i.test(entry)),
    'no new catalog manifest may arrive with the listino',
  );
});
