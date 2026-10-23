import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  createPriceListCatalogProvider,
  validatePriceListConfig,
  PRICE_LIST_CATALOG_CODE_VERSION,
  COMMERCIAL_RESOURCES,
  CommercialRegistries,
} from '../packages/commercial/src/index.js';
import { validateCatalogProvider } from '../packages/commercial/src/registry.js';
import {
  PRICE_LIST_CATALOG_TEMPLATE,
  validatePriceListConstructorTemplate,
} from '../packages/commercial/src/price-list.js';
import { normalizeCatalog } from '../packages/commercial/src/catalog-sync.js';
import { createDatabase } from '../packages/core/src/database.js';
import { computeDefinitionFingerprint, createDefinitionVersionStore } from '../packages/core/index.js';

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

test('a post-construction fetchCatalog swap refuses at composition', async () => {
  // Round 3, P1 registry.js:269: the registry used to accept a replaced
  // fetch under the constructor's versioned scheme, verifying a swapped
  // implementation under a stale pin. Recognition now re-validates the live
  // source on this path, so the swap refuses here — behaviour-identical or
  // not, because the registry cannot verify behaviour, only the pin.
  const built = provider();
  // Same behaviour, different closure text: the #271 class of change (a
  // renamed closed-over variable) plus a comment.
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
  assert.throws(
    () => new CommercialRegistries({ catalogProviders: [{ ...built, fetchCatalog: refactoredFetch }] }),
    /does not match the pinned constructor template/,
    'even a behaviour-identical swap refuses: the pin binds the executed code',
  );
  assert.throws(
    () => new CommercialRegistries({
      catalogProviders: [{ ...built, fetchCatalog: async () => ({ sourceRef: 'evil' }) }],
    }),
    /does not match the pinned constructor template/,
    'a behaviour-differing swap refuses instead of syncing under a stale pin',
  );
  assert.doesNotThrow(
    () => new CommercialRegistries({ catalogProviders: [{ ...built, label: 'Etichetta locale' }] }),
    'a metadata-only spread still composes: recognition survives what compositions do',
  );
});

/**
 * One predicate, every case (review khaoss85/agent-crm#333, rounds 1–3).
 * The earlier cure scattered the constructor-built privilege — fingerprint
 * branched on `codeVersion` alone, identity on a forgeable exported seal,
 * template checked only at construction — and each round patched one point
 * while another leaked. This table holds every case of the earlier rounds
 * and this one against the single recognition predicate
 * (isConstructorBuiltCatalogProvider): pinned constructor version plus a
 * live fetchCatalog source matching the pinned template.
 *
 * Round map: round 1 P1 registry.js:104 (closure edit without a bump goes
 * silent) → rows 'rewritten fetch' and 'bump without a pin move'; round 1
 * P1 store.js:241 (self-supplied history approves drift) → row 'forged
 * history'; round 1 P2 store.js:400 (lost migration race passes silently)
 * → covered at the store unit by 'sweep: a lost migration race …' (both
 * directions) plus the same-transaction rollback row below; round 3 P1
 * :134 (codeVersion alone opts out) → row 'version alone'; round 3 P1 :269
 * (swap verifies under a stale pin) → rows 'rewritten fetch' and
 * 'behaviour-differing swap'; round 3 P2 :61 (forgeable seal) → row
 * 'forged history' plus the no-exported-seal test below (the seal is gone,
 * so there is nothing left to forge).
 */
