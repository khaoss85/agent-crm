// @ts-check

/**
 * The async-storage guard (accordo 105ba984): on PostgreSQL every record read
 * is a Promise, while the commercial chain used those reads as synchronous
 * values — `revisions.sort is not a function` stopped the presti-group seed
 * at the commercial proposal. The only exercised path was SQLite, whose reads
 * settle synchronously.
 *
 * Both tests below run on SQLite with every record service wrapped so reads
 * settle through a real Promise, which is the exact seam where PostgreSQL
 * differs. Any record read consumed without `await` in the exercised path
 * throws a TypeError instead of answering rows, so the journey fails loudly
 * rather than shipping a silent SQLite-only pass.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { project, boot, POLICY, ACTIVATION_INPUT } from './helpers/contracts-project.js';

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

test('catalog sync, quote, approve, signature and activation run on async record reads', async (t) => {
  const root = project(t, { withDomain: true });
  const context = await boot(root, join(root, 'data', 'commercial-async.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  asyncStorage(app);
  const { signatureFixture } = await import(pathToFileURL(join(root, 'examples/starters/b2b-lead-qualification/signature.js')).href);

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
  const submitted = await app.runAction({ module: 'quote', action: 'submit', recordId: quote.id, input: { policy: 'standard-sales-discount', version: 1 }, actor: ACTOR });
  if (submitted.result.version.decision === 'approval_required') {
    await app.runAction({ module: 'quote', action: 'approve', recordId: quote.id, input: {}, actor: ACTOR });
  }
  const approvals = await app.modules.get('quote-approval').service.listWhere({ quoteId: quote.id });
  assert.ok(approvals.length > 0 || submitted.result.version.decision !== 'approval_required', 'the proposal carries its approval evidence');

  await app.runAction({
    module: 'quote', action: 'request-signature', recordId: quote.id,
    input: {
      quoteVersionId: submitted.result.version.id, provider: 'fixture-signature', providerVersion: 1,
      signers: [{ name: 'Ada Async', email: 'sign.async@example.com', role: 'customer' }],
    },
    actor: ACTOR,
  });
  const envelope = (await app.modules.get('signature-envelope').service.listWhere({ quoteVersionId: submitted.result.version.id }))[0];
  assert.ok(envelope?.id, 'the signature envelope exists on async storage');
  signatureFixture.markCompleted(envelope.idempotencyKey);
  const event = signatureFixture.event(envelope.idempotencyKey, 'completed', { providerEventId: 'evt_async_guard' });
  await app.ingestSignatureEvent({ provider: 'fixture-signature', rawBody: event.rawBody, headers: event.headers });
  const order = (await app.modules.get('order').service.listWhere({ quoteVersionId: submitted.result.version.id }))[0];
  assert.ok(order?.id, 'verified completion writes the order on async storage');

  const planned = await app.runAction({ module: 'order', action: 'plan-activation', recordId: order.id, input: { ...POLICY }, actor: ACTOR });
  assert.ok(planned.result?.plan, 'activation plans on async storage');
  await app.runAction({
    module: 'order', action: 'activate-contract', recordId: order.id,
    input: { ...POLICY, ...ACTIVATION_INPUT }, actor: ACTOR,
  });
  const contract = (await app.modules.get('commercial-contract').service.listWhere({ orderId: order.id }))[0];
  assert.ok(contract?.id, 'activation writes the contract on async storage');
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
