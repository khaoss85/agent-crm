import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Milestone 10 e2e: catalog sync, server-priced quotes, immutable quote
 * versions and human discount approval — proven in a clean throwaway project
 * with the real CLI/factory, HTTP server and SDK against the deterministic
 * fixture catalog provider (no network).
 */
const COMMERCIAL_MANIFESTS = [
  'product.module.json',
  'product-version.module.json',
  'price-book.module.json',
  'offer.module.json',
  'price-component.module.json',
  'price-tier.module.json',
  'catalog-sync-run.module.json',
  'quote.module.json',
  'quote-line.module.json',
  'quote-version.module.json',
  'quote-version-line.module.json',
  'quote-version-component.module.json',
  'quote-version-total.module.json',
  'quote-approval.module.json',
];

const COMMERCIAL_MODULES = [
  'product', 'product-version', 'price-book', 'offer', 'price-component', 'price-tier',
  'catalog-sync-run', 'quote', 'quote-line', 'quote-version', 'quote-version-line',
  'quote-version-component', 'quote-version-total', 'quote-approval',
];

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-commercial-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  const starter = join(root, 'examples/starters/b2b-lead-qualification');
  for (const manifest of COMMERCIAL_MANIFESTS) {
    assert.equal(cli(root, ['module', 'create', join(starter, manifest), '--apply']).status, 0, `apply ${manifest}`);
  }
  writeFileSync(
    join(root, 'packages/actions/generated/index.js'),
    [
      '// @ts-check',
      "import { buildCommercialActions } from '../../core/src/commercial-actions.js';",
      'export const generatedActions = [...buildCommercialActions()];',
      '',
    ].join('\n'),
  );
  writeCommercialIndex(root);
  return root;
}

function writeCommercialIndex(root) {
  writeFileSync(
    join(root, 'packages/commercial/generated/index.js'),
    [
      '// @ts-check',
      "import { fixtureSaasCatalogProvider, standardSalesDiscountV1, standardSalesDiscountV2 } from '../../../examples/starters/b2b-lead-qualification/commercial.js';",
      'export const generatedCatalogProviders = [fixtureSaasCatalogProvider];',
      'export const generatedDiscountPolicies = [standardSalesDiscountV1, standardSalesDiscountV2];',
      '',
    ].join('\n'),
  );
}

function cli(root, args) {
  return spawnSync(process.execPath, ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), ...args, '--root', root], {
    encoding: 'utf8',
    cwd: root,
  });
}

async function boot(root, dbPath, options = {}) {
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const { createHttpServer } = await import(pathToFileURL(join(root, 'apps/server/src/index.js')).href);
  const { AccordoClient } = await import(pathToFileURL(join(root, 'packages/sdk/src/index.js')).href);
  const app = createAccordoApp({ dbPath, ...options });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new AccordoClient({ baseUrl, actor: { type: 'user', id: 'commercial-e2e' } });
  return { app, client, close: () => new Promise((resolve) => server.close(resolve)).then(() => app.close()) };
}

/** Create a core company + opportunity to hang quotes on. */
async function seedOpportunity(app, name = 'Quoted Deal') {
  const actor = { type: 'user', id: 'seed' };
  const company = await app.services.companies.create({ name: `Co ${name}` }, { actor });
  return app.services.opportunities.create(
    { companyId: company.id, name, type: 'new_business', valueCents: 1_000_000, currency: 'EUR', stage: 'discovery', owner: 'seed' },
    { actor },
  );
}

/** Helpers over the composite catalog. */
const offerOf = (app, key) => app.modules.get('offer').service.listWhere({ logicalKey: key, active: true })[0];
const componentsOf = (app, offerId) => app.modules.get('price-component').service
  .listWhere({ offerId })
  .sort((a, b) => a.position - b.position);