test('constructor-built recognition is one predicate: every #333 case refuses or verifies', () => {
  const built = provider();
  const sourceFreeFingerprint = computeDefinitionFingerprint({
    type: 'catalog-provider',
    name: built.name,
    version: built.version,
    codeVersion: PRICE_LIST_CATALOG_CODE_VERSION,
    config: built.config,
  });
  // Same behaviour, different closure text: the #271 class of change.
  const rewrittenFetch = Object.assign(
    async (input) => built.fetchCatalog(input),
    {
      toString: () => `${built.fetchCatalog.toString().replaceAll('providerName', 'renamedProvider')}\n    // refactored: behaviour identical, text different`,
    },
  );
  const customFetch = async () => ({ sourceRef: 'custom' });
  const customBase = {
    name: 'custom', version: 1, label: 'Custom', config: { source: 'custom' }, fetchCatalog: customFetch,
  };
  const cases = [
    {
      name: 'constructor output verifies under the source-free scheme',
      definition: built,
      expect: { fingerprint: sourceFreeFingerprint },
    },
    {
      name: 'metadata-only spread stays recognized with the same fingerprint',
      definition: { ...built, label: 'Etichetta locale' },
      expect: { fingerprint: sourceFreeFingerprint },
    },
    {
      name: 'round 3 P1 :269 and round 1 :104 class: behaviour-identical rewritten fetch refuses on the registry path',
      definition: { ...built, fetchCatalog: rewrittenFetch },
      expect: { throws: /does not match the pinned constructor template/ },
    },
    {
      name: 'round 3 P1 :269 scenario: behaviour-differing swapped fetch refuses under the stale pin',
      definition: { ...built, fetchCatalog: async () => ({ sourceRef: 'evil' }) },
      expect: { throws: /does not match the pinned constructor template/ },
    },
    {
      name: 'round 3 P1 :134: a declared codeVersion alone does not opt out of source drift detection',
      definition: { ...customBase, codeVersion: 1 },
      expect: { throws: /reserved for providers built by createPriceListCatalogProvider/ },
    },
    {
      name: 'round 1 store:241 class and round 3 P2 :61: forged constructor fields refuse at composition, never migrate',
      definition: {
        ...customBase,
        codeVersion: 1,
        legacyFetchSources: [customFetch.toString()],
        fetchCatalog: async () => ({ sourceRef: 'custom-b' }),
      },
      expect: { throws: /reserved for providers built by createPriceListCatalogProvider/ },
    },
    {
      name: 'a constructor bump without the matching pin move cannot land',
      definition: { ...built, codeVersion: PRICE_LIST_CATALOG_CODE_VERSION + 1 },
      expect: { throws: /reserved for providers built by createPriceListCatalogProvider/ },
    },
  ];
  for (const row of cases) {
    if (row.expect.fingerprint) {
      const registries = new CommercialRegistries({ catalogProviders: [row.definition] });
      assert.equal(
        registries.getCatalogProvider(row.definition.name).fingerprint,
        row.expect.fingerprint,
        `${row.name}: the scheme excludes closure text, so a pure refactor cannot move the fingerprint`,
      );
    } else {
      assert.throws(
        () => new CommercialRegistries({ catalogProviders: [row.definition] }),
        row.expect.throws,
        row.name,
      );
    }
  }
  // The scheme itself, pinned structurally: the constructor version rides in
  // the fingerprint input (a bump moves it), closure text does not (a
  // refactor cannot). Acceptance 'constructor version changes the
  // fingerprint' holds through the pin, which carries the version with it.
  assert.notEqual(
    computeDefinitionFingerprint({
      type: 'catalog-provider',
      name: built.name,
      version: built.version,
      codeVersion: PRICE_LIST_CATALOG_CODE_VERSION + 1,
      config: built.config,
    }),
    sourceFreeFingerprint,
    'the constructor version rides in the fingerprint input',
  );
  assert.notEqual(
    computeDefinitionFingerprint({
      type: 'catalog-provider',
      name: built.name,
      version: built.version,
      config: built.config,
      fetchCatalog: built.fetchCatalog,
    }),
    sourceFreeFingerprint,
    'the old closure-text scheme differs: the upgrade really changed schemes',
  );
});

