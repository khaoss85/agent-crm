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
  'price-book-entry.module.json',
  'catalog-sync-run.module.json',
  'quote.module.json',
  'quote-line.module.json',
  'quote-version.module.json',
  'quote-version-line.module.json',
  'quote-approval.module.json',
];

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'agent-crm-commercial-'));
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
  return spawnSync(process.execPath, ['--no-warnings', join(root, 'packages/cli/bin/agent-crm.js'), ...args, '--root', root], {
    encoding: 'utf8',
    cwd: root,
  });
}

async function boot(root, dbPath, options = {}) {
  const { createAgentCrmApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const { createHttpServer } = await import(pathToFileURL(join(root, 'apps/server/src/index.js')).href);
  const { AgentCrmClient } = await import(pathToFileURL(join(root, 'packages/sdk/src/index.js')).href);
  const app = createAgentCrmApp({ dbPath, ...options });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new AgentCrmClient({ baseUrl, actor: { type: 'user', id: 'commercial-e2e' } });
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

test('commercial e2e: catalog sync, server-priced quote, immutable versions, read-only surface, restart', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'commercial.sqlite');
  let instance = await boot(root, dbPath);
  t.after(() => instance.close().catch(() => {}));
  const { app, client } = instance;

  // Schema: commercial metadata is additive, sorted and function-free.
  const schema = await client.schema();
  assert.equal(schema.commercial.commercialContract, 1);
  assert.deepEqual(schema.commercial.catalogProviders.map((p) => p.name), ['fixture-saas-catalog']);
  assert.deepEqual(schema.commercial.discountPolicies.map((p) => `${p.name}@${p.version}`), ['standard-sales-discount@1', 'standard-sales-discount@2']);
  assert.match(schema.commercial.discountPolicies[0].fingerprint, /^[0-9a-f]{64}$/);
  assert.match(schema.commercial.money, /1\/100 currency units/);

  // Sync over HTTP; counts recorded; re-sync is idempotent with no fake audits.
  const sync1 = await client.request('/api/catalog/sync', { method: 'POST', body: { provider: 'fixture-saas-catalog' } });
  assert.deepEqual(
    { products: sync1.counts.productsCreated, versions: sync1.counts.versionsCreated, entries: sync1.counts.entriesCreated, books: sync1.counts.priceBooksCreated },
    { products: 3, versions: 3, entries: 3, books: 1 },
  );
  const auditCountAfterSync1 = app.audit.list({ limit: 500 }).length;
  const sync2 = await client.request('/api/catalog/sync', { method: 'POST', body: { provider: 'fixture-saas-catalog' } });
  assert.equal(sync2.counts.productsCreated + sync2.counts.versionsCreated + sync2.counts.entriesCreated + sync2.counts.entriesRevised, 0, 'idempotent re-sync');
  const syncRunAudits = app.audit.list({ limit: 500 }).length - auditCountAfterSync1;
  assert.equal(syncRunAudits, 1, 'only the sync-run record itself is audited on an unchanged catalog');

  const books = app.modules.get('price-book').service;
  const entriesService = app.modules.get('price-book-entry').service;
  const book = books.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
  const platform1 = entriesService.listWhere({ logicalKey: 'fixture:entry:saas-platform-eur', active: true })[0];
  const seat = entriesService.listWhere({ logicalKey: 'fixture:entry:user-seat-eur', active: true })[0];
  assert.equal(platform1.unitAmountCents, 1_200_000);

  // Build a quote: lines are server-priced; totals follow the documented math.
  const opportunity = await seedOpportunity(app);
  const quotes = client.module('quote');
  const created = await client.request(`/api/modules/opportunity/records/${opportunity.id}/actions/create-quote`, { method: 'POST', body: { priceBookId: book.id } });
  const quoteId = created.result.quote.id;
  assert.equal(created.result.quote.currency, 'EUR');
  const line1 = await quotes.action(quoteId, 'add-line', { priceBookEntryId: platform1.id, quantity: 1 });
  assert.equal(line1.result.quote.subtotalCents, 1_200_000);
  assert.equal(line1.result.quote.draftRevision, 2, 'each edit increments the draft revision');
  const line2 = await quotes.action(quoteId, 'add-line', { priceBookEntryId: seat.id, quantity: 20, discountBps: 500, expectedRevision: 2 });
  assert.equal(line2.result.line.lineSubtotalCents, 600_000);
  assert.equal(line2.result.line.lineDiscountCents, 30_000);
  assert.equal(line2.result.quote.totalCents, 1_200_000 + 600_000 - 30_000);
  // Stale optimistic revision → stable 409; nothing changes.
  await assert.rejects(
    () => quotes.action(quoteId, 'add-line', { priceBookEntryId: seat.id, quantity: 1, expectedRevision: 2 }),
    (error) => error.status === 409 && error.code === 'STALE_REVISION',
  );
  // update-line and remove-line recalculate server-side.
  const updated = await quotes.action(quoteId, 'update-line', { lineId: line2.result.line.id, quantity: 10 });
  assert.equal(updated.result.quote.subtotalCents, 1_200_000 + 300_000);
  const extra = await quotes.action(quoteId, 'add-line', { priceBookEntryId: seat.id, quantity: 1 });
  const removed = await quotes.action(quoteId, 'remove-line', { lineId: extra.result.line.id });
  assert.equal(removed.result.quote.subtotalCents, 1_200_000 + 300_000, 'soft-removed line leaves the totals');

  // Submit: low discount auto-approves; immutable version + lines recorded.
  const submitted = await quotes.action(quoteId, 'submit', { policy: 'standard-sales-discount', version: 1 });
  assert.equal(submitted.result.version.decision, 'auto_approve');
  assert.equal(submitted.result.quote.status, 'approved');
  const versionId = submitted.result.version.id;
  const versionLines = app.modules.get('quote-version-line').service.listWhere({ versionId });
  assert.equal(versionLines.length, 2, 'removed lines are not versioned');
  assert.match(submitted.result.version.policyFingerprint, /^[0-9a-f]{64}$/);
  // Approved is terminal in M10: no more edits or submissions.
  await assert.rejects(() => quotes.action(quoteId, 'add-line', { priceBookEntryId: seat.id, quantity: 1 }), (e) => e.status === 409 && e.code === 'INVALID_STATE');
  await assert.rejects(() => quotes.action(quoteId, 'submit', { policy: 'standard-sales-discount', version: 1 }), (e) => e.status === 409 && e.code === 'INVALID_STATE');

  // Catalog change (v2): new immutable version + entry revision; the quoted
  // evidence and the old entry record never change.
  const sync3 = await client.request('/api/catalog/sync', { method: 'POST', body: { provider: 'fixture-saas-catalog', input: { variant: 'v2' } } });
  // Two revisions: the platform price change, plus the onboarding entry
  // re-linking to the NEW product version created by its description change —
  // an entry revision records every change to the commercial data it binds.
  assert.equal(sync3.counts.entriesRevised, 2, 'price + product-version changes create new entry revisions');
  assert.equal(sync3.counts.versionsCreated, 1, 'description change creates a new product version');
  const platformRevisions = entriesService.listWhere({ logicalKey: 'fixture:entry:saas-platform-eur' });
  assert.equal(platformRevisions.length, 2);
  const oldRevision = platformRevisions.find((entry) => entry.revision === 1);
  assert.equal(oldRevision.unitAmountCents, 1_200_000, 'historical price evidence intact');
  assert.equal(oldRevision.active, false);
  const frozenLine = app.modules.get('quote-version-line').service.listWhere({ versionId })
    .find((line) => line.sku === 'SAAS-PLAT-A');
  assert.equal(frozenLine.listUnitAmountCents, 1_200_000, 'quoted evidence unchanged by the price change');
  // Adding the now-inactive old entry to a new draft is refused.
  const opportunity2 = await seedOpportunity(app, 'Second Deal');
  const quote2 = (await client.request(`/api/modules/opportunity/records/${opportunity2.id}/actions/create-quote`, { method: 'POST', body: { priceBookId: book.id } })).result.quote.id;
  await assert.rejects(
    () => quotes.action(quote2, 'add-line', { priceBookEntryId: oldRevision.id, quantity: 1 }),
    (error) => error.status === 409 && error.code === 'ENTRY_INACTIVE',
  );

  // Read-only boundary: none of the ten commercial modules accepts any public
  // write — create/update are absent (404), even empty.
  for (const module of ['product', 'product-version', 'price-book', 'price-book-entry', 'catalog-sync-run', 'quote', 'quote-line', 'quote-version', 'quote-version-line', 'quote-approval']) {
    const meta = schema.generatedModules.find((m) => m.name === module);
    assert.deepEqual(meta.capabilities, ['get', 'list'], `${module} is read-only`);
    await assert.rejects(() => client.module(module).create({}), (error) => error.status === 404, `${module} create absent`);
    await assert.rejects(() => client.module(module).update(book.id, {}), (error) => error.status === 404, `${module} update absent`);
  }

  // Exact reads beyond the page bound: 520 version-line records all count.
  const bulkVersionId = 'bulk-version';
  const versionLineService = app.modules.get('quote-version-line').service;
  for (let i = 0; i < 520; i += 1) {
    await versionLineService.createManaged({ versionId: bulkVersionId, sku: `BULK-${i}`, position: i + 1 }, { actor: { type: 'user', id: 'bulk' } });
  }
  assert.equal(versionLineService.listWhere({ versionId: bulkVersionId }).length, 520);
  assert.equal(versionLineService.countWhere({ versionId: bulkVersionId }), 520);

  // Restart: catalog, quote, versions and approvals survive.
  await instance.close();
  instance = await boot(root, dbPath);
  const persisted = await instance.client.module('quote').get(quoteId);
  assert.equal(persisted.status, 'approved');
  assert.equal(persisted.currentVersionId, versionId);
  assert.equal((await instance.client.module('quote-version').get(versionId)).totalCents, submitted.result.version.totals.totalCents);
});