test('commercial e2e: composite catalog sync, mixed-recurrence quote, grouped totals, immutability, restart', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'commercial.sqlite');
  let instance = await boot(root, dbPath);
  t.after(() => instance.close().catch(() => {}));
  const { app, client } = instance;

  // Schema: the pricing contract is exposed safely and function-free.
  const schema = await client.schema();
  assert.equal(schema.commercial.commercialContract, 1);
  assert.equal(schema.commercial.pricingContract, 1);
  assert.deepEqual(schema.commercial.chargeTypes, ['one_time', 'recurring']);
  assert.deepEqual(schema.commercial.pricingModels, ['flat_fee', 'per_unit', 'volume', 'graduated']);
  assert.deepEqual(schema.commercial.recurringIntervals, ['month', 'year']);
  assert.match(schema.commercial.money, /1\/100 currency units/);
  assert.match(schema.commercial.totals, /never summed/);
  assert.match(schema.commercial.unsupportedModels, /quoteEligible=false/);
  assert.match(schema.commercial.quantitySemantics.flat_fee, /charged once/);
  assert.match(schema.commercial.discountPolicies[0].fingerprint, /^[0-9a-f]{64}$/);
  const walk = (value) => {
    if (typeof value === 'function') assert.fail('schema exposes a function');
    if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(schema.commercial);

  // Sync the composite catalog; every pricing shape lands.
  const sync1 = await client.request('/api/catalog/sync', { method: 'POST', body: { provider: 'fixture-saas-catalog' } });
  assert.equal(sync1.counts.productsCreated, 7);
  assert.equal(sync1.counts.offersCreated, 8);
  assert.equal(sync1.counts.ineligibleOffers, 1);
  assert.ok(sync1.counts.componentsCreated >= 10);
  assert.ok(sync1.counts.tiersCreated >= 6);
  const auditAfterSync1 = app.audit.list({ limit: 500 }).length;
  const sync2 = await client.request('/api/catalog/sync', { method: 'POST', body: { provider: 'fixture-saas-catalog' } });
  assert.equal(
    sync2.counts.productsCreated + sync2.counts.versionsCreated + sync2.counts.offersCreated + sync2.counts.offersRevised + sync2.counts.componentsCreated,
    0,
    'identical re-sync writes nothing',
  );
  assert.equal(app.audit.list({ limit: 500 }).length - auditAfterSync1, 1, 'only the sync-run record is audited');

  const book = app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
  const enterprise = offerOf(app, 'fixture:offer:enterprise');
  const storage = offerOf(app, 'fixture:offer:storage-monthly');
  const support = offerOf(app, 'fixture:offer:support-annual');
  const setup = offerOf(app, 'fixture:offer:setup');
  const metered = offerOf(app, 'fixture:offer:bandwidth-metered');

  // The composite offer carries three components with provider provenance.
  const entComponents = componentsOf(app, enterprise.id);
  assert.equal(entComponents.length, 3);
  assert.deepEqual(entComponents.map((component) => [component.chargeType, component.pricingModel, component.interval]), [
    ['one_time', 'flat_fee', null],
    ['recurring', 'flat_fee', 'month'],
    ['recurring', 'volume', 'month'],
  ]);
  assert.equal(entComponents[2].sourcePricingModel, 'stripe:tiers_mode=volume', 'provider model name preserved');
  assert.equal(entComponents[2].externalPriceId, 'price_ent_seats');
  const seatTiers = app.modules.get('price-tier').service.listWhere({ componentId: entComponents[2].id }).sort((a, b) => a.position - b.position);
  assert.deepEqual(seatTiers.map((tier) => [tier.upToQuantity, tier.unitAmountCents]), [[20, 5000], [100, 4000], [null, 3000]]);

  // Unsupported provider models are never approximated.
  assert.equal(metered.quoteEligible, false);
  assert.match(metered.unsupportedReason, /metered usage/);
  assert.equal(componentsOf(app, metered.id).length, 0, 'no component rows are invented for an unsupported model');

  // Build a mixed quote: composite offer + graduated storage + annual support.
  const opportunity = await seedOpportunity(app);
  const quotes = client.module('quote');
  const created = await client.request(`/api/modules/opportunity/records/${opportunity.id}/actions/create-quote`, { method: 'POST', body: { priceBookId: book.id } });
  const quoteId = created.result.quote.id;
  assert.equal(created.result.quote.currency, 'EUR');

  const entLine = await quotes.action(quoteId, 'add-line', { offerId: enterprise.id, quantity: 30 });
  const byModel = Object.fromEntries(entLine.result.line.components.map((component) => [component.pricingModel + ':' + component.chargeType, component]));
  assert.equal(byModel['flat_fee:one_time'].listAmountCents, 500_000, 'setup charged once, not 30x');
  assert.equal(byModel['flat_fee:one_time'].quantity, 0, 'flat fees are quantity-independent');
  assert.equal(byModel['flat_fee:recurring'].listAmountCents, 200_000);
  assert.equal(byModel['volume:recurring'].listAmountCents, 30 * 4000, 'volume tier prices the whole quantity');
  assert.equal(byModel['volume:recurring'].tierBreakdown.length, 1);
  assert.equal(entLine.result.quote.oneTimeTotal.netAmountCents, 500_000);

  const storageLine = await quotes.action(quoteId, 'add-line', { offerId: storage.id, quantity: 250 });
  const graduated = storageLine.result.line.components[0];
  assert.equal(graduated.pricingModel, 'graduated');
  assert.equal(graduated.listAmountCents, 100 * 200 + 150 * 150, 'graduated prices each band');
  assert.deepEqual(graduated.tierBreakdown.map((band) => [band.position, band.quantity]), [[1, 100], [2, 150]]);

  await quotes.action(quoteId, 'add-line', { offerId: support.id, quantity: 1, discountBps: 500 });
  await quotes.action(quoteId, 'add-line', { offerId: setup.id, quantity: 400 });

  // Grouped totals: one-time, monthly and annual stay separate.
  const quoteRecord = await quotes.get(quoteId);
  const totals = JSON.parse(quoteRecord.totalsJson);
  const monthly = totals.recurringTotals.find((group) => group.interval === 'month');
  const annual = totals.recurringTotals.find((group) => group.interval === 'year');
  assert.equal(totals.oneTimeTotal.netAmountCents, 500_000 + 500_000 + 400 * 25, 'enterprise setup + setup offer flat + per-unit migration');
  assert.equal(monthly.netAmountCents, 200_000 + 120_000 + (100 * 200 + 150 * 150));
  assert.equal(annual.netAmountCents, 1_000_000 - 50_000);
  assert.equal(totals.recurringTotals.length, 2);
  assert.equal(quoteRecord.recurringGroupCount, 2);
  assert.equal(Object.hasOwn(totals, 'grandTotal'), false, 'no misleading grand total is produced');

  // Unsupported offers cannot be quoted.
  await assert.rejects(
    () => quotes.action(quoteId, 'add-line', { offerId: metered.id, quantity: 1 }),
    (error) => error.status === 409 && error.code === 'OFFER_NOT_QUOTE_ELIGIBLE',
  );

  // Submit: immutable version, per-component evidence and grouped total rows.
  const submitted = await quotes.action(quoteId, 'submit', { policy: 'standard-sales-discount', version: 1 });
  assert.equal(submitted.result.version.decision, 'auto_approve');
  assert.equal(submitted.result.quote.status, 'approved');
  const versionId = submitted.result.version.id;
  const versionComponents = app.modules.get('quote-version-component').service.listWhere({ versionId });
  assert.equal(versionComponents.length, 7, 'every component of every line is evidenced');
  const seatEvidence = versionComponents.find((component) => component.pricingModel === 'volume');
  assert.deepEqual(JSON.parse(seatEvidence.tiersJson).map((tier) => tier.upTo), [20, 100, null], 'tier schedule snapshotted');
  assert.equal(JSON.parse(seatEvidence.tierBreakdownJson)[0].quantity, 30, 'tier breakdown snapshotted');
  assert.equal(seatEvidence.sourcePricingModel, 'stripe:tiers_mode=volume', 'provider provenance snapshotted');
  const versionTotals = app.modules.get('quote-version-total').service.listWhere({ versionId });
  assert.equal(versionTotals.length, 3, 'one-time + monthly + annual groups');
  assert.equal(versionTotals.find((group) => group.kind === 'one_time').netAmountCents, totals.oneTimeTotal.netAmountCents);
  assert.equal(versionTotals.find((group) => group.interval === 'year').netAmountCents, annual.netAmountCents);

  // Approved is terminal in M10.
  await assert.rejects(() => quotes.action(quoteId, 'add-line', { offerId: storage.id, quantity: 1 }), (e) => e.status === 409 && e.code === 'INVALID_STATE');
  await assert.rejects(() => quotes.action(quoteId, 'submit', { policy: 'standard-sales-discount', version: 1 }), (e) => e.status === 409 && e.code === 'INVALID_STATE');

  // Provider changes tier boundaries AND a flat price: new immutable offer
  // revisions; the historical quote version is untouched.
  const sync3 = await client.request('/api/catalog/sync', { method: 'POST', body: { provider: 'fixture-saas-catalog', input: { variant: 'v2' } } });
  assert.ok(sync3.counts.offersRevised >= 2, 'tier and price changes create new revisions');
  const frozen = app.modules.get('quote-version-component').service.listWhere({ versionId }).find((component) => component.pricingModel === 'volume');
  assert.equal(frozen.listAmountCents, 30 * 4000, 'historical amount unchanged');
  assert.deepEqual(JSON.parse(frozen.tiersJson).map((tier) => tier.upTo), [20, 100, null], 'historical tier schedule unchanged');
  const frozenTotals = app.modules.get('quote-version-total').service.listWhere({ versionId });
  assert.equal(frozenTotals.find((group) => group.interval === 'month').netAmountCents, monthly.netAmountCents, 'historical grouped totals unchanged');
  // New drafts price at the new revision; the superseded one is refused.
  const freshEnterprise = offerOf(app, 'fixture:offer:enterprise');
  assert.notEqual(freshEnterprise.id, enterprise.id);
  const opportunity2 = await seedOpportunity(app, 'After change');
  const quote2 = (await client.request(`/api/modules/opportunity/records/${opportunity2.id}/actions/create-quote`, { method: 'POST', body: { priceBookId: book.id } })).result.quote.id;
  const freshLine = await quotes.action(quote2, 'add-line', { offerId: freshEnterprise.id, quantity: 30 });
  assert.equal(freshLine.result.line.components.find((component) => component.pricingModel === 'volume').listAmountCents, 30 * 4200, 'new tiers apply to new drafts');
  await assert.rejects(
    () => quotes.action(quote2, 'add-line', { offerId: enterprise.id, quantity: 1 }),
    (error) => error.status === 409 && error.code === 'OFFER_INACTIVE',
  );

  // Read-only boundary across every commercial module.
  for (const module of COMMERCIAL_MODULES) {
    const meta = schema.generatedModules.find((entry) => entry.name === module);
    assert.deepEqual(meta.capabilities, ['get', 'list'], `${module} is read-only`);
    await assert.rejects(() => client.module(module).create({}), (error) => error.status === 404, `${module} create absent`);
    await assert.rejects(() => client.module(module).update(book.id, {}), (error) => error.status === 404, `${module} update absent`);
  }

  // Exact reads beyond the page bound.
  const bulkVersion = 'bulk-version';
  const componentService = app.modules.get('quote-version-component').service;
  for (let i = 0; i < 520; i += 1) {
    await componentService.createManaged({ versionId: bulkVersion, label: `bulk-${i}`, quantity: 1 }, { actor: { type: 'user', id: 'bulk' } });
  }
  assert.equal(componentService.countWhere({ versionId: bulkVersion }), 520);
  assert.equal(componentService.listWhere({ versionId: bulkVersion }).length, 520);

  // Restart: catalog, quote, versions and evidence survive.
  await instance.close();
  instance = await boot(root, dbPath);
  const persisted = await instance.client.module('quote').get(quoteId);
  assert.equal(persisted.status, 'approved');
  assert.equal(JSON.parse(persisted.totalsJson).recurringTotals.length, 2);
  assert.equal(instance.app.modules.get('quote-version-total').service.countWhere({ versionId }), 3);
});

