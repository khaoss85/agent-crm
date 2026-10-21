// @ts-check

/**
 * BO-F2-05 Stripe price source (backlog:179ef35f8676): the three acceptance
 * criteria, each proven against the real composition.
 *
 * 1. sync from the fake Stripe adapter lands in `product` with the source
 *    marked (sourceKind provider, provider name, Stripe external ids);
 * 2. with the price source active the price is not modifiable — every manual
 *    mutation of a provider-owned row refuses with PROVIDER_PRICE_READONLY;
 * 3. without Stripe the manual catalog works end to end (create, describe,
 *    reprice, activate, table read with filters).
 *
 * The Stripe client is a fake (owner decision: no credentials yet); the
 * mapping is what the real adapter reuses. The oracle for the mapping shape
 * is `normalizeCatalog`, the same validator catalog sync runs — not a copy
 * of its rules.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createFixtureStripeCatalogClient,
  createStripeCatalogProvider,
} from '../packages/commercial/src/stripe-catalog.js';
import { normalizeCatalog } from '../packages/commercial/src/catalog-sync.js';
import { boot } from './helpers/contracts-project.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const ACTOR = { type: 'user', id: 'stripe-catalog-test' };

const COMMERCIAL_MANIFESTS = [
  'product.module.json', 'product-version.module.json', 'price-book.module.json',
  'offer.module.json', 'price-component.module.json', 'price-tier.module.json',
  'catalog-sync-run.module.json', 'quote.module.json', 'quote-line.module.json',
  'quote-version.module.json', 'quote-version-line.module.json',
  'quote-version-component.module.json', 'quote-version-total.module.json',
  'quote-approval.module.json',
];

function applyManifests(root) {
  for (const manifest of COMMERCIAL_MANIFESTS) {
    const result = spawnSync(
      process.execPath,
      ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), 'module', 'create', join(root, 'packages/commercial/modules', manifest), '--apply', '--root', root],
      { encoding: 'utf8', cwd: root },
    );
    assert.equal(result.status, 0, `apply ${manifest}: ${result.stderr}`);
  }
  writeFileSync(join(root, 'packages/actions/generated/index.js'), 'export const generatedActions = [];\n');
}

function compose(root, providersSource) {
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createCommercialDomain } from '../../commercial/src/index.js';",
    providersSource,
    'export const generatedDomains = [',
    '  createCommercialDomain({ catalogProviders }),',
    '];',
    '',
  ].join('\n'));
}

function stripeComposition() {
  return [
    "import { createStripeCatalogProvider, createFixtureStripeCatalogClient } from '../../commercial/src/index.js';",
    'const catalogProviders = [createStripeCatalogProvider({ name: \'stripe-test\', version: 1, stripe: createFixtureStripeCatalogClient() })];',
  ].join('\n');
}

async function bootApp(root) {
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  return createAccordoApp({ dbPath: ':memory:' });
}

function stripeProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-stripe-catalog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  applyManifests(root);
  compose(root, stripeComposition());
  return root;
}

function manualProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-manual-catalog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  applyManifests(root);
  compose(root, 'const catalogProviders = [];');
  return root;
}

const MANUAL_COMPONENT = {
  key: 'canone',
  label: 'Canone mensile',
  chargeType: 'recurring',
  pricingModel: 'flat_fee',
  interval: 'month',
  intervalCount: 1,
  flatAmountCents: 4900,
};

test('stripe fixture maps to the normalized catalog the sync validates', async () => {
  const provider = createStripeCatalogProvider({ name: 'stripe-test', version: 1, stripe: createFixtureStripeCatalogClient() });
  const catalog = normalizeCatalog(await provider.fetchCatalog({}));
  assert.deepEqual(Object.keys(catalog).sort(), ['offers', 'priceBooks', 'products', 'sourceRef']);
  assert.equal(catalog.sourceRef, 'stripe:stripe-test');
  assert.equal(catalog.priceBooks.length, 1);
  assert.equal(catalog.priceBooks[0].currency, 'EUR');
  // Three Stripe products mirror, including the inactive one (visible as not
  // active); the inactive price never syncs (it is not sellable).
  assert.equal(catalog.products.length, 3);
  const yoga = catalog.products.find((product) => product.externalId === 'prod_yoga');
  assert.equal(yoga.sku, 'YOGA');
  assert.equal(yoga.category, 'corsi');
  assert.equal(yoga.active, true);
  const sala = catalog.products.find((product) => product.externalId === 'prod_sala');
  assert.equal(sala.active, false);
  assert.ok(catalog.products.every((product) => product.sourceKey.startsWith('stripe.stripe-test.product.')));
  // One offer per price: 7 prices minus the inactive one = 6 offers; metered
  // and weekly recurrences close only their own offer, siblings stay quotable.
  assert.equal(catalog.offers.length, 6);
  // Unsupported offers normalize to zero components, so the index is the
  // offer source key (one offer per Stripe price) rather than the price id.
  const byPrice = new Map(catalog.offers.map((offer) => [offer.sourceKey.split('.').at(-1), offer]));
  assert.equal(byPrice.get('price_yoga_mese').quoteEligible, true);
  const metered = byPrice.get('price_yoga_misurato');
  assert.equal(metered.quoteEligible, false);
  assert.match(metered.unsupportedReason, /metered/);
  assert.equal(metered.components.length, 0);
  const weekly = byPrice.get('price_yoga_settimanale');
  assert.equal(weekly.quoteEligible, false);
  assert.match(weekly.unsupportedReason, /recurring-interval/);
  // Provenance survives: Stripe ids and the Stripe pricing model ride along.
  const monthly = byPrice.get('price_yoga_mese');
  assert.equal(monthly.components[0].externalPriceId, 'price_yoga_mese');
  assert.equal(monthly.components[0].sourcePricingModel, 'stripe:recurring.per_unit');
  const volume = byPrice.get('price_pilates_pacchetto');
  assert.equal(volume.components[0].pricingModel, 'volume');
  assert.deepEqual(volume.components[0].tiers.map((tier) => tier.upTo), [10, null]);
  const graduated = byPrice.get('price_pilates_giornaliero');
  assert.equal(graduated.components[0].pricingModel, 'graduated');
  assert.equal(graduated.components[0].interval, 'month');
});

test('stripe garbage fails closed as provider invalid, never half-mapped', async () => {
  const provider = createStripeCatalogProvider({
    name: 'stripe-test',
    version: 1,
    stripe: {
      async listProducts() { return [{ id: 'prod_ok', name: 'Ok', active: true }]; },
      async listPrices() { return [{ id: 'price_bad', product: 'prod_ok', active: true, currency: 'eur', unit_amount: -5 }]; },
    },
  });
  await assert.rejects(
    () => provider.fetchCatalog({}).then((catalog) => normalizeCatalog(catalog)),
    (error) => error.code === 'PROVIDER_INVALID',
  );
});

test('stripe ids differing only in case refuse instead of merging', async () => {
  const provider = createStripeCatalogProvider({
    name: 'stripe-test',
    version: 1,
    stripe: {
      async listProducts() {
        return [
          { id: 'prod_A', name: 'A', active: true },
          { id: 'prod_a', name: 'a', active: true },
        ];
      },
      async listPrices() { return []; },
    },
  });
  await assert.rejects(
    () => provider.fetchCatalog({}),
    (error) => error.code === 'PROVIDER_INVALID',
  );
});

test('metered follows real Stripe: usage_type metered is unsupported, licensed quotes normally', async () => {
  const provider = createStripeCatalogProvider({
    name: 'stripe-test',
    version: 1,
    stripe: {
      async listProducts() { return [{ id: 'prod_m', name: 'Metered', active: true }]; },
      async listPrices() {
        return [
          { id: 'price_metered', product: 'prod_m', active: true, currency: 'eur', unit_amount: 100, billing_scheme: 'per_unit', recurring: { interval: 'month', interval_count: 1, usage_type: 'metered' } },
          { id: 'price_licensed', product: 'prod_m', active: true, currency: 'eur', unit_amount: 200, billing_scheme: 'per_unit', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } },
        ];
      },
    },
  });
  const catalog = normalizeCatalog(await provider.fetchCatalog({}));
  const byPrice = new Map(catalog.offers.map((offer) => [offer.sourceKey.split('.').at(-1), offer]));
  const metered = byPrice.get('price_metered');
  assert.equal(metered.quoteEligible, false);
  assert.match(metered.unsupportedReason, /metered/);
  assert.equal(byPrice.get('price_licensed').quoteEligible, true);
});

function flipProject(t, initialPrices) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-stripe-flip-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  applyManifests(root);
  writeFileSync(join(root, 'flip-fixture.mjs'), [
    `let prices = ${JSON.stringify(initialPrices)};`,
    'export const stripe = {',
    "  source: 'flip-fixture',",
    "  async listProducts() { return [{ id: 'prod_flip', name: 'Flip', active: true }]; },",
    '  async listPrices() { return structuredClone(prices); },',
    '};',
    'export function setPrices(next) { prices = next; }',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createCommercialDomain } from '../../commercial/src/index.js';",
    "import { createStripeCatalogProvider } from '../../commercial/src/index.js';",
    "import { stripe } from '../../../flip-fixture.mjs';",
    'const catalogProviders = [createStripeCatalogProvider({ name: \'stripe-flip\', version: 1, stripe })];',
    'export const generatedDomains = [',
    '  createCommercialDomain({ catalogProviders }),',
    '];',
    '',
  ].join('\n'));
  return root;
}

test('a Stripe price flipped inactive deactivates the offer the earlier sync created', async (t) => {
  const root = flipProject(t, [
    { id: 'price_flip', product: 'prod_flip', active: true, currency: 'eur', unit_amount: 3000, billing_scheme: 'per_unit' },
  ]);
  const app = await bootApp(root);
  t.after(() => app.close());
  const first = await app.syncCatalog({ provider: 'stripe-flip', actor: ACTOR });
  assert.equal(first.counts.offersCreated, 1);
  const { setPrices } = await import(pathToFileURL(join(root, 'flip-fixture.mjs')).href);
  setPrices([
    { id: 'price_flip', product: 'prod_flip', active: false, currency: 'eur', unit_amount: 3000, billing_scheme: 'per_unit' },
  ]);
  const second = await app.syncCatalog({ provider: 'stripe-flip', actor: ACTOR });
  assert.ok(second.counts.deactivated >= 1, 'the missing offer deactivates');
  const offers = app.modules.get('offer').service.listWhere({});
  assert.ok(offers.length >= 1);
  assert.ok(offers.every((offer) => offer.active === false), 'no quotable offer survives its source');
  const table = await app.listCatalogProducts({});
  assert.equal(table.products[0].offers.filter((offer) => offer.active).length, 0);
});

function archiveProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-stripe-archive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  applyManifests(root);
  writeFileSync(join(root, 'archive-fixture.mjs'), [
    'let products = [{ id: \'prod_arch\', name: \'Archiviabile\', active: true }];',
    'export const stripe = {',
    "  source: 'archive-fixture',",
    '  async listProducts() { return structuredClone(products); },',
    '  async listPrices() { return [{ id: \'price_arch\', product: \'prod_arch\', active: true, currency: \'eur\', unit_amount: 5000, billing_scheme: \'per_unit\' }]; },',
    '};',
    'export function setProducts(next) { products = next; }',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createCommercialDomain } from '../../commercial/src/index.js';",
    "import { createStripeCatalogProvider } from '../../commercial/src/index.js';",
    "import { stripe } from '../../../archive-fixture.mjs';",
    'const catalogProviders = [createStripeCatalogProvider({ name: \'stripe-archive\', version: 1, stripe })];',
    'export const generatedDomains = [',
    '  createCommercialDomain({ catalogProviders }),',
    '];',
    '',
  ].join('\n'));
  return root;
}

test('an archived Stripe product leaves no quotable offer: sync deactivates them and add-line refuses', async (t) => {
  const root = archiveProject(t);
  const instance = await boot(root, join(root, 'data', 'stripe-archive.sqlite'));
  t.after(() => instance.close().catch(() => {}));
  const { app, client } = instance;
  await app.syncCatalog({ provider: 'stripe-archive', actor: ACTOR });

  // A live offer quotes normally before the archive (the product gate stays green).
  const book = app.modules.get('price-book').service.listWhere({})[0];
  const company = await app.services.companies.create({ name: 'Co Archive' }, { actor: ACTOR });
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, name: 'Archive deal', type: 'new_business', valueCents: 100000, currency: 'EUR', stage: 'discovery', owner: 'archive-test' },
    { actor: ACTOR },
  );
  const created = await client.request(`/api/modules/opportunity/records/${opportunity.id}/actions/create-quote`, { method: 'POST', body: { priceBookId: book.id } });
  const quoteId = created.result.quote.id;
  const liveOffer = app.modules.get('offer').service.listWhere({ active: true })[0];
  assert.ok(liveOffer, 'the sync leaves one active offer');
  const line = await client.module('quote').action(quoteId, 'add-line', { offerId: liveOffer.id, quantity: 1 });
  assert.ok(line.result.line.id, 'an active offer of an active product quotes');

  // Archive the product in Stripe and re-sync: its offers deactivate with it.
  const { setProducts } = await import(pathToFileURL(join(root, 'archive-fixture.mjs')).href);
  setProducts([{ id: 'prod_arch', name: 'Archiviabile', active: false }]);
  await app.syncCatalog({ provider: 'stripe-archive', actor: ACTOR });
  const offers = app.modules.get('offer').service.listWhere({});
  assert.ok(offers.length >= 1);
  assert.ok(offers.every((offer) => offer.active === false), 'no active offer survives the product archive');
  const table = await app.listCatalogProducts({});
  assert.equal(table.products[0].active, false);
  assert.equal(table.products[0].offers.filter((offer) => offer.active).length, 0);

  // The synced revision refuses with OFFER_INACTIVE …
  await assert.rejects(
    () => client.module('quote').action(quoteId, 'add-line', { offerId: liveOffer.id, quantity: 1 }),
    (error) => error.code === 'OFFER_INACTIVE',
    'an offer of an archived product is not quotable',
  );

  // … and even a stale active row cannot quote once the product is inactive.
  const stale = offers[0];
  await app.modules.get('offer').service.applyManaged(stale.id, { active: true });
  await assert.rejects(
    () => client.module('quote').action(quoteId, 'add-line', { offerId: stale.id, quantity: 1 }),
    (error) => error.code === 'PRODUCT_INACTIVE',
    'quoting gates on product.active, not only offer.active',
  );
});

test('manual mutations refuse without an accountable actor', async (t) => {
  const app = await bootApp(manualProject(t));
  t.after(() => app.close());
  await assert.rejects(
    () => app.createManualProduct({ sku: 'NO-ACTOR', name: 'No actor', currency: 'EUR', components: [MANUAL_COMPONENT] }, undefined),
    (error) => error.code === 'VALIDATION_FAILED' || /actor/i.test(error.message),
    'an omitted actor never creates a product',
  );
  const open = await app.listCatalogProducts({});
  assert.ok(Array.isArray(open.products), 'reads stay open: only mutations gate the actor');
});

test('the source summary survives filters: source=manual still reports a synced Stripe source', async (t) => {
  const app = await bootApp(stripeProject(t));
  t.after(() => app.close());
  await app.syncCatalog({ provider: 'stripe-test', actor: ACTOR });
  const filtered = await app.listCatalogProducts({ source: 'manual' });
  assert.equal(filtered.products.length, 0, 'no manual rows in the fixture sync');
  assert.equal(filtered.summary.stripeConnected, true, 'the invite logic reads the whole catalog, not the page');
});

test('every manual write leaves a catalog.manual trace', async (t) => {
  const app = await bootApp(manualProject(t));
  t.after(() => app.close());
  const before = app.workflows.listRuns({ workflowName: 'catalog.manual', limit: 500 }).length;
  await app.createManualProduct({
    sku: 'TRACE-1', name: 'Traced', currency: 'EUR', components: [MANUAL_COMPONENT],
  }, ACTOR);
  const runs = app.workflows.listRuns({ workflowName: 'catalog.manual', limit: 500 });
  assert.equal(runs.length, before + 1);
  assert.equal(runs[0].status, 'completed');
});

test('acceptance 1: sync from the fake Stripe adapter marks the source on product rows', async (t) => {
  const app = await bootApp(stripeProject(t));
  t.after(() => app.close());
  const sync = await app.syncCatalog({ provider: 'stripe-test', actor: ACTOR });
  assert.equal(sync.provider, 'stripe-test');
  assert.ok(sync.runId, 'a CatalogSyncRun records the evidence');

  const products = app.modules.get('product').service.listWhere({});
  assert.ok(products.length >= 3, 'Stripe products land in product');
  for (const product of products) {
    assert.equal(product.sourceKind, 'provider');
    assert.equal(product.provider, 'stripe-test');
    assert.match(product.externalId ?? '', /^prod_/);
  }
  const runs = app.modules.get('catalog-sync-run').service.listWhere({});
  assert.equal(runs.length, 1);

  const table = await app.listCatalogProducts({});
  const yoga = table.products.find((row) => row.sku === 'YOGA');
  assert.ok(yoga, 'the backoffice table reads the synced product');
  assert.equal(yoga.source, 'stripe-test');
  assert.equal(yoga.priceReadOnly, true);
  assert.equal(table.summary.stripeConnected, true);
});

test('acceptance 2: with the price source active the price is not modifiable', async (t) => {
  const app = await bootApp(stripeProject(t));
  t.after(() => app.close());
  await app.syncCatalog({ provider: 'stripe-test', actor: ACTOR });
  const table = await app.listCatalogProducts({});
  const yoga = table.products.find((row) => row.sku === 'YOGA');
  assert.ok(yoga);
  const offerId = yoga.offers[0].offerId;

  await assert.rejects(
    () => app.setManualPrices({ productId: yoga.productId, offerIds: [offerId], offers: [{ name: 'Hacked', components: [MANUAL_COMPONENT] }] }, ACTOR),
    (error) => error.code === 'PROVIDER_PRICE_READONLY',
    're-pricing a Stripe-owned offer refuses',
  );
  await assert.rejects(
    () => app.updateManualProduct({ productId: yoga.productId, name: 'Hacked' }, ACTOR),
    (error) => error.code === 'PROVIDER_PRICE_READONLY',
    'renaming a Stripe-owned product refuses',
  );
  await assert.rejects(
    () => app.setManualProductActive({ productId: yoga.productId, active: false }, ACTOR),
    (error) => error.code === 'PROVIDER_PRICE_READONLY',
    'deactivating a Stripe-owned product refuses',
  );
  const books = app.modules.get('price-book').service.listWhere({});
  const stripeBook = books.find((book) => book.sourceKind === 'provider');
  assert.ok(stripeBook, 'a provider book exists to prove the booking guard');
  await assert.rejects(
    () => app.createManualProduct({ sku: 'X', name: 'X', currency: 'EUR', priceBookId: stripeBook.id, components: [MANUAL_COMPONENT] }, ACTOR),
    (error) => error.code === 'PROVIDER_PRICE_READONLY',
    'manual products never land in a provider book',
  );
});

test('the catalog routes serve the backoffice over HTTP', async (t) => {
  const root = stripeProject(t);
  const instance = await boot(root, join(root, 'data', 'stripe-http.sqlite'));
  t.after(() => instance.close().catch(() => {}));
  const { app, client } = instance;
  await app.syncCatalog({ provider: 'stripe-test', actor: ACTOR });

  const table = await client.request('/api/catalog/products?source=stripe-test', { method: 'GET' });
  assert.ok(Array.isArray(table.products), 'the table reads over HTTP');
  assert.equal(table.summary.stripeConnected, true);
  assert.ok(table.products.every((row) => row.priceReadOnly === true));
  const filtered = await client.request('/api/catalog/products?category=corsi&active=true', { method: 'GET' });
  assert.ok(filtered.products.length >= 2, 'category and active filters work over HTTP');
  assert.ok(filtered.products.every((row) => row.category === 'corsi' && row.active === true));

  const yoga = table.products.find((row) => row.sku === 'YOGA');
  const refused = await client.request(`/api/catalog/products/${yoga.productId}/prices`, {
    method: 'POST',
    body: { offerIds: [yoga.offers[0].offerId], offers: [{ name: 'Hacked', components: [MANUAL_COMPONENT] }] },
  }).then(
    () => null,
    (error) => error,
  );
  assert.ok(refused, 're-pricing a Stripe-owned offer refuses over HTTP too');
  assert.equal(refused.code, 'PROVIDER_PRICE_READONLY');
  assert.equal(refused.status, 409);

  const created = await client.request('/api/catalog/products', {
    method: 'POST',
    body: { sku: 'HTTP-1', name: 'Via HTTP', currency: 'EUR', components: [MANUAL_COMPONENT] },
  });
  assert.ok(created.product.id, 'manual creation works over HTTP without any Stripe');
  const reread = await client.request('/api/catalog/products?source=manual', { method: 'GET' });
  assert.equal(reread.products.length, 1);
  assert.equal(reread.products[0].sku, 'HTTP-1');
});

test('acceptance 3: without Stripe the manual catalog works end to end', async (t) => {
  const app = await bootApp(manualProject(t));
  t.after(() => app.close());
  assert.equal((await app.listCatalogProducts({})).summary.stripeConnected, false);

  const PACK_COMPONENT = {
    key: 'pacchetto',
    label: 'Prezzo del pacchetto',
    chargeType: 'one_time',
    pricingModel: 'flat_fee',
    flatAmountCents: 9900,
  };
  const created = await app.createManualProduct({
    sku: 'YOGA-10',
    name: 'Pacchetto 10 lezioni',
    description: 'Dieci ingressi con istruttore.',
    category: 'pacchetti',
    currency: 'EUR',
    components: [PACK_COMPONENT],
  }, ACTOR);
  assert.ok(created.product.id);
  assert.equal(created.priceBook.currency, 'EUR');
  assert.equal(created.offers.length, 1);

  // The table serves the backoffice (fonte, attivo, category filter).
  const table = await app.listCatalogProducts({});
  assert.equal(table.products.length, 1);
  assert.equal(table.products[0].source, 'manual');
  assert.equal(table.products[0].priceReadOnly, false);
  assert.equal(table.products[0].offers[0].components[0].flatAmountCents, 9900);
  assert.equal(table.summary.manual, 1);
  assert.equal((await app.listCatalogProducts({ category: 'pacchetti' })).products.length, 1);
  assert.equal((await app.listCatalogProducts({ category: 'abbonamenti' })).products.length, 0);
  assert.equal((await app.listCatalogProducts({ source: 'manual' })).products.length, 1);
  assert.equal((await app.listCatalogProducts({ active: false })).products.length, 0);

  // Describe: version 2, history kept.
  const updated = await app.updateManualProduct({ productId: created.product.id, name: 'Pacchetto 10 lezioni plus' }, ACTOR);
  assert.equal(updated.product.version, 2);
  assert.equal(updated.unchanged, false);
  const same = await app.updateManualProduct({ productId: created.product.id, name: 'Pacchetto 10 lezioni plus' }, ACTOR);
  assert.equal(same.unchanged, true);

  // Reprice: revision 2, the previous revision deactivates.
  const offerId = created.offers[0].id;
  const repriced = await app.setManualPrices({
    productId: created.product.id,
    offerIds: [offerId],
    offers: [{ name: 'Pacchetto 10 lezioni', components: [{ ...PACK_COMPONENT, flatAmountCents: 10900 }] }],
  }, ACTOR);
  assert.equal(repriced.offers[0].revision, 2);
  const revisions = app.modules.get('offer').service.listWhere({ productId: created.product.id });
  assert.equal(revisions.length, 2);
  assert.deepEqual(revisions.map((row) => row.active).sort(), [false, true]);

  // A manual price on the same offer quotes through the server-priced path.
  const current = (await app.listCatalogProducts({})).products[0].offers[0];
  assert.equal(current.components[0].flatAmountCents, 10900);

  // Deactivate: product and current offers go inactive together.
  const deactivated = await app.setManualProductActive({ productId: created.product.id, active: false }, ACTOR);
  assert.equal(deactivated.product.active, false);
  assert.equal((await app.listCatalogProducts({ active: false })).products.length, 1);
  assert.equal((await app.listCatalogProducts({ active: true })).products.length, 0);

  // Incoherent prices fail closed with the field path, never half-written.
  await assert.rejects(
    () => app.createManualProduct({
      sku: 'BAD',
      name: 'Bad',
      currency: 'EUR',
      components: [{ ...MANUAL_COMPONENT, key: 'bad', pricingModel: 'flat_fee', unitAmountCents: 100 }],
    }, ACTOR),
    /flat_fee/,
  );
});

test('setManualPrices refuses a stale offer revision instead of forking history', async (t) => {
  const app = await bootApp(manualProject(t));
  t.after(() => app.close());
  const created = await app.createManualProduct({
    sku: 'STALE-1', name: 'Stale', currency: 'EUR', components: [MANUAL_COMPONENT],
  }, ACTOR);
  const rev1 = created.offers[0].id;
  const repriced = await app.setManualPrices({
    productId: created.product.id,
    offerIds: [rev1],
    offers: [{ name: 'Stale', components: [{ ...MANUAL_COMPONENT, flatAmountCents: 10900 }] }],
  }, ACTOR);
  assert.equal(repriced.offers[0].revision, 2, 'the reprice opens revision 2');

  // The superseded revision id no longer replaces anything: the caller re-reads.
  await assert.rejects(
    () => app.setManualPrices({
      productId: created.product.id,
      offerIds: [rev1],
      offers: [{ name: 'Stale', components: [{ ...MANUAL_COMPONENT, flatAmountCents: 11900 }] }],
    }, ACTOR),
    (error) => error.code === 'STALE_REVISION' && error.status === 409,
    'a stale offerIds entry refuses fail-closed, never a unique-violation rollback',
  );
  const revisions = app.modules.get('offer').service.listWhere({ productId: created.product.id });
  assert.equal(revisions.length, 2, 'the refused write leaves history untouched');
});
