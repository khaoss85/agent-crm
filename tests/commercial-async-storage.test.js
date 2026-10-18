// @ts-check

/**
 * The async-storage guard (accordo 105ba984): on PostgreSQL every record read
 * is a Promise, while the commercial chain used those reads as synchronous
 * values — `revisions.sort is not a function` stopped the presti-group seed
 * at the commercial proposal. The only exercised path was SQLite, whose reads
 * settle synchronously.
 *
 * The journey and the tripwire below run on SQLite with every record service
 * wrapped so reads settle through a real Promise, which is the exact seam
 * where PostgreSQL differs. Any record read consumed without `await` in the
 * exercised path throws a TypeError instead of answering rows, so the journey
 * fails loudly rather than shipping a silent SQLite-only pass.
 *
 * The journey covers the seed path the acceptance names — syncCatalog, the
 * commercial proposal and its approval — on the synchronous application graph.
 * Signature, completion, activation and succession on asynchronous storage run
 * through the contract-2 capabilities, which the third test opens directly:
 * the synchronous graph's capability readers spread an unsettled Promise into
 * a frozen empty row (proven while scoping this file: request-signature on the
 * sync graph answers VERSION_MISMATCH on async storage), so composing the
 * synchronous graph with asynchronous storage for those paths would prove a
 * hybrid that never runs in production (PostgreSQL composes the contract-2
 * graph). The end-to-end journey for those paths needs the async-composed
 * application — contract-2 graphs plus the app methods the portable async
 * factory does not wire yet (syncCatalog, ingestSignatureEvent) — and stays a
 * follow-up. Composition edges are the dual-graph test's subject; the third
 * test proves the reads themselves.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { project, boot } from './helpers/contracts-project.js';

/**
 * Wrap a record service so every method settles through a Promise, like the
 * asynchronous storage contract does. Synchronous storage answers values; a
 * caller that forgets `await` keeps working there and breaks in production.
 * Under this wrapper that caller gets a Promise and fails here instead.
 */
function asyncRecordService(service) {
  return new Proxy(service, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop);
      if (typeof value !== 'function' || prop === 'constructor') return value;
      return (...args) => Promise.resolve().then(() => value.apply(target, args));
    },
  });
}

/**
 * Apply the async-storage contract to every composed record module service.
 * Core services (`app.services`) stay untouched: the application's own health
 * readers consume them synchronously by design.
 */
function asyncStorage(app) {
  for (const module of app.modules.modules.values()) {
    if (module?.service) module.service = asyncRecordService(module.service);
  }
}

const ACTOR = { type: 'user', id: 'async-guard' };

const TERM = {
  effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31',
  autoRenew: true, renewalNoticeDays: 60,
};

/**
 * The seed path: synchronize the catalog, propose on it and submit. Shared by
 * the journey and the contract-2 test so both start from the same submitted
 * proposal. Approval is the journey's own step, not the setup's. The journey
 * stays termless (the pre-terms seed path); the contract-2 test drafts a term
 * so the frozen snapshot and its verifier run on async storage too.
 */
async function seedSubmittedProposal(app, { term } = {}) {
  const synced = await app.syncCatalog({ provider: 'fixture-saas-catalog', actor: ACTOR });
  assert.ok(synced, 'syncCatalog settles on async storage');

  const book = (await app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' }))[0];
  assert.ok(book?.id, 'the synced price book reads back through a Promise');
  const offerOf = async (key) => (await app.modules.get('offer').service.listWhere({ logicalKey: key, active: true }))[0];

  const company = await app.services.companies.create({ name: 'Async Guard SpA' }, { actor: ACTOR });
  const contact = await app.services.contacts.create(
    { companyId: company.id, firstName: 'Ada', lastName: 'Async', email: 'ada.async@example.com' },
    { actor: ACTOR },
  );
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, contactId: contact.id, name: 'Async deal', type: 'new_business', valueCents: 100_000, currency: 'EUR', stage: 'discovery', owner: 'async-guard' },
    { actor: ACTOR },
  );
  const quote = (await app.runAction({ module: 'opportunity', action: 'create-quote', recordId: opportunity.id, input: { priceBookId: book.id }, actor: ACTOR })).result.quote;
  for (const key of ['fixture:offer:enterprise', 'fixture:offer:api-monthly']) {
    const offer = await offerOf(key);
    assert.ok(offer?.id, `synced offer ${key} reads back through a Promise`);
    await app.runAction({
      module: 'quote', action: 'add-line', recordId: quote.id,
      input: { offerId: offer.id, quantity: 20, discountBps: 500 }, actor: ACTOR,
    });
  }
  if (term) {
    await app.modules.get('quote-term').service.create({ quoteId: quote.id, ...term }, { actor: ACTOR });
  }
  const submitted = await app.runAction({ module: 'quote', action: 'submit', recordId: quote.id, input: { policy: 'standard-sales-discount', version: 1 }, actor: ACTOR });
  return { quote, version: submitted.result.version, decision: submitted.result.version.decision };
}

