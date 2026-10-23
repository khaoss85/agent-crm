import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPriceListCatalogProvider,
  validatePriceListConfig,
  PRICE_LIST_CATALOG_CODE_VERSION,
  COMMERCIAL_RESOURCES,
  CommercialRegistries,
} from '../packages/commercial/src/index.js';
import { validateCatalogProvider } from '../packages/commercial/src/registry.js';
import { normalizeCatalog } from '../packages/commercial/src/catalog-sync.js';
import { createDatabase } from '../packages/core/src/database.js';
import { createDefinitionVersionStore } from '../packages/core/index.js';

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

test('a too-long listino name is rejected at registration, naming the name', async () => {
  const tooLong = 'a'.repeat(100);
  // Before, a long but otherwise valid slug failed later and unclearly: with
  // the derived label the registry blamed the label ("at most 80
  // characters") instead of the name, and with an explicit short label it
  // registered at all. Both paths now fail up front with an error that names
  // the name and its bound, label or no label.
  assert.throws(
    () => provider(GYM_PRICE_LIST, { name: tooLong }),
    /name must be a non-empty string of at most \d+ characters/,
  );
  assert.throws(
    () => provider(GYM_PRICE_LIST, { name: tooLong, label: 'short' }),
    /name must be a non-empty string of at most \d+ characters/,
  );
  // Boundary: the longest name whose derived label still fits the registry
  // limit registers and syncs end to end; one character more does not.
  const longest = 'b'.repeat(80 - 'Workspace price list ()'.length);
  const built = provider(GYM_PRICE_LIST, { name: longest });
  assert.ok(built.label.length <= 80, `derived label is ${built.label.length} characters`);
  assert.doesNotThrow(() => validateCatalogProvider(built));
  const catalog = normalizeCatalog(await built.fetchCatalog({}));
  assert.ok(
    catalog.priceBooks[0].sourceKey === `pricelist.${longest}.book`,
    'the longest accepted name still produces a canonical source key',
  );
  assert.throws(() => provider(GYM_PRICE_LIST, { name: `${longest}x` }), /name must be/);
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

test('a pure refactor of the constructor leaves the provider fingerprint unchanged', async () => {
  const built = provider();
  const fingerprintOf = (definition) => new CommercialRegistries({ catalogProviders: [definition] })
    .getCatalogProvider('palestra-listino').fingerprint;
  const baseline = fingerprintOf(built);
  // Same behaviour, different closure text: the #271 class of change (a
  // renamed closed-over variable) plus a comment and a re-indented line.
  const refactoredSource = `${built.fetchCatalog.toString().replaceAll('providerName', 'renamedProvider')}\n    // refactored: behaviour identical, text different`;
  assert.notEqual(
    refactoredSource,
    built.fetchCatalog.toString(),
    'the variant really differs in source text, or this test is vacuous',
  );
  const refactoredFetch = Object.assign(
    async (input) => built.fetchCatalog(input),
    { toString: () => refactoredSource },
  );
  assert.deepEqual(
    await refactoredFetch({}),
    await built.fetchCatalog({}),
    'the variant renders the same catalog',
  );
  assert.equal(
    fingerprintOf({ ...built, fetchCatalog: refactoredFetch }),
    baseline,
    'closure text is not behaviour for a constructor-built provider',
  );
});

test('listino data, provider version and constructor version all move the fingerprint', () => {
  const fingerprintOf = (definition) => new CommercialRegistries({ catalogProviders: [definition] })
    .getCatalogProvider('palestra-listino').fingerprint;
  const baseline = fingerprintOf(provider());
  assert.equal(
    provider().codeVersion,
    PRICE_LIST_CATALOG_CODE_VERSION,
    'the constructor stamps its own version on the definition',
  );
  const changed = structuredClone(GYM_PRICE_LIST);
  changed.offers[0].components[0].amountCents = 19900;
  assert.notEqual(fingerprintOf(provider(changed)), baseline, 'listino data moves the fingerprint');
  assert.notEqual(
    fingerprintOf(provider(GYM_PRICE_LIST, { version: 2 })),
    baseline,
    'provider version moves the fingerprint',
  );
  assert.notEqual(
    fingerprintOf({ ...provider(), codeVersion: PRICE_LIST_CATALOG_CODE_VERSION + 1 }),
    baseline,
    'constructor version moves the fingerprint',
  );
});

/**
 * Frozen upgrade fixture: NEVER change this value — the two historical
 * fingerprints below were computed from exactly it, and the upgrade test
 * replays databases that registered it under the old closure-text scheme.
 */
const UPGRADE_FIXTURE = {
  priceBook: { name: 'Listino', currency: 'EUR' },
  products: [{ key: 'prod', name: 'Prodotto' }],
  offers: [{
    key: 'off', product: 'prod', name: 'Offerta',
    components: [{ key: 'prezzo', label: 'Prezzo', charge: 'one_time', model: 'flat_fee', amountCents: 1000 }],
  }],
};
// Fingerprints the pre-fix registry computed for UPGRADE_FIXTURE as
// `listino-upgrade@1`: before agent-crm #271 (closure over `name`) and after
// it (closure over `providerName`). Recorded from the framework at 3ddffcbf.
const UPGRADE_FINGERPRINT_PRE_271 = '4e7baa05df2ea12d80a9839d46eb7103bad297189b990c03e4326918c58aabf8';
const UPGRADE_FINGERPRINT_271 = 'b150bbb0d2b5a2e7ebfa268590484fd96935866361033c775fa0a6652a8d73f1';

test('a database registered under the old closure-text scheme keeps composing', (t) => {
  const databases = [];
  t.after(() => { for (const database of databases) database.close(); });
  for (const historical of [UPGRADE_FINGERPRINT_PRE_271, UPGRADE_FINGERPRINT_271]) {
    const database = createDatabase({ path: ':memory:' });
    databases.push(database);
    // The space registered version 1 with the old framework, which hashed
    // the closure source: replay that row directly.
    createDefinitionVersionStore(database).persist([{
      type: 'catalog-provider',
      name: 'listino-upgrade',
      version: 1,
      fingerprint: historical,
    }]);
    // The fixed framework boots the unchanged listino: the row migrates to
    // the current fingerprint instead of stopping the boot.
    const registries = new CommercialRegistries({
      catalogProviders: [createPriceListCatalogProvider({
        name: 'listino-upgrade',
        version: 1,
        priceList: UPGRADE_FIXTURE,
      })],
    });
    assert.doesNotThrow(
      () => registries.persistFingerprints(database),
      `historical form ${historical.slice(0, 12)}… migrates transparently`,
    );
    assert.notEqual(
      registries.getCatalogProvider('listino-upgrade').fingerprint,
      historical,
      'the live fingerprint no longer depends on closure text',
    );
    assert.doesNotThrow(
      () => registries.persistFingerprints(database),
      'the next boot is a no-op verify',
    );
    // Drift protection survived the migration: a silent price change under
    // the frozen version still stops the boot.
    const drifted = structuredClone(UPGRADE_FIXTURE);
    drifted.offers[0].components[0].amountCents = 2000;
    assert.throws(
      () => new CommercialRegistries({
        catalogProviders: [createPriceListCatalogProvider({
          name: 'listino-upgrade',
          version: 1,
          priceList: drifted,
        })],
      }).persistFingerprints(database),
      /source changed after registration/,
    );
  }
});

test('a read-only composition accepts a legacy-registered provider without writing', async () => {
  // A reader rolling out after a writer must keep composing against a
  // database that still carries the old closure-text fingerprint: the
  // read-only verify recognizes the approved historical form and writes
  // nothing. The double has no write path at all, so any write attempt
  // throws and fails the test.
  const stored = [{
    type: 'catalog-provider', name: 'listino-upgrade', version: 1, fingerprint: UPGRADE_FINGERPRINT_271,
  }];
  const database = {
    storage: {
      readOnly: true,
      async many(query) {
        const where = Object.fromEntries((query.where ?? []).map((clause) => [clause.column, clause.value]));
        return stored
          .filter((row) => row.type === where.type && row.name === where.name)
          .map((row) => ({ version: row.version, fingerprint: row.fingerprint }));
      },
    },
  };
  const registries = new CommercialRegistries({
    catalogProviders: [createPriceListCatalogProvider({
      name: 'listino-upgrade', version: 1, priceList: UPGRADE_FIXTURE,
    })],
  });
  await registries.persistFingerprints(database);
  assert.equal(stored[0].fingerprint, UPGRADE_FINGERPRINT_271, 'the legacy row is accepted as-is, never rewritten');
  await assert.rejects(
    new CommercialRegistries({
      catalogProviders: [createPriceListCatalogProvider({
        name: 'listino-upgrade', version: 1, priceList: { ...UPGRADE_FIXTURE, priceBook: { name: 'Altro', currency: 'EUR' } },
      })],
    }).persistFingerprints(database),
    /source changed after registration/,
    'a silent price change under the frozen version still refuses read-only',
  );
});

test('a batch that refuses on drift leaves the legacy row unmoved', (t) => {
  // Classification, migration and verification share one transaction: when
  // another identity in the same batch is genuinely drifted, the refused
  // batch persists nothing — including the legacy move.
  const database = createDatabase({ path: ':memory:' });
  t.after(() => database.close());
  createDefinitionVersionStore(database).persist([
    { type: 'catalog-provider', name: 'listino-upgrade', version: 1, fingerprint: UPGRADE_FINGERPRINT_271 },
    { type: 'discount-policy', name: 'sconto', version: 1, fingerprint: 'e'.repeat(64) },
  ]);
  const registries = new CommercialRegistries({
    catalogProviders: [createPriceListCatalogProvider({
      name: 'listino-upgrade', version: 1, priceList: UPGRADE_FIXTURE,
    })],
    discountPolicies: [{
      name: 'sconto', version: 1, label: 'Sconto', config: { autoApproveMaxBps: 1 }, evaluate: () => ({ decision: 'auto_approve' }),
    }],
  });
  assert.throws(
    () => registries.persistFingerprints(database),
    /source changed after registration/,
    'the drifted discount policy refuses the batch',
  );
  const row = database.raw
    .prepare("SELECT fingerprint FROM definition_versions WHERE type = 'catalog-provider'")
    .get();
  assert.equal(row.fingerprint, UPGRADE_FINGERPRINT_271, 'the legacy move rolled back with the refused batch');
});

test('no parallel catalog: the listino reuses product, price-book and offer', () => {
  assert.deepEqual([...COMMERCIAL_RESOURCES].sort(), [
    'catalog-sync-run', 'offer', 'package-credit', 'price-book', 'price-component', 'price-tier',
    'product', 'product-import', 'product-import-row', 'product-version', 'quote', 'quote-approval',
    'quote-line', 'quote-term', 'quote-version', 'quote-version-component', 'quote-version-line',
    'quote-version-term', 'quote-version-total',
  ].sort(), 'no new commercial resource may arrive with the listino');
  const modulesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'commercial', 'modules');
  const manifests = readdirSync(modulesDir).filter((entry) => entry.endsWith('.module.json'));
  assert.ok(
    manifests.every((entry) => !/price-list|pricelist|listino/i.test(entry)),
    'no new catalog manifest may arrive with the listino',
  );
});