test('commercial e2e: approval boundary, revise/version-2, concurrency, fault injection, provider failures, drift', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'commercial2.sqlite');
  const instance = await boot(root, dbPath, { catalogTimeoutMs: 150 });
  t.after(() => instance.close().catch(() => {}));
  const { app, client } = instance;
  const quotes = client.module('quote');
  const userActor = { type: 'user', id: 'manager' };

  await client.request('/api/catalog/sync', { method: 'POST', body: { provider: 'fixture-saas-catalog' } });
  const book = app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
  const enterprise = offerOf(app, 'fixture:offer:enterprise');

  const newQuote = async (name) => {
    const opportunity = await seedOpportunity(app, name);
    return (await client.request(`/api/modules/opportunity/records/${opportunity.id}/actions/create-quote`, { method: 'POST', body: { priceBookId: book.id } })).result.quote.id;
  };

  // Empty submissions refused.
  const quoteA = await newQuote('Empty');
  await assert.rejects(
    () => quotes.action(quoteA, 'submit', { policy: 'standard-sales-discount', version: 1 }),
    (error) => error.status === 409 && error.code === 'EMPTY_QUOTE',
  );

  // Stale draft revision → stable 409, nothing changes.
  await quotes.action(quoteA, 'add-line', { offerId: enterprise.id, quantity: 10, discountBps: 2000 });
  await assert.rejects(
    () => quotes.action(quoteA, 'add-line', { offerId: enterprise.id, quantity: 1, expectedRevision: 1 }),
    (error) => error.status === 409 && error.code === 'STALE_REVISION',
  );

  // High discount → one approval with complete policy evidence.
  const submitted = await quotes.action(quoteA, 'submit', { policy: 'standard-sales-discount', version: 1 });
  assert.equal(submitted.result.version.decision, 'approval_required');
  assert.equal(submitted.result.quote.status, 'pending_approval');
  const approval = app.modules.get('quote-approval').service.get(submitted.result.approvalId);
  assert.equal(approval.status, 'pending');
  assert.equal(approval.requiredApprovalKey, 'sales-manager', 'a LABEL, not enforced security');
  assert.equal(approval.maxLineDiscountBps, 2000);
  assert.match(approval.policyFingerprint, /^[0-9a-f]{64}$/);

  // Only a human user actor may decide.
  await assert.rejects(
    () => app.runAction({ module: 'quote', action: 'approve', recordId: quoteA, input: {}, actor: { type: 'agent', id: 'bot' } }),
    (error) => error.status === 403 && error.code === 'HUMAN_APPROVAL_REQUIRED',
  );
  // Concurrent approve/reject: exactly one decision.
  const race = await Promise.allSettled([
    quotes.action(quoteA, 'approve', {}),
    quotes.action(quoteA, 'reject', { reason: 'Too deep' }),
  ]);
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1, 'one decision wins');
  assert.equal(race.filter((result) => result.status === 'rejected' && result.reason.status === 409).length, 1);
  const decidedQuote = await quotes.get(quoteA);
  assert.equal(app.modules.get('quote-approval').service.get(submitted.result.approvalId).status, decidedQuote.status);
  await assert.rejects(() => quotes.action(quoteA, 'approve', {}), (error) => error.status === 409);

  // Hard-reject → revise → version 2 under policy v2, with distinct fingerprints.
  const quoteB = await newQuote('Revisable');
  await quotes.action(quoteB, 'add-line', { offerId: enterprise.id, quantity: 10, discountBps: 6000 });
  const rejected = await quotes.action(quoteB, 'submit', { policy: 'standard-sales-discount', version: 1 });
  assert.equal(rejected.result.version.decision, 'reject');
  assert.equal(rejected.result.quote.status, 'rejected');
  await quotes.action(quoteB, 'revise', {});
  const lines = app.modules.get('quote-line').service.listWhere({ quoteId: quoteB, removed: false });
  await quotes.action(quoteB, 'update-line', { lineId: lines[0].id, discountBps: 300 });
  const second = await quotes.action(quoteB, 'submit', { policy: 'standard-sales-discount', version: 2 });
  assert.equal(second.result.version.versionNumber, 2);
  assert.equal(second.result.quote.status, 'approved');
  assert.notEqual(second.result.version.policyFingerprint, rejected.result.version.policyFingerprint);
  const v1 = app.modules.get('quote-version').service.listWhere({ quoteId: quoteB, versionNumber: 1 })[0];
  assert.equal(v1.policyDecision, 'reject');
  assert.equal(v1.policyVersion, 1);

  // Concurrent submits: exactly one version, with complete evidence.
  const quoteC = await newQuote('Race');
  await quotes.action(quoteC, 'add-line', { offerId: enterprise.id, quantity: 5 });
  const submits = await Promise.allSettled([
    quotes.action(quoteC, 'submit', { policy: 'standard-sales-discount', version: 1 }),
    quotes.action(quoteC, 'submit', { policy: 'standard-sales-discount', version: 1 }),
  ]);
  assert.equal(submits.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(app.modules.get('quote-version').service.countWhere({ quoteId: quoteC }), 1);
  for (const loser of submits.filter((result) => result.status === 'rejected')) assert.equal(loser.reason.status, 409);

  // Two connections editing the same draft: writers serialize, no lost update.
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const quoteD = await newQuote('Two connections');
  const secondApp = createAccordoApp({ dbPath, busyTimeoutMs: 400 });
  t.after(() => secondApp.close());
  const edits = await Promise.allSettled([
    app.runAction({ module: 'quote', action: 'add-line', recordId: quoteD, input: { offerId: enterprise.id, quantity: 2 }, actor: userActor }),
    secondApp.runAction({ module: 'quote', action: 'add-line', recordId: quoteD, input: { offerId: enterprise.id, quantity: 3 }, actor: userActor }),
  ]);
  for (const result of edits) {
    if (result.status === 'rejected') {
      assert.equal(result.reason.status, 409, 'a raced-out edit is a stable 409');
      assert.ok(!/SQLITE_BUSY/.test(result.reason.message), 'never a raw SQLite busy error');
    }
  }
  const survivingLines = app.modules.get('quote-line').service.listWhere({ quoteId: quoteD, removed: false });
  const finalQuote = await quotes.get(quoteD);
  const finalTotals = JSON.parse(finalQuote.totalsJson);
  const expectedMonthly = survivingLines.reduce((sum, line) => {
    const breakdown = JSON.parse(line.breakdownJson);
    return sum + breakdown.components.filter((component) => component.interval === 'month').reduce((inner, component) => inner + component.netAmountCents, 0);
  }, 0);
  assert.equal(
    (finalTotals.recurringTotals.find((group) => group.interval === 'month') ?? { netAmountCents: 0 }).netAmountCents,
    expectedMonthly,
    'quote totals match the surviving lines exactly — no lost update',
  );

  // Fault injection while writing version components: full rollback.
  const quoteE = await newQuote('Faulty');
  await quotes.action(quoteE, 'add-line', { offerId: enterprise.id, quantity: 4, discountBps: 2000 });
  const before = await quotes.get(quoteE);
  const componentService = app.modules.get('quote-version-component').service;
  const realCreate = componentService.createManaged.bind(componentService);
  componentService.createManaged = async () => { throw new Error('injected component failure'); };
  try {
    await assert.rejects(() => app.runAction({ module: 'quote', action: 'submit', recordId: quoteE, input: { policy: 'standard-sales-discount', version: 1 }, actor: userActor }));
  } finally {
    componentService.createManaged = realCreate;
  }
  const after = await quotes.get(quoteE);
  assert.equal(after.status, 'draft', 'quote unchanged after the injected failure');
  assert.equal(after.draftRevision, before.draftRevision);
  assert.equal(app.modules.get('quote-version').service.countWhere({ quoteId: quoteE }), 0, 'no partial version');
  assert.equal(app.modules.get('quote-version-line').service.listWhere({ versionId: 'none' }).length, 0);
  assert.equal(app.modules.get('quote-approval').service.countWhere({ quoteId: quoteE }), 0, 'no orphan approval');

  // Provider failures: honest errors, no partial catalog.
  const offerCount = app.modules.get('offer').service.countWhere({});
  for (const [variant, code, status] of [['fail', 'PROVIDER_FAILED', 502], ['slow', 'PROVIDER_TIMEOUT', 504], ['invalid', 'PROVIDER_INVALID', 502], ['bad-tiers', 'PROVIDER_INVALID', 502]]) {
    await assert.rejects(
      () => app.syncCatalog({ provider: 'fixture-saas-catalog', input: { variant }, actor: userActor }),
      (error) => error.code === code && error.status === status,
      `${variant} → ${code}`,
    );
  }
  await assert.rejects(() => app.syncCatalog({ provider: '__proto__', actor: userActor }), (error) => error.status === 404);
  assert.equal(app.modules.get('offer').service.countWhere({}), offerCount, 'no partial catalog from failed syncs');
  assert.ok(
    app.workflows.listRuns({ limit: 500 }).filter((run) => run.workflowName === 'catalog.sync' && run.status === 'failed').length >= 4,
    'failed syncs leave honest failed traces',
  );

  // Policy config drift stops the next boot; restoring it boots cleanly.
  writeFileSync(
    join(root, 'packages/commercial/generated/index.js'),
    [
      "import { fixtureSaasCatalogProvider, standardSalesDiscountV1 } from '../../../examples/starters/b2b-lead-qualification/commercial.js';",
      'const drifted = { ...standardSalesDiscountV1, config: { ...standardSalesDiscountV1.config, autoApproveMaxBps: 9999 } };',
      'export const generatedCatalogProviders = [fixtureSaasCatalogProvider];',
      'export const generatedDiscountPolicies = [drifted];',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'boot-check.mjs'),
    [
      "import { createAccordoApp } from './packages/app/src/index.js';",
      `const app = createAccordoApp({ dbPath: ${JSON.stringify(dbPath)} });`,
      'app.close();',
      "console.log('booted');",
      '',
    ].join('\n'),
  );
  const drifted = spawnSync(process.execPath, ['--no-warnings', join(root, 'boot-check.mjs')], { encoding: 'utf8', cwd: root });
  assert.notEqual(drifted.status, 0, 'a drifted registered policy stops the app');
  assert.match(drifted.stderr, /source changed after registration/);
  writeCommercialIndex(root);
  const healthy = spawnSync(process.execPath, ['--no-warnings', join(root, 'boot-check.mjs')], { encoding: 'utf8', cwd: root });
  assert.equal(healthy.status, 0, `healthy definitions boot: ${healthy.stderr}`);
});