test('no forgeable seal remains: recognition is the live source, nothing exported to stamp', async () => {
  // Round 3, P2 registry.js:61: the seal was claimed module-private but the
  // function applying it was a public export, so any importer could approve
  // its own drift. The seal is gone — history is recognized, not stamped.
  const registry = await import('../packages/commercial/src/registry.js');
  assert.equal(
    registry.sealConstructorBuiltCatalogProvider,
    undefined,
    'the forgeable export is gone; check the recognition table above for what grants history now',
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
  // The constructor version moves it through the scheme input — pinned
  // structurally, not by composing a forged bump (a bumped codeVersion
  // without the matching pin move refuses; see the recognition table):
  // recomputing the input with codeVersion + 1 differs from the live print.
  assert.notEqual(
    computeDefinitionFingerprint({
      type: 'catalog-provider',
      name: 'palestra-listino',
      version: 1,
      codeVersion: PRICE_LIST_CATALOG_CODE_VERSION + 1,
      config: provider().config,
    }),
    baseline,
    'constructor version moves the fingerprint',
  );
});

test('the constructor template is pinned: unpinned source refuses at composition', () => {
  const built = provider();
  assert.equal(
    PRICE_LIST_CATALOG_TEMPLATE.codeVersion,
    PRICE_LIST_CATALOG_CODE_VERSION,
    'the pin names the constructor version it was captured at, so the two move together',
  );
  const liveSource = built.fetchCatalog.toString();
  assert.equal(
    createHash('sha256').update(liveSource, 'utf8').digest('hex'),
    PRICE_LIST_CATALOG_TEMPLATE.sourceHash,
    'any edit to the constructor closure — rename or behaviour — must update the pin with it',
  );
  assert.doesNotThrow(
    () => validatePriceListConstructorTemplate(liveSource),
    'the shipped constructor carries its own pin',
  );
  assert.throws(
    () => validatePriceListConstructorTemplate(`${liveSource}\n// behaviour-identical comment`),
    /constructor source changed/,
    'even a comment-only drift refuses until the pin moves with it, instead of passing silently',
  );
});

/**
 * Render characterization at constructor version 1: the oracle is the catalog
 * bytes the closure renders, so a behaviour change to the rendered catalog
 * can only land together with a constructor version bump — and a bump can
 * only land with a behaviour change. Either half alone fails, which is what
 * makes an unbumped behaviour edit visible instead of silent (the fingerprint
 * covers codeVersion, never closure text).
 *
 * Two fixtures, because the gym fixture alone cannot fail for tier or
 * externalId behaviour changes (review khaoss85/agent-crm#333): it covers
 * only flat_fee/per_unit with empty tiers and null externals. The tiered
 * fixture below covers the dimensions the gym one does not — volume and
 * graduated components with non-empty tiers (including a tier-level
 * flatAmountCents), non-null externalId/externalOfferId/externalPriceId,
 * inactive rows, and deactivateMissing — so the same test fails on its oracle
 * for exactly the edits the gym oracle cannot see.
 */
const RENDER_CHARACTERIZATION = {
  codeVersion: 1,
  catalog: {
    sourceRef: 'price-list:palestra-listino',
    priceBooks: [
      {
        sourceKey: 'pricelist.palestra-listino.book',
        name: 'Listino Palestra EUR',
        currency: 'EUR',
        active: true,
      },
    ],
    products: [
      {
        sourceKey: 'pricelist.palestra-listino.product.pacchetto-10-lezioni',
        externalId: null,
        sku: 'pacchetto-10-lezioni',
        name: 'Pacchetto 10 lezioni',
        description: 'Dieci ingressi con istruttore.',
        category: 'pacchetti',
        active: true,
      },
      {
        sourceKey: 'pricelist.palestra-listino.product.abbonamento-mensile',
        externalId: null,
        sku: 'abbonamento-mensile',
        name: 'Abbonamento mensile',
        description: null,
        category: 'abbonamenti',
        active: true,
      },
      {
        sourceKey: 'pricelist.palestra-listino.product.lezione-prova',
        externalId: null,
        sku: 'lezione-prova',
        name: 'Lezione di prova',
        description: null,
        category: 'prove',
        active: true,
      },
      {
        sourceKey: 'pricelist.palestra-listino.product.lezione-singola',
        externalId: null,
        sku: 'lezione-singola',
        name: 'Lezione singola',
        description: null,
        category: 'pacchetti',
        active: true,
      },
    ],
    offers: [
      {
        sourceKey: 'pricelist.palestra-listino.offer.pack-10',
        priceBookSourceKey: 'pricelist.palestra-listino.book',
        productSourceKey: 'pricelist.palestra-listino.product.pacchetto-10-lezioni',
        name: 'Pacchetto 10 lezioni',
        externalOfferId: null,
        active: true,
        components: [
          {
            sourceKey: 'pack-10.prezzo-pacchetto',
            label: 'Prezzo del pacchetto',
            chargeType: 'one_time',
            pricingModel: 'flat_fee',
            interval: null,
            intervalCount: null,
            unitAmountCents: null,
            flatAmountCents: 9900,
            tiers: [],
            externalPriceId: null,
            sourcePricingModel: 'pricelist:flat_fee',
          },
        ],
      },
      {
        sourceKey: 'pricelist.palestra-listino.offer.mensile',
        priceBookSourceKey: 'pricelist.palestra-listino.book',
        productSourceKey: 'pricelist.palestra-listino.product.abbonamento-mensile',
        name: 'Abbonamento mensile',
        externalOfferId: null,
        active: true,
        components: [
          {
            sourceKey: 'mensile.canone',
            label: 'Canone mensile',
            chargeType: 'recurring',
            pricingModel: 'flat_fee',
            interval: 'month',
            intervalCount: 1,
            unitAmountCents: null,
            flatAmountCents: 4900,
            tiers: [],
            externalPriceId: null,
            sourcePricingModel: 'pricelist:flat_fee',
          },
        ],
      },
      {
        sourceKey: 'pricelist.palestra-listino.offer.prova',
        priceBookSourceKey: 'pricelist.palestra-listino.book',
        productSourceKey: 'pricelist.palestra-listino.product.lezione-prova',
        name: 'Lezione di prova',
        externalOfferId: null,
        active: true,
        components: [
          {
            sourceKey: 'prova.prezzo-prova',
            label: 'Prezzo della prova',
            chargeType: 'one_time',
            pricingModel: 'flat_fee',
            interval: null,
            intervalCount: null,
            unitAmountCents: null,
            flatAmountCents: 1000,
            tiers: [],
            externalPriceId: null,
            sourcePricingModel: 'pricelist:flat_fee',
          },
        ],
      },
      {
        sourceKey: 'pricelist.palestra-listino.offer.singola',
        priceBookSourceKey: 'pricelist.palestra-listino.book',
        productSourceKey: 'pricelist.palestra-listino.product.lezione-singola',
        name: 'Lezione singola',
        externalOfferId: null,
        active: true,
        components: [
          {
            sourceKey: 'singola.prezzo-lezione',
            label: 'Prezzo per lezione',
            chargeType: 'one_time',
            pricingModel: 'per_unit',
            interval: null,
            intervalCount: null,
            unitAmountCents: 1200,
            flatAmountCents: null,
            tiers: [],
            externalPriceId: null,
            sourcePricingModel: 'pricelist:per_unit',
          },
        ],
      },
    ],
  },
};

/**
 * Second render fixture: the behaviour dimensions the gym fixture does not
 * exercise (see the characterization comment above). Frozen like the gym
 * oracle — never edit this value except together with a constructor bump,
 * and the test below enforces that the two move together on this fixture too.
 */
const TIERED_PRICE_LIST = {
  priceBook: { name: 'Listino Soglie EUR', currency: 'EUR', active: false },
  products: [
    {
      key: 'corso-nuoto', name: 'Corso nuoto', sku: 'nuoto-sku-01',
      description: 'Corso di nuoto in piscina coperta.', category: 'corsi',
      externalId: 'stripe-prod-nuoto', active: false,
    },
    { key: 'ingressi', name: 'Ingressi', externalId: 'stripe-prod-ingressi' },
  ],
  offers: [
    {
      key: 'nuoto', product: 'corso-nuoto', name: 'Corso nuoto mensile',
      externalOfferId: 'stripe-offer-nuoto', active: false,
      components: [{
        key: 'soglie', label: 'Soglie volume', charge: 'recurring', model: 'volume',
        interval: 'month', intervalCount: 1,
        tiers: [
          { upTo: 10, unitAmountCents: 1000, flatAmountCents: 50 },
          { upTo: null, unitAmountCents: 800 },
        ],
        externalPriceId: 'stripe-price-volume-1',
      }],
    },
    {
      key: 'ingressi-off', product: 'ingressi', name: 'Carnet ingressi',
      externalOfferId: 'stripe-offer-ingressi',
      components: [{
        key: 'scaglioni', label: 'Scaglioni', charge: 'one_time', model: 'graduated',
        tiers: [
          { upTo: 5, unitAmountCents: 1200 },
          { upTo: null, unitAmountCents: 900, flatAmountCents: 100 },
        ],
        externalPriceId: 'stripe-price-grad-1',
      }],
    },
  ],
};

const tieredProvider = (overrides = {}) => createPriceListCatalogProvider({
  name: 'palestra-soglie',
  version: 1,
  priceList: TIERED_PRICE_LIST,
  deactivateMissing: true,
  ...overrides,
});

const TIERED_RENDER_CHARACTERIZATION = {
  codeVersion: 1,
  catalog: {
    sourceRef: 'price-list:palestra-soglie',
    priceBooks: [
      {
        sourceKey: 'pricelist.palestra-soglie.book',
        name: 'Listino Soglie EUR',
        currency: 'EUR',
        active: false,
      },
    ],
    products: [
      {
        sourceKey: 'pricelist.palestra-soglie.product.corso-nuoto',
        externalId: 'stripe-prod-nuoto',
        sku: 'nuoto-sku-01',
        name: 'Corso nuoto',
        description: 'Corso di nuoto in piscina coperta.',
        category: 'corsi',
        active: false,
      },
      {
        sourceKey: 'pricelist.palestra-soglie.product.ingressi',
        externalId: 'stripe-prod-ingressi',
        sku: 'ingressi',
        name: 'Ingressi',
        description: null,
        category: null,
        active: true,
      },
    ],
    offers: [
      {
        sourceKey: 'pricelist.palestra-soglie.offer.nuoto',
        priceBookSourceKey: 'pricelist.palestra-soglie.book',
        productSourceKey: 'pricelist.palestra-soglie.product.corso-nuoto',
        name: 'Corso nuoto mensile',
        externalOfferId: 'stripe-offer-nuoto',
        active: false,
        components: [
          {
            sourceKey: 'nuoto.soglie',
            label: 'Soglie volume',
            chargeType: 'recurring',
            pricingModel: 'volume',
            interval: 'month',
            intervalCount: 1,
            unitAmountCents: null,
            flatAmountCents: null,
            tiers: [
              { upTo: 10, unitAmountCents: 1000, flatAmountCents: 50 },
              { upTo: null, unitAmountCents: 800, flatAmountCents: 0 },
            ],
            externalPriceId: 'stripe-price-volume-1',
            sourcePricingModel: 'pricelist:volume',
          },
        ],
      },
      {
        sourceKey: 'pricelist.palestra-soglie.offer.ingressi-off',
        priceBookSourceKey: 'pricelist.palestra-soglie.book',
        productSourceKey: 'pricelist.palestra-soglie.product.ingressi',
        name: 'Carnet ingressi',
        externalOfferId: 'stripe-offer-ingressi',
        active: true,
        components: [
          {
            sourceKey: 'ingressi-off.scaglioni',
            label: 'Scaglioni',
            chargeType: 'one_time',
            pricingModel: 'graduated',
            interval: null,
            intervalCount: null,
            unitAmountCents: null,
            flatAmountCents: null,
            tiers: [
              { upTo: 5, unitAmountCents: 1200, flatAmountCents: 0 },
              { upTo: null, unitAmountCents: 900, flatAmountCents: 100 },
            ],
            externalPriceId: 'stripe-price-grad-1',
            sourcePricingModel: 'pricelist:graduated',
          },
        ],
      },
    ],
  },
};

test('a render change and a constructor bump move together, neither alone', async () => {
  // JSON round-trip: the render carries undefined-valued fields on some
  // shapes, which carry no information and would make the comparison about
  // key presence instead of behaviour.
  const fixtures = [
    { name: 'gym', build: () => provider(), expected: RENDER_CHARACTERIZATION },
    { name: 'tiered', build: () => tieredProvider(), expected: TIERED_RENDER_CHARACTERIZATION },
  ];
  assert.equal(
    tieredProvider().config.deactivateMissing,
    true,
    'the tiered fixture exercises the deactivateMissing config dimension',
  );
  for (const fixture of fixtures) {
    const rendered = JSON.parse(JSON.stringify(await fixture.build().fetchCatalog({})));
    const renderedSame = isDeepStrictEqual(rendered, fixture.expected.catalog);
    assert.equal(
      renderedSame,
      PRICE_LIST_CATALOG_CODE_VERSION === fixture.expected.codeVersion,
      `${fixture.name}: a behaviour change to the rendered catalog ships with a constructor version bump, `
      + 'and a bump ships with a behaviour change — an unbumped behaviour edit fails here, not silently in production',
    );
  }
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

test('a custom provider cannot approve its own drift as history', () => {
  // The transparent upgrade is a privilege of the constructor-built price
  // list, not of any provider that declares history: a custom provider that
  // rewrites its closure and carries the old source in legacyFetchSources
  // refuses at composition — since round 3 there is no seal to forge, so the
  // forged constructor fields never reach the persist path, let alone
  // migrate a row.
  const oldSource = 'async () => ({ sourceRef: "custom-a" })';
  const config = { source: 'custom' };
  assert.throws(
    () => new CommercialRegistries({
      catalogProviders: [{
        name: 'custom',
        version: 1,
        config,
        codeVersion: 1,
        legacyFetchSources: [oldSource],
        fetchCatalog: async () => ({ sourceRef: 'custom-b' }),
      }],
    }),
    /reserved for providers built by createPriceListCatalogProvider/,
    'self-supplied history refuses at composition, never migrates itself',
  );
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