test('commercial e2e: human approval boundary, revise/version-2, concurrency, fault injection, provider failure, drift', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'commercial2.sqlite');
  const instance = await boot(root, dbPath, { catalogTimeoutMs: 150 });
  t.after(() => instance.close().catch(() => {}));
  const { app, client } = instance;
  const quotes = client.module('quote');
  const userActor = { type: 'user', id: 'manager' };

  await client.request('/api/catalog/sync', { method: 'POST', body: { provider: 'fixture-saas-catalog' } });
  const book = app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
  const platform = app.modules.get('price-book-entry').service.listWhere({ logicalKey: 'fixture:entry:saas-platform-eur', active: true })[0];

  // Empty submissions are refused.
  const opportunity = await seedOpportunity(app);
  const emptyQuote = (await client.request(`/api/modules/opportunity/records/${opportunity.id}/actions/create-quote`, { method: 'POST', body: { priceBookId: book.id } })).result.quote.id;
  await assert.rejects(
    () => quotes.action(emptyQuote, 'submit', { policy: 'standard-sales-discount', version: 1 }),
    (error) => error.status === 409 && error.code === 'EMPTY_QUOTE',
  );

  // High discount → pending approval with complete policy evidence.
  await quotes.action(emptyQuote, 'add-line', { priceBookEntryId: platform.id, quantity: 1, discountBps: 2000 });
  const submitted = await quotes.action(emptyQuote, 'submit', { policy: 'standard-sales-discount', version: 1 });
  assert.equal(submitted.result.version.decision, 'approval_required');
  assert.equal(submitted.result.quote.status, 'pending_approval');
  const approval = app.modules.get('quote-approval').service.get(submitted.result.approvalId);
  assert.equal(approval.status, 'pending');
  assert.equal(approval.requiredApprovalKey, 'sales-manager', 'required key is a LABEL, not enforced security');
  assert.match(approval.policyFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(approval.maxLineDiscountBps, 2000);

  // Only a human user actor may decide; agents are rejected.
  await assert.rejects(
    () => app.runAction({ module: 'quote', action: 'approve', recordId: emptyQuote, input: {}, actor: { type: 'agent', id: 'bot' } }),
    (error) => error.status === 403 && error.code === 'HUMAN_APPROVAL_REQUIRED',
  );
  // Concurrent approve/reject: exactly one decision wins; the loser gets a
  // stable 409; the approval and quote agree.
  const race = await Promise.allSettled([
    quotes.action(emptyQuote, 'approve', {}),
    quotes.action(emptyQuote, 'reject', { reason: 'Too deep' }),
  ]);
  const decisions = race.map((r) => (r.status === 'fulfilled' ? r.value.result.decision : r.reason.code)).sort();
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1, `one decision (${decisions})`);
  assert.equal(race.filter((r) => r.status === 'rejected' && [409].includes(r.reason.status)).length, 1);
  const decidedQuote = await quotes.get(emptyQuote);
  const decidedApproval = app.modules.get('quote-approval').service.get(submitted.result.approvalId);
  assert.equal(decidedApproval.status, decidedQuote.status, 'approval and quote lifecycle agree');
  // A second decision is a stable 409 whichever way the race went.
  await assert.rejects(
    () => app.runAction({ module: 'quote', action: 'approve', recordId: emptyQuote, input: {}, actor: userActor }),
    (error) => error.status === 409,
  );

  // Rejected → revise → edit → version 2, evaluated under policy v2 with its
  // own fingerprint; version 1 keeps its evidence.
  const opportunity2 = await seedOpportunity(app, 'Revisable');
  const revisable = (await client.request(`/api/modules/opportunity/records/${opportunity2.id}/actions/create-quote`, { method: 'POST', body: { priceBookId: book.id } })).result.quote.id;
  await quotes.action(revisable, 'add-line', { priceBookEntryId: platform.id, quantity: 1, discountBps: 6000 });
  const hardRejected = await quotes.action(revisable, 'submit', { policy: 'standard-sales-discount', version: 1 });
  assert.equal(hardRejected.result.version.decision, 'reject', 'above the hard limit the policy itself rejects');
  assert.equal(hardRejected.result.quote.status, 'rejected');
  await quotes.action(revisable, 'revise', {});
  const lines = app.modules.get('quote-line').service.listWhere({ quoteId: revisable, removed: false });
  await quotes.action(revisable, 'update-line', { lineId: lines[0].id, discountBps: 300 });
  const second = await quotes.action(revisable, 'submit', { policy: 'standard-sales-discount', version: 2 });
  assert.equal(second.result.version.versionNumber, 2, 'DB-monotonic version numbers');
  assert.equal(second.result.quote.status, 'approved');
  assert.notEqual(second.result.version.policyFingerprint, hardRejected.result.version.policyFingerprint, 'policy versions carry distinct fingerprints');
  const v1 = app.modules.get('quote-version').service.listWhere({ quoteId: revisable, versionNumber: 1 })[0];
  assert.equal(v1.policyVersion, 1);
  assert.equal(v1.policyDecision, 'reject');

  // Concurrent submits: exactly one version for the draft.
  const opportunity3 = await seedOpportunity(app, 'Race');
  const raced = (await client.request(`/api/modules/opportunity/records/${opportunity3.id}/actions/create-quote`, { method: 'POST', body: { priceBookId: book.id } })).result.quote.id;
  await quotes.action(raced, 'add-line', { priceBookEntryId: platform.id, quantity: 1 });
  const submits = await Promise.allSettled([
    quotes.action(raced, 'submit', { policy: 'standard-sales-discount', version: 1 }),
    quotes.action(raced, 'submit', { policy: 'standard-sales-discount', version: 1 }),
  ]);
  assert.equal(submits.filter((r) => r.status === 'fulfilled').length, 1, 'one submit wins');
  assert.equal(app.modules.get('quote-version').service.countWhere({ quoteId: raced }), 1, 'exactly one version');
  for (const loser of submits.filter((r) => r.status === 'rejected')) {
    assert.equal(loser.reason.status, 409);
  }

  // Fault injection: a failure while writing version lines rolls back the
  // whole submission — no version, no approval, quote still draft.
  const opportunity4 = await seedOpportunity(app, 'Faulty');
  const faulty = (await client.request(`/api/modules/opportunity/records/${opportunity4.id}/actions/create-quote`, { method: 'POST', body: { priceBookId: book.id } })).result.quote.id;
  await quotes.action(faulty, 'add-line', { priceBookEntryId: platform.id, quantity: 2, discountBps: 2000 });
  const beforeFault = await quotes.get(faulty);
  const versionLineService = app.modules.get('quote-version-line').service;
  const realCreate = versionLineService.createManaged.bind(versionLineService);
  versionLineService.createManaged = async () => { throw new Error('injected version-line failure'); };
  try {
    await assert.rejects(() => app.runAction({ module: 'quote', action: 'submit', recordId: faulty, input: { policy: 'standard-sales-discount', version: 1 }, actor: userActor }));
  } finally {
    versionLineService.createManaged = realCreate;
  }
  const afterFault = await quotes.get(faulty);
  assert.equal(afterFault.status, 'draft', 'quote unchanged after the injected failure');
  assert.equal(afterFault.draftRevision, beforeFault.draftRevision);
  assert.equal(app.modules.get('quote-version').service.countWhere({ quoteId: faulty }), 0, 'no partial version');
  assert.equal(app.modules.get('quote-approval').service.countWhere({ quoteId: faulty }), 0, 'no orphan approval');

  // Provider failure/timeout/invalid output: honest errors, no partial catalog.
  const productCount = app.modules.get('product').service.countWhere({});
  await assert.rejects(
    () => app.syncCatalog({ provider: 'fixture-saas-catalog', input: { variant: 'fail' }, actor: userActor }),
    (error) => error.code === 'PROVIDER_FAILED' && error.status === 502,
  );
  await assert.rejects(
    () => app.syncCatalog({ provider: 'fixture-saas-catalog', input: { variant: 'slow' }, actor: userActor }),
    (error) => error.code === 'PROVIDER_TIMEOUT' && error.status === 504,
  );
  await assert.rejects(
    () => app.syncCatalog({ provider: 'fixture-saas-catalog', input: { variant: 'invalid' }, actor: userActor }),
    (error) => error.code === 'PROVIDER_INVALID' && error.status === 502,
  );
  await assert.rejects(
    () => app.syncCatalog({ provider: '__proto__', actor: userActor }),
    (error) => error.status === 404,
  );
  assert.equal(app.modules.get('product').service.countWhere({}), productCount, 'no partial catalog state from failed syncs');
  const failedTraces = app.workflows.listRuns({ limit: 500 }).filter((run) => run.workflowName === 'catalog.sync' && run.status === 'failed');
  assert.ok(failedTraces.length >= 3, 'failed syncs leave honest failed traces');

  // Policy drift stops the next boot; restoring the source boots cleanly.
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
      "import { createAgentCrmApp } from './packages/app/src/index.js';",
      `const app = createAgentCrmApp({ dbPath: ${JSON.stringify(dbPath)} });`,
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