test('catalog sync, quote and approve run on async record reads', async (t) => {
  const root = project(t, { withDomain: true });
  const context = await boot(root, join(root, 'data', 'commercial-async.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  asyncStorage(app);

  const { quote, decision } = await seedSubmittedProposal(app);
  if (decision === 'approval_required') {
    await app.runAction({ module: 'quote', action: 'approve', recordId: quote.id, input: {}, actor: ACTOR });
  }
  const approvals = await app.modules.get('quote-approval').service.listWhere({ quoteId: quote.id });
  assert.ok(approvals.length > 0 || decision !== 'approval_required', 'the proposal carries its approval evidence');
});

test('an un-awaited record read fails instead of answering rows', async (t) => {
  const root = project(t, { withDomain: false });
  const context = await boot(root, join(root, 'data', 'commercial-async-tripwire.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  asyncStorage(app);

  const pending = app.modules.get('price-book').service.listWhere({ sourceKey: 'no-such-book' });
  assert.equal(typeof pending?.then, 'function', 'on async storage a record read is a Promise, never rows');
  assert.throws(() => pending.sort((a, b) => (a.id < b.id ? -1 : 1)), TypeError, 'consuming it without await throws like revisions.sort did in production');
  const rows = await pending;
  assert.deepEqual(rows, [], 'awaited, the same read settles to rows');
});

test('the contract-2 commercial capability settles every read on async storage', async (t) => {
  const root = project(t, { withDomain: true });
  const context = await boot(root, join(root, 'data', 'commercial-async-v2.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  asyncStorage(app);
  const { quote, version } = await seedSubmittedProposal(app, { term: TERM });

  // The awaitable graph's offering, opened with the application's own modules
  // view — the same seam PostgreSQL differs on. Composition edges are the
  // dual-graph test's subject; this test proves the reads themselves.
  const { createCommercialDomainV2 } = await import(pathToFileURL(join(root, 'packages/commercial/src/index.js')).href);
  const { standardSalesDiscountV1 } = await import(pathToFileURL(join(root, 'examples/starters/b2b-lead-qualification/commercial.js')).href);
  const offered = createCommercialDomainV2({ discountPolicies: [standardSalesDiscountV1] }).capabilities.find((entry) => entry.name === 'commercial-quotes');
  assert.equal(offered?.version, 2, 'the contract-2 graph offers commercial-quotes@2');
  const cap = await offered.create({ modules: app.modules, consumer: 'internal-async-probe' });
  assert.equal(cap.capabilityContract, 2, 'the awaitable graph declares capabilityContract 2');

  const q = await cap.quote(quote.id);
  assert.ok(q && typeof q.then === 'undefined', 'quote answers the frozen record, settled');
  assert.equal(q.currentVersionId, version.id, 'the quote names the submitted version');
  assert.equal(Object.isFrozen(q), true, 'the record is frozen');

  const v = await cap.version(version.id);
  assert.equal(v?.policy, 'standard-sales-discount', 'the version carries its discount policy');

  const lines = await cap.versionLines(version.id);
  assert.equal(lines.length, 2, 'both proposal lines read back through Promises');
  assert.ok(lines.every((line, i) => i === 0 || lines[i - 1].position <= line.position), 'lines stay position-ordered');

  const totals = await cap.versionTotals(version.id);
  assert.ok(totals.length >= 1, 'grouped totals read back through a Promise');

  const snapshot = await cap.versionTerm(version.id);
  assert.ok(snapshot && typeof snapshot.then === 'undefined', 'the frozen snapshot settles, never a Promise');
  assert.equal(snapshot.versionId, version.id, 'the snapshot belongs to the submitted version');
  assert.equal(Object.isFrozen(snapshot), true, 'the snapshot is frozen');

  const outcome = await cap.verifySignedTerms({ scope: 'quote-version', versionId: version.id });
  assert.ok(outcome?.verified, 'the drafted term verifies on async storage');
  assert.ok(Number.isFinite(outcome.verified.termDays), 'the verified tuple carries its term length');
  assert.equal(outcome.row.versionId, version.id, 'the verified row is the frozen snapshot');

  assert.equal(await cap.versionTerm('no-such-version'), null, 'a version without a term is still null, never an error');
  assert.equal(await cap.verifySignedTerms({ scope: 'quote-version', versionId: 'no-such-version' }), null,
    'with no snapshot the verifier answers null, like the synchronous contract');
  assert.ok(cap.policies().length >= 1, 'the storage-free read stays synchronous on both contracts');
});