test('commercial e2e: hostile catalog and quote inputs stay inert', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'commercial3.sqlite');
  const instance = await boot(root, dbPath);
  t.after(() => instance.close().catch(() => {}));
  const { app, client } = instance;

  await client.request('/api/catalog/sync', { method: 'POST', body: { provider: 'fixture-saas-catalog' } });
  const book = app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
  const enterprise = offerOf(app, 'fixture:offer:enterprise');
  const opportunity = await seedOpportunity(app, 'Hostile');
  const quoteId = (await client.request(`/api/modules/opportunity/records/${opportunity.id}/actions/create-quote`, { method: 'POST', body: { priceBookId: book.id } })).result.quote.id;
  const quotes = client.module('quote');

  // Prototype-shaped and malformed identifiers never resolve.
  for (const hostile of ['__proto__', 'constructor', 'prototype', 'toString', '<script>alert(1)</script>']) {
    await assert.rejects(
      () => quotes.action(quoteId, 'add-line', { offerId: hostile, quantity: 1 }),
      (error) => error.status === 404 || error.status === 400,
      `offerId ${hostile}`,
    );
    await assert.rejects(
      () => app.syncCatalog({ provider: hostile, actor: { type: 'user', id: 'x' } }),
      (error) => error.status === 404,
      `provider ${hostile}`,
    );
  }
  assert.equal({}.polluted, undefined, 'no prototype pollution');

  // Client-supplied amounts are ignored: the server prices from the catalog.
  const line = await client.request(`/api/modules/quote/records/${quoteId}/actions/add-line`, {
    method: 'POST',
    body: {
      offerId: enterprise.id,
      quantity: 2,
      listAmountCents: 1,
      netAmountCents: 1,
      unitAmountCents: 1,
      totalCents: 1,
      breakdownJson: '[]',
    },
  });
  assert.equal(line.result.line.listAmountCents, 500_000 + 200_000 + 2 * 5000, 'server-derived, ignoring the forged amounts');

  // Malformed inputs and oversized strings are bounded 400s.
  for (const input of [
    { offerId: enterprise.id, quantity: 0 },
    { offerId: enterprise.id, quantity: -5 },
    { offerId: enterprise.id, quantity: 1.5 },
    { offerId: enterprise.id, quantity: '10' },
    { offerId: enterprise.id, quantity: 1, discountBps: 10001 },
    { offerId: enterprise.id, quantity: 1, discountBps: -1 },
    { offerId: 'x'.repeat(10_001), quantity: 1 },
  ]) {
    await assert.rejects(
      () => client.request(`/api/modules/quote/records/${quoteId}/actions/add-line`, { method: 'POST', body: input }),
      (error) => error.status === 400 || error.status === 404,
      JSON.stringify(input).slice(0, 60),
    );
  }
  // A non-object body is a 400, never a confusing downstream error.
  await assert.rejects(
    () => client.request(`/api/modules/quote/records/${quoteId}/actions/add-line`, { method: 'POST', body: [1, 2] }),
    (error) => error.status === 400,
  );
  // Errors never leak stacks, SQL, paths or provider payloads.
  try {
    await quotes.action(quoteId, 'add-line', { offerId: 'missing-offer', quantity: 1 });
    assert.fail('expected a rejection');
  } catch (error) {
    assert.ok(!/SELECT |INSERT |\/home\/|at Object|node:internal/.test(String(error.message)), `leaky message: ${error.message}`);
  }
});
