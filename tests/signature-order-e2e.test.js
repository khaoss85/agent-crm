import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Milestone 11 e2e (ADR-017): provider-backed signature envelopes, verified
 * events, signed-artifact evidence and immutable Orders — proven in a clean
 * throwaway project with the real CLI/factory, HTTP server and SDK against the
 * deterministic fixture signature provider. No network, no credential.
 */

const COMMERCIAL_MANIFESTS = [
  'product.module.json', 'product-version.module.json', 'price-book.module.json',
  'offer.module.json', 'price-component.module.json', 'price-tier.module.json',
  'catalog-sync-run.module.json', 'quote.module.json', 'quote-line.module.json',
  'quote-version.module.json', 'quote-version-line.module.json',
  'quote-version-component.module.json', 'quote-version-total.module.json',
  'quote-approval.module.json',
];

const MANIFESTS = [
  'signature-envelope.module.json', 'signature-signer.module.json',
  'signature-event.module.json', 'signed-artifact.module.json',
  'order.module.json', 'order-line.module.json', 'order-component.module.json',
  'order-tier.module.json', 'order-total.module.json',
];

const SIGNATURE_MODULES = [
  'signature-envelope', 'signature-signer', 'signature-event', 'signed-artifact',
  'order', 'order-line', 'order-component', 'order-tier', 'order-total',
];

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-signature-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  const starter = join(root, 'examples/starters/b2b-lead-qualification');
  for (const manifest of COMMERCIAL_MANIFESTS) {
    const result = spawnSync(
      process.execPath,
      ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), 'module', 'create', join(root, 'packages/commercial/modules', manifest), '--apply', '--root', root],
      { encoding: 'utf8', cwd: root },
    );
    assert.equal(result.status, 0, `apply ${manifest}: ${result.stderr}`);
  }
  void starter;
  for (const manifest of MANIFESTS) {
    const result = spawnSync(
      process.execPath,
      ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), 'module', 'create', join(root, 'packages/signature/modules', manifest), '--apply', '--root', root],
      { encoding: 'utf8', cwd: root },
    );
    assert.equal(result.status, 0, `apply ${manifest}: ${result.stderr}`);
  }
  writeFileSync(
    join(root, 'packages/actions/generated/index.js'),
    [
      '// @ts-check',
      '// Quote actions arrive with the commercial package, request-signature',
      '// with the signature package — both composed below.',
      'export const generatedActions = [];',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages/domains/generated/index.js'),
    [
      '// @ts-check',
      "import { createCommercialDomain } from '../../commercial/src/index.js';",
      "import { fixtureSaasCatalogProvider, standardSalesDiscountV1, standardSalesDiscountV2 } from '../../../examples/starters/b2b-lead-qualification/commercial.js';",
      "import { createSignatureDomain } from '../../signature/src/index.js';",
      "import { fixtureSignatureProvider } from '../../../examples/starters/b2b-lead-qualification/signature.js';",
      'export const generatedDomains = [',
      '  createCommercialDomain({',
      '    catalogProviders: [fixtureSaasCatalogProvider],',
      '    discountPolicies: [standardSalesDiscountV1, standardSalesDiscountV2],',
      '  }),',
      '  createSignatureDomain({ signatureProviders: [fixtureSignatureProvider] }),',
      '];',
      '',
    ].join('\n'),
  );
  return root;
}

async function boot(root, dbPath, options = {}) {
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const { createHttpServer } = await import(pathToFileURL(join(root, 'apps/server/src/index.js')).href);
  const { AccordoClient } = await import(pathToFileURL(join(root, 'packages/sdk/src/index.js')).href);
  const app = createAccordoApp({ dbPath, ...options });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    app,
    server,
    baseUrl,
    client: new AccordoClient({ baseUrl, actor: { type: 'user', id: 'e2e' } }),
    agentClient: new AccordoClient({ baseUrl, actor: { type: 'agent', id: 'bot' } }),
    async close() {
      await new Promise((resolve) => server.close(resolve));
      app.close();
    },
  };
}

async function fixture(root) {
  return import(pathToFileURL(join(root, 'examples/starters/b2b-lead-qualification/signature.js')).href);
}

/** Drive an approved composite quote: catalog → quote → submit → approve. */
async function approvedQuote(app, { discountBps = 500, name = 'Signed Deal' } = {}) {
  const actor = { type: 'user', id: 'e2e' };
  await app.syncCatalog({ provider: 'fixture-saas-catalog', actor });
  const book = app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
  const offer = app.modules.get('offer').service.listWhere({ logicalKey: 'fixture:offer:enterprise', active: true })[0];
  const company = await app.services.companies.create({ name: `${name} SpA` }, { actor });
  const contact = await app.services.contacts.create(
    { companyId: company.id, firstName: 'Mario', lastName: 'Rossi', email: `mario.${encodeURIComponent(name)}@example.com` },
    { actor },
  );
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, contactId: contact.id, name, type: 'new_business', valueCents: 100_000, currency: 'EUR', stage: 'discovery', owner: 'e2e' },
    { actor },
  );
  const quote = (await app.runAction({ module: 'opportunity', action: 'create-quote', recordId: opportunity.id, input: { priceBookId: book.id }, actor })).result.quote;
  await app.runAction({ module: 'quote', action: 'add-line', recordId: quote.id, input: { offerId: offer.id, quantity: 20, discountBps }, actor });
  const submitted = await app.runAction({ module: 'quote', action: 'submit', recordId: quote.id, input: { policy: 'standard-sales-discount', version: 1 }, actor });
  if (submitted.result.version.decision === 'approval_required') {
    await app.runAction({ module: 'quote', action: 'approve', recordId: quote.id, input: {}, actor });
  }
  return { quote: app.modules.get('quote').service.get(quote.id), versionId: submitted.result.version.id, company, opportunity, offer, book };
}

const signerList = (email = 'mario@example.com') => [{ name: 'Mario Rossi', email, role: 'customer', order: 1 }];

test('approved quote → verified signature → signed artifact → one immutable order', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'signature.sqlite');
  const { signatureFixture } = await fixture(root);
  signatureFixture.reset();
  let context = await boot(root, dbPath);
  // Registered immediately: a mid-test assertion failure must still close the
  // server, or the test file would hang on an open handle instead of failing.
  t.after(() => context.close());
  const { app, client } = context;
  const actor = { type: 'user', id: 'e2e' };

  const { quote, versionId, company } = await approvedQuote(app);
  assert.equal(quote.status, 'approved');

  // The schema advertises the contract, never a secret or a handler.
  const schema = await client.request('/api/schema');
  const signatureBlock = schema.domains.signature;
  assert.equal(schema.signature, undefined, 'the ambient block is gone; the package publishes under domains');
  assert.equal(signatureBlock.signatureContract, 1);
  assert.equal(signatureBlock.providers[0].name, 'fixture-signature');
  assert.match(signatureBlock.providers[0].fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(signatureBlock).includes('not-a-secret'), 'no verification key in the schema');

  // An agent actor may PREPARE everything, but may not send.
  await assert.rejects(
    () => context.agentClient.module('quote').action(quote.id, 'request-signature', {
      quoteVersionId: versionId, provider: 'fixture-signature', providerVersion: 1, signers: signerList(),
    }),
    (error) => error.status === 403 && error.code === 'HUMAN_APPROVAL_REQUIRED',
  );
  assert.equal(app.modules.get('signature-envelope').service.list().length, 0, 'a refused send creates nothing');

  // The human send, over the generic action surface.
  const requested = await client.module('quote').action(quote.id, 'request-signature', {
    quoteVersionId: versionId, provider: 'fixture-signature', providerVersion: 1, signers: signerList(),
  });
  assert.equal(requested.result.envelope.status, 'sent');
  const envelopes = app.modules.get('signature-envelope').service;
  const envelope = envelopes.listWhere({ quoteVersionId: versionId })[0];
  assert.equal(envelope.status, 'sent');
  assert.equal(envelope.idempotencyKey, `env:quote-version:${versionId}`);
  assert.match(envelope.providerEnvelopeId, /^env_[0-9a-f]{24}$/);
  assert.match(envelope.documentHash, /^[0-9a-f]{64}$/);
  assert.equal(envelope.documentFormat, 'application/vnd.accordo.quote-package+json');
  assert.equal(app.modules.get('signature-signer').service.countWhere({ envelopeId: envelope.id }), 1);
  assert.equal(app.modules.get('quote').service.get(quote.id).signatureEnvelopeId, envelope.id);

  // Exactly one envelope per version, ever.
  await assert.rejects(
    () => client.module('quote').action(quote.id, 'request-signature', {
      quoteVersionId: versionId, provider: 'fixture-signature', providerVersion: 1, signers: signerList('other@example.com'),
    }),
    (error) => error.status === 409 && error.code === 'ENVELOPE_EXISTS',
  );
  assert.equal(envelopes.list().length, 1);

  // The trace distinguishes local intent, the provider call and finalization.
  const runs = app.workflows.listRuns({ workflowName: 'quote.request-signature', limit: 10 });
  const successful = runs.find((run) => run.status === 'completed');
  const spans = app.workflows.getRun(successful.id).spans.map((span) => span.name);
  assert.ok(spans.includes('quote.request-signature.intent'), spans.join(','));
  assert.ok(spans.includes('quote.request-signature.external'), spans.join(','));
  assert.ok(spans.includes('quote.request-signature.finalize'), spans.join(','));
  assert.ok(spans.includes('signature.provider-envelope'));

  // A delivered event moves the envelope forward and creates no order.
  signatureFixture.markDelivered(envelope.idempotencyKey);
  const delivered = signatureFixture.event(envelope.idempotencyKey, 'delivered');
  const deliveredResponse = await fetch(`${context.baseUrl}/api/signature/providers/fixture-signature/events`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...delivered.headers }, body: delivered.rawBody,
  });
  assert.equal(deliveredResponse.status, 200);
  assert.equal(envelopes.get(envelope.id).status, 'delivered');
  assert.equal(app.modules.get('order').service.list().length, 0);

  // The verified completion: artifact evidence and exactly one order, atomically.
  signatureFixture.markCompleted(envelope.idempotencyKey);
  const completion = signatureFixture.event(envelope.idempotencyKey, 'completed', { providerEventId: 'evt_completed' });
  const completionResponse = await fetch(`${context.baseUrl}/api/signature/providers/fixture-signature/events`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...completion.headers }, body: completion.rawBody,
  });
  assert.equal(completionResponse.status, 200);
  const completed = envelopes.get(envelope.id);
  assert.equal(completed.status, 'completed');
  assert.equal(app.modules.get('signature-signer').service.listWhere({ envelopeId: envelope.id })[0].status, 'signed');

  const artifact = app.modules.get('signed-artifact').service.listWhere({ envelopeId: envelope.id })[0];
  assert.equal(artifact.documentHash, envelope.documentHash);
  assert.match(artifact.artifactHash, /^[0-9a-f]{64}$/);
  assert.equal(artifact.mimeType, 'application/vnd.accordo.quote-package+json');
  assert.equal(artifact.completionEventId, app.modules.get('signature-event').service.listWhere({ providerEventId: 'evt_completed' })[0].id);
  // The signed canonical package travels with the evidence, and it still
  // hashes to what was signed — evidence that needs no other record to verify.
  assert.equal(createHash('sha256').update(artifact.documentJson, 'utf8').digest('hex'), artifact.documentHash);
  assert.equal(artifact.documentJson, envelope.documentJson);

  const orders = app.modules.get('order').service.listWhere({ quoteVersionId: versionId });
  assert.equal(orders.length, 1);
  const order = orders[0];
  assert.equal(order.sourceKey, `order:quote-version:${versionId}`);
  assert.equal(order.status, 'accepted');
  assert.equal(order.companyId, company.id);
  assert.equal(order.customerName, company.name, 'the customer identity is snapshotted, not just referenced');
  assert.equal(order.envelopeId, envelope.id);
  assert.equal(order.signedArtifactId, artifact.id);
  assert.equal(order.documentHash, envelope.documentHash);

  // The order snapshot equals the quote version snapshot, field for field.
  const version = app.modules.get('quote-version').service.get(versionId);
  assert.equal(order.totalsJson, version.totalsJson);
  assert.equal(order.oneTimeNetCents, version.oneTimeNetCents);
  assert.equal(order.recurringGroupCount, version.recurringGroupCount);
  const versionComponents = app.modules.get('quote-version-component').service.listWhere({ versionId });
  const orderComponents = app.modules.get('order-component').service.listWhere({ orderId: order.id });
  assert.equal(orderComponents.length, versionComponents.length);
  assert.equal(orderComponents.length, 3, 'the composite offer keeps all three components');
  for (const component of versionComponents) {
    const copied = orderComponents.find((row) => row.versionComponentId === component.id);
    assert.ok(copied, `component ${component.componentKey} copied`);
    for (const field of ['chargeType', 'pricingModel', 'interval', 'intervalCount', 'quantity', 'tiersJson', 'tierBreakdownJson', 'listAmountCents', 'discountAmountCents', 'netAmountCents', 'sourcePricingModel']) {
      assert.deepEqual(copied[field], component[field], `${component.componentKey}.${field}`);
    }
  }
  const orderTiers = app.modules.get('order-tier').service.listWhere({ orderId: order.id });
  assert.equal(orderTiers.length, 3, 'the volume tier schedule is stored row-wise too');
  assert.equal(orderTiers.filter((tier) => tier.upToQuantity === null).length, 1, 'exactly one open-ended tier');
  const orderTotals = app.modules.get('order-total').service.listWhere({ orderId: order.id });
  assert.equal(orderTotals.length, 2, 'one one-time row plus one monthly row — never summed');
  assert.deepEqual(orderTotals.map((total) => total.kind).sort(), ['one_time', 'recurring']);

  // A later catalog movement cannot touch signed evidence or the order.
  await app.syncCatalog({ provider: 'fixture-saas-catalog', input: { variant: 'v2' }, actor });
  assert.equal(app.modules.get('order').service.get(order.id).totalsJson, version.totalsJson);
  assert.equal(app.modules.get('order-component').service.listWhere({ orderId: order.id }).length, 3);
  assert.deepEqual(
    app.modules.get('order-component').service.listWhere({ orderId: order.id }).map((row) => row.tiersJson).sort(),
    orderComponents.map((row) => row.tiersJson).sort(),
  );
  assert.equal(app.modules.get('signed-artifact').service.get(artifact.id).artifactHash, artifact.artifactHash);
  assert.equal(app.modules.get('quote-version').service.get(versionId).totalsJson, version.totalsJson);

  // Every signature/order module is read-only over HTTP: no create, no update.
  for (const module of SIGNATURE_MODULES) {
    const metadata = await client.request(`/api/modules/${module}`);
    assert.deepEqual(metadata.capabilities, ['get', 'list'], module);
    for (const [method, path, body] of [
      ['POST', `/api/modules/${module}/records`, '{}'],
      ['POST', `/api/modules/${module}/records`, JSON.stringify({ status: 'completed', netAmountCents: 1 })],
      ['PATCH', `/api/modules/${module}/records/${order.id}`, JSON.stringify({ status: 'accepted' })],
    ]) {
      const response = await fetch(`${context.baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, body });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
  }

  // Exact lookups stay exact beyond the 500-row list bound.
  const events = app.modules.get('signature-event').service;
  assert.equal(events.countWhere({ provider: 'fixture-signature' }), events.list({ limit: 500 }).length);

  // Restart: every record and link survives a fresh process-level open.
  await context.close();
  context = await boot(root, dbPath);
  const reopened = context.app;
  assert.equal(reopened.modules.get('order').service.get(order.id).totalsJson, version.totalsJson);
  assert.equal(reopened.modules.get('signature-envelope').service.get(envelope.id).status, 'completed');
  assert.equal(reopened.modules.get('order').service.list().length, 1);
});

test('event verification, replay, ordering and concurrency are decided by the server', async (t) => {
  const root = project(t);
  const { signatureFixture } = await fixture(root);
  signatureFixture.reset();
  const context = await boot(root, join(root, 'data', 'events.sqlite'));
  t.after(() => context.close());
  const { app, client, baseUrl } = context;
  const post = (body, headers) => fetch(`${baseUrl}/api/signature/providers/fixture-signature/events`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
  });

  const { quote, versionId } = await approvedQuote(app, { name: 'Events Deal' });
  await client.module('quote').action(quote.id, 'request-signature', {
    quoteVersionId: versionId, provider: 'fixture-signature', providerVersion: 1, signers: signerList('events@example.com'),
  });
  const envelopes = app.modules.get('signature-envelope').service;
  const envelope = envelopes.listWhere({ quoteVersionId: versionId })[0];
  const events = app.modules.get('signature-event').service;

  // 1. A forged signature never mutates state and never echoes the payload.
  const forged = signatureFixture.event(envelope.idempotencyKey, 'completed', { providerEventId: 'evt_forged' });
  const forgedResponse = await post(forged.rawBody, { 'x-signature-256': 'f'.repeat(64), 'x-signature-timestamp': forged.headers['x-signature-timestamp'] });
  assert.equal(forgedResponse.status, 401);
  const forgedBody = await forgedResponse.json();
  assert.equal(forgedBody.error.code, 'SIGNATURE_INVALID');
  assert.ok(!JSON.stringify(forgedBody).includes('evt_forged'), 'the payload is never echoed');
  assert.ok(!JSON.stringify(forgedBody).includes('not-a-secret'), 'the key is never echoed');
  assert.equal(events.list().length, 0);
  assert.equal(envelopes.get(envelope.id).status, 'sent');

  // 2. A missing signature, a malformed body and a stale timestamp all fail closed.
  assert.equal((await post(forged.rawBody, {})).status, 401);
  assert.equal((await post('not json at all', signatureFixture.event(envelope.idempotencyKey, 'sent').headers)).status, 401);
  const stale = signatureFixture.event(envelope.idempotencyKey, 'completed', {
    providerEventId: 'evt_stale', timestampSeconds: Math.floor(Date.now() / 1000) - 4_000,
  });
  assert.equal((await post(stale.rawBody, stale.headers)).status, 401, 'replay window enforced');
  assert.equal(events.list().length, 0);

  // 3. An event for an unknown envelope is quarantined as evidence, not applied.
  const orphan = signatureFixture.event(envelope.idempotencyKey, 'completed', {
    providerEventId: 'evt_orphan', providerEnvelopeId: 'env_unknown0000000000000',
  });
  const orphanResult = await (await post(orphan.rawBody, orphan.headers)).json();
  assert.equal(orphanResult.quarantined, true);
  assert.equal(events.listWhere({ providerEventId: 'evt_orphan' })[0].effect, 'quarantined');
  assert.equal(envelopes.get(envelope.id).status, 'sent');

  // 4. Out of order: completed first, then a late `sent` and a late `delivered`.
  signatureFixture.markCompleted(envelope.idempotencyKey);
  const completed = signatureFixture.event(envelope.idempotencyKey, 'completed', { providerEventId: 'evt_c1' });
  assert.equal((await (await post(completed.rawBody, completed.headers)).json()).applied, true);
  assert.equal(envelopes.get(envelope.id).status, 'completed');
  const orderId = app.modules.get('order').service.listWhere({ quoteVersionId: versionId })[0].id;

  for (const [id, status] of [['evt_late_sent', 'sent'], ['evt_late_delivered', 'delivered'], ['evt_late_declined', 'declined'], ['evt_late_voided', 'voided']]) {
    const late = signatureFixture.event(envelope.idempotencyKey, status, { providerEventId: id });
    const result = await (await post(late.rawBody, late.headers)).json();
    assert.equal(result.applied, false, `${status} after completed`);
    assert.equal(result.reason, 'terminal');
    assert.equal(events.listWhere({ providerEventId: id })[0].effect, 'ignored');
  }
  assert.equal(envelopes.get(envelope.id).status, 'completed', 'a terminal envelope never regresses');
  assert.equal(app.modules.get('order').service.list().length, 1);

  // 5. Duplicate delivery of the SAME event is idempotent and stable.
  const first = await (await post(completed.rawBody, completed.headers)).json();
  const second = await (await post(completed.rawBody, completed.headers)).json();
  assert.deepEqual(first, second, 'a replay answers identically');
  assert.equal(first.duplicate, true);
  assert.equal(events.countWhere({ providerEventId: 'evt_c1' }), 1, 'one inbox row per provider event id');
  assert.equal(app.modules.get('order').service.list().length, 1);
  assert.equal(app.modules.get('signed-artifact').service.list().length, 1);

  // 6. A reused provider event id carrying a DIFFERENT payload is a provider
  //    contract violation, not a duplicate to acknowledge: it is refused, and
  //    it certainly cannot replay into another envelope.
  const other = await approvedQuote(app, { name: 'Other Deal' });
  await client.module('quote').action(other.quote.id, 'request-signature', {
    quoteVersionId: other.versionId, provider: 'fixture-signature', providerVersion: 1, signers: signerList('other-deal@example.com'),
  });
  const otherEnvelope = envelopes.listWhere({ quoteVersionId: other.versionId })[0];
  signatureFixture.markCompleted(otherEnvelope.idempotencyKey);
  const reused = signatureFixture.event(otherEnvelope.idempotencyKey, 'completed', { providerEventId: 'evt_c1' });
  const reusedResponse = await post(reused.rawBody, reused.headers);
  assert.equal(reusedResponse.status, 409);
  const reusedBody = await reusedResponse.json();
  assert.equal(reusedBody.error.code, 'EVENT_ID_CONFLICT');
  assert.equal(envelopes.get(otherEnvelope.id).status, 'sent', 'the other envelope is untouched');
  assert.equal(events.countWhere({ providerEventId: 'evt_c1' }), 1, 'the conflicting reuse recorded nothing');
  assert.equal(app.modules.get('order').service.list().length, 1);
  // A replay that IS the same bytes still answers as a stable duplicate.
  assert.equal((await (await post(completed.rawBody, completed.headers)).json()).duplicate, true);

  // 7. Concurrent duplicate webhooks over HTTP: one applies, one is a duplicate,
  //    and exactly one order exists.
  const race = signatureFixture.event(otherEnvelope.idempotencyKey, 'completed', { providerEventId: 'evt_race' });
  const [a, b] = await Promise.all([post(race.rawBody, race.headers), post(race.rawBody, race.headers)]);
  const results = [await a.json(), await b.json()];
  assert.equal(results.filter((result) => result.duplicate === true).length, 1, JSON.stringify(results));
  assert.equal(results.filter((result) => result.applied === true).length, 1, JSON.stringify(results));
  assert.equal(app.modules.get('order').service.listWhere({ quoteVersionId: other.versionId }).length, 1);
  assert.equal(envelopes.get(otherEnvelope.id).status, 'completed');

  // 8. A completion racing an explicit reconcile still yields ONE order.
  const third = await approvedQuote(app, { name: 'Race Deal' });
  await client.module('quote').action(third.quote.id, 'request-signature', {
    quoteVersionId: third.versionId, provider: 'fixture-signature', providerVersion: 1, signers: signerList('race@example.com'),
  });
  const raceEnvelope = envelopes.listWhere({ quoteVersionId: third.versionId })[0];
  signatureFixture.markCompleted(raceEnvelope.idempotencyKey);
  const webhook = signatureFixture.event(raceEnvelope.idempotencyKey, 'completed', { providerEventId: 'evt_reconcile_race' });
  const outcomes = await Promise.allSettled([
    post(webhook.rawBody, webhook.headers),
    app.reconcileSignature({ envelopeId: raceEnvelope.id, actor: { type: 'user', id: 'e2e' } }),
  ]);
  assert.ok(outcomes.some((outcome) => outcome.status === 'fulfilled'), JSON.stringify(outcomes.map((o) => o.status)));
  assert.equal(envelopes.get(raceEnvelope.id).status, 'completed');
  assert.equal(app.modules.get('order').service.listWhere({ quoteVersionId: third.versionId }).length, 1);
  assert.equal(app.modules.get('signed-artifact').service.listWhere({ envelopeId: raceEnvelope.id }).length, 1);
  assert.equal(app.modules.get('order-line').service.listWhere({ orderId: app.modules.get('order').service.listWhere({ quoteVersionId: third.versionId })[0].id }).length, 1);

  // 9. A second app instance on the same database sees the same terminal truth
  //    and cannot create a second order.
  const sibling = await boot(root, join(root, 'data', 'events.sqlite'));
  t.after(() => sibling.close());
  assert.equal(sibling.app.modules.get('signature-envelope').service.get(raceEnvelope.id).status, 'completed');
  const siblingReconcile = await sibling.app.reconcileSignature({ envelopeId: raceEnvelope.id, actor: { type: 'user', id: 'sibling' } });
  assert.equal(siblingReconcile.applied, false);
  assert.equal(sibling.app.modules.get('order').service.listWhere({ quoteVersionId: third.versionId }).length, 1);
  assert.equal(orderId, app.modules.get('order').service.listWhere({ quoteVersionId: versionId })[0].id, 'the first order is untouched throughout');
});

test('failure, decline and reconciliation paths never invent an order', async (t) => {
  const root = project(t);
  const { signatureFixture } = await fixture(root);
  signatureFixture.reset();
  const context = await boot(root, join(root, 'data', 'failures.sqlite'), { signatureTimeoutMs: 150 });
  t.after(() => context.close());
  const { app, client, baseUrl } = context;
  const actor = { type: 'user', id: 'e2e' };
  const envelopes = app.modules.get('signature-envelope').service;
  const post = (body, headers) => fetch(`${baseUrl}/api/signature/providers/fixture-signature/events`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
  });

  // 1. Lifecycle gating: only an approved current version may be sent.
  await app.syncCatalog({ provider: 'fixture-saas-catalog', actor });
  const book = app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
  const offer = app.modules.get('offer').service.listWhere({ logicalKey: 'fixture:offer:enterprise', active: true })[0];
  const company = await app.services.companies.create({ name: 'Gate SpA' }, { actor });
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, name: 'Gated Deal', type: 'new_business', valueCents: 1, currency: 'EUR', stage: 'discovery', owner: 'e2e' }, { actor },
  );
  const draft = (await app.runAction({ module: 'opportunity', action: 'create-quote', recordId: opportunity.id, input: { priceBookId: book.id }, actor })).result.quote;
  await app.runAction({ module: 'quote', action: 'add-line', recordId: draft.id, input: { offerId: offer.id, quantity: 20, discountBps: 2000 }, actor });
  const send = (quoteId, input) => client.module('quote').action(quoteId, 'request-signature', {
    provider: 'fixture-signature', providerVersion: 1, signers: signerList('gate@example.com'), ...input,
  });
  await assert.rejects(() => send(draft.id, { quoteVersionId: 'missing' }), (error) => error.code === 'INVALID_STATE');
  const submitted = await app.runAction({ module: 'quote', action: 'submit', recordId: draft.id, input: { policy: 'standard-sales-discount', version: 1 }, actor });
  assert.equal(app.modules.get('quote').service.get(draft.id).status, 'pending_approval');
  await assert.rejects(() => send(draft.id, { quoteVersionId: submitted.result.version.id }), (error) => error.code === 'INVALID_STATE');
  await app.runAction({ module: 'quote', action: 'reject', recordId: draft.id, input: { reason: 'too deep' }, actor });
  await assert.rejects(() => send(draft.id, { quoteVersionId: submitted.result.version.id }), (error) => error.code === 'INVALID_STATE');
  await app.runAction({ module: 'quote', action: 'revise', recordId: draft.id, input: {}, actor });
  const second = await app.runAction({ module: 'quote', action: 'submit', recordId: draft.id, input: { policy: 'standard-sales-discount', version: 1 }, actor });
  await app.runAction({ module: 'quote', action: 'approve', recordId: draft.id, input: {}, actor });
  // The superseded version 1 is historical evidence and can never be signed.
  await assert.rejects(
    () => send(draft.id, { quoteVersionId: submitted.result.version.id }),
    (error) => error.status === 409 && error.code === 'VERSION_SUPERSEDED',
  );
  // A version belonging to another quote is refused too.
  const foreign = await approvedQuote(app, { name: 'Foreign Deal' });
  await assert.rejects(
    () => send(draft.id, { quoteVersionId: foreign.versionId }),
    (error) => error.status === 409 && error.code === 'VERSION_MISMATCH',
  );
  assert.equal(envelopes.list().length, 0, 'no refused request left an envelope behind');

  // 2. A provider outage leaves a recoverable `failed` intent, never a partial send.
  const outage = await approvedQuote(app, { name: 'Outage Deal' });
  await assert.rejects(
    () => send(outage.quote.id, { quoteVersionId: outage.versionId, signers: signerList('signer@outage.example') }),
    (error) => error.status >= 400,
  );
  const failedEnvelope = envelopes.listWhere({ quoteVersionId: outage.versionId })[0];
  assert.equal(failedEnvelope.status, 'failed');
  assert.equal(failedEnvelope.failurePhase, 'external');
  assert.equal(failedEnvelope.providerEnvelopeId, null);
  assert.equal(app.modules.get('order').service.listWhere({ quoteVersionId: outage.versionId }).length, 0);
  // Reconciling an envelope the provider never created is honest, not invented.
  const absent = await app.reconcileSignature({ envelopeId: failedEnvelope.id, actor });
  assert.equal(absent.applied, false);
  assert.equal(absent.reason, 'absent-at-provider');
  assert.equal(envelopes.get(failedEnvelope.id).status, 'failed');
  // And a second request is still refused — reconcile, never duplicate.
  await assert.rejects(
    () => send(outage.quote.id, { quoteVersionId: outage.versionId }),
    (error) => error.code === 'ENVELOPE_EXISTS',
  );

  // 3. A hanging provider is a bounded timeout with the same recoverable state.
  const hang = await approvedQuote(app, { name: 'Hang Deal' });
  await assert.rejects(
    () => send(hang.quote.id, { quoteVersionId: hang.versionId, signers: signerList('signer@timeout.example') }),
    (error) => error.code === 'PROVIDER_TIMEOUT',
  );
  assert.equal(envelopes.listWhere({ quoteVersionId: hang.versionId })[0].status, 'failed');

  // 4. Provider SUCCESS + local finalization failure — the case the state
  //    machine exists for. Reconciliation recovers it by idempotency key.
  const recovered = await approvedQuote(app, { name: 'Recovered Deal' });
  const realApply = envelopes.applyManaged.bind(envelopes);
  let injected = 0;
  envelopes.applyManaged = async (...args) => {
    if (injected === 0) { injected += 1; throw new Error('injected local finalization failure'); }
    return realApply(...args);
  };
  await assert.rejects(
    () => send(recovered.quote.id, { quoteVersionId: recovered.versionId, signers: signerList('recovered@example.com') }),
    /injected local finalization failure/,
  );
  envelopes.applyManaged = realApply;
  const stranded = envelopes.listWhere({ quoteVersionId: recovered.versionId })[0];
  assert.equal(stranded.status, 'failed');
  assert.equal(stranded.failurePhase, 'finalize');
  assert.equal(stranded.providerEnvelopeId, null, 'the local database never learned the provider id');
  // The provider really does hold the envelope, found by idempotency key.
  const recovery = await app.reconcileSignature({ envelopeId: stranded.id, actor });
  assert.equal(recovery.applied, true);
  assert.equal(envelopes.get(stranded.id).status, 'sent');
  assert.match(envelopes.get(stranded.id).providerEnvelopeId, /^env_/);
  assert.equal(envelopes.get(stranded.id).failureCode, null);

  // 5. A lost webhook: the provider completed, no event ever arrived, and
  //    reconciliation produces the artifact and the one order.
  signatureFixture.markCompleted(stranded.idempotencyKey);
  const lost = await app.reconcileSignature({ envelopeId: stranded.id, actor });
  assert.equal(lost.applied, true);
  assert.equal(envelopes.get(stranded.id).status, 'completed');
  const recoveredOrders = app.modules.get('order').service.listWhere({ quoteVersionId: recovered.versionId });
  assert.equal(recoveredOrders.length, 1);
  assert.equal(app.modules.get('signed-artifact').service.listWhere({ envelopeId: stranded.id }).length, 1);
  // Reconciling again changes nothing.
  const again = await app.reconcileSignature({ envelopeId: stranded.id, actor });
  assert.equal(again.applied, false);
  assert.equal(app.modules.get('order').service.listWhere({ quoteVersionId: recovered.versionId }).length, 1);

  // 6. A decline is terminal, keeps signer evidence and creates NO order.
  const declined = await approvedQuote(app, { name: 'Declined Deal' });
  await send(declined.quote.id, { quoteVersionId: declined.versionId, signers: signerList('declined@example.com') });
  const declinedEnvelope = envelopes.listWhere({ quoteVersionId: declined.versionId })[0];
  signatureFixture.markDeclined(declinedEnvelope.idempotencyKey);
  const declineEvent = signatureFixture.event(declinedEnvelope.idempotencyKey, 'declined', { providerEventId: 'evt_declined' });
  assert.equal((await (await post(declineEvent.rawBody, declineEvent.headers)).json()).applied, true);
  assert.equal(envelopes.get(declinedEnvelope.id).status, 'declined');
  assert.equal(app.modules.get('signature-signer').service.listWhere({ envelopeId: declinedEnvelope.id })[0].status, 'declined');
  assert.equal(app.modules.get('order').service.listWhere({ quoteVersionId: declined.versionId }).length, 0);
  assert.equal(app.modules.get('signed-artifact').service.listWhere({ envelopeId: declinedEnvelope.id }).length, 0);
  // A completion after a decline is refused: no order appears later either.
  const lateCompletion = signatureFixture.event(declinedEnvelope.idempotencyKey, 'completed', { providerEventId: 'evt_after_decline' });
  assert.equal((await (await post(lateCompletion.rawBody, lateCompletion.headers)).json()).applied, false);
  assert.equal(app.modules.get('order').service.listWhere({ quoteVersionId: declined.versionId }).length, 0);
  // The quote itself is untouched: M11 never auto-revises a declined quote.
  assert.equal(app.modules.get('quote').service.get(declined.quote.id).status, 'approved');
  assert.equal(app.modules.get('quote').service.get(declined.quote.id).orderId, null);

  // 7. Failed traces are honest, and no failure ever produced an order.
  const failedRuns = app.workflows.listRuns({ status: 'failed', limit: 50 });
  assert.ok(failedRuns.some((run) => run.workflowName === 'quote.request-signature'));
  const spans = app.workflows.getRun(failedRuns.find((run) => run.workflowName === 'quote.request-signature').id).spans;
  assert.ok(spans.some((span) => span.status === 'failed'));
  assert.ok(spans.some((span) => span.name.endsWith('.compensate') && span.status === 'completed'));
  assert.equal(
    app.modules.get('order').service.list().length,
    app.modules.get('signature-envelope').service.list().filter((row) => row.status === 'completed').length,
    'orders exist for exactly the completed envelopes',
  );
});

test('crash recovery, evidence independence and completion fault injection', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'recovery.sqlite');
  // The fixture provider keeps its envelopes in a file for this test, so it
  // survives the CRM process the way a real provider would.
  process.env.ACCORDO_FIXTURE_SIGNATURE_STORE = join(root, 'fixture-provider.json');
  t.after(() => { delete process.env.ACCORDO_FIXTURE_SIGNATURE_STORE; });
  const { signatureFixture } = await fixture(root);
  signatureFixture.reset();
  let context = await boot(root, dbPath);
  t.after(() => context.close());
  const { app, client } = context;
  const actor = { type: 'user', id: 'e2e' };
  const envelopes = app.modules.get('signature-envelope').service;
  const events = app.modules.get('signature-event').service;
  const orders = app.modules.get('order').service;
  const send = (quoteId, versionId, email) => client.module('quote').action(quoteId, 'request-signature', {
    quoteVersionId: versionId, provider: 'fixture-signature', providerVersion: 1, signers: signerList(email),
  });

  // 1. A provider that answers `createEnvelope` with an ALREADY COMPLETED
  //    envelope must still produce the artifact and the order: persisting a
  //    terminal state without them would be unrecoverable, because terminal
  //    states never transition again.
  const { fixtureSignatureProvider } = await fixture(root);
  const realCreate = fixtureSignatureProvider.createEnvelope;
  fixtureSignatureProvider.createEnvelope = async (input) => {
    const created = await realCreate.call(fixtureSignatureProvider, input);
    return {
      ...created,
      status: 'completed',
      completedAt: '2026-08-05T12:00:00.000Z',
      signers: created.signers.map((signer) => ({ ...signer, status: 'signed', decidedAt: '2026-08-05T12:00:00.000Z' })),
    };
  };
  const instant = await approvedQuote(app, { name: 'Instant Deal' });
  await send(instant.quote.id, instant.versionId, 'instant@example.com');
  fixtureSignatureProvider.createEnvelope = realCreate;
  const instantEnvelope = envelopes.listWhere({ quoteVersionId: instant.versionId })[0];
  assert.equal(instantEnvelope.status, 'completed');
  assert.equal(orders.listWhere({ quoteVersionId: instant.versionId }).length, 1, 'an instantly-completed envelope still produces its order');
  assert.equal(app.modules.get('signed-artifact').service.listWhere({ envelopeId: instantEnvelope.id }).length, 1);

  // 2. The commercial parties are snapshotted at request time: a later rename
  //    of the customer must not make the signed package unreproducible and
  //    block completion forever.
  const renamed = await approvedQuote(app, { name: 'Rename Deal' });
  await send(renamed.quote.id, renamed.versionId, 'rename@example.com');
  const renamedEnvelope = envelopes.listWhere({ quoteVersionId: renamed.versionId })[0];
  app.database.raw.prepare('UPDATE companies SET name = ? WHERE id = ?').run('Renamed SpA', renamed.company.id);
  signatureFixture.markCompleted(renamedEnvelope.idempotencyKey);
  const renameEvent = signatureFixture.event(renamedEnvelope.idempotencyKey, 'completed', { providerEventId: 'evt_rename' });
  assert.equal((await app.ingestSignatureEvent({ provider: 'fixture-signature', rawBody: renameEvent.rawBody, headers: renameEvent.headers })).applied, true);
  const renamedOrder = orders.listWhere({ quoteVersionId: renamed.versionId })[0];
  assert.ok(renamedOrder, 'a party rename never blocks completion');
  assert.equal(renamedOrder.customerName, 'Rename Deal SpA', 'the order carries the customer as it was signed');

  // 3. An envelope that answers our idempotency key but is NOT ours — a
  //    different signed document — is refused rather than adopted.
  const foreign = await approvedQuote(app, { name: 'Foreign Envelope Deal' });
  await send(foreign.quote.id, foreign.versionId, 'foreign@example.com');
  const foreignEnvelope = envelopes.listWhere({ quoteVersionId: foreign.versionId })[0];
  const realGet = fixtureSignatureProvider.getEnvelope;
  fixtureSignatureProvider.getEnvelope = async (input) => {
    const found = await realGet.call(fixtureSignatureProvider, input);
    return found ? { ...found, documentHash: 'f'.repeat(64) } : found;
  };
  await assert.rejects(
    () => app.reconcileSignature({ envelopeId: foreignEnvelope.id, actor }),
    (error) => error.code === 'PROVIDER_ENVELOPE_MISMATCH' && error.status === 409,
  );
  fixtureSignatureProvider.getEnvelope = realGet;
  assert.equal(envelopes.get(foreignEnvelope.id).status, 'sent', 'a mismatched envelope is never adopted');
  assert.equal(orders.listWhere({ quoteVersionId: foreign.versionId }).length, 0);

  // 4. A hard process crash between the provider call and local finalization.
  //    The child dies mid-operation; the parent recovers by reconciliation.
  const crashed = await approvedQuote(app, { name: 'Crash Deal' });
  await context.close();
  writeFileSync(join(root, 'crash.mjs'), [
    "import { pathToFileURL } from 'node:url';",
    "import { join } from 'node:path';",
    `const root = ${JSON.stringify(root)};`,
    "const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);",
    `const app = createAccordoApp({ dbPath: ${JSON.stringify(dbPath)} });`,
    "const envelopes = app.modules.get('signature-envelope').service;",
    'const realApply = envelopes.applyManaged.bind(envelopes);',
    'let calls = 0;',
    'envelopes.applyManaged = async (...args) => {',
    // The first applyManaged after the provider call is local finalization:
    // die exactly there, with the provider holding a real envelope.
    '  if (calls++ === 0) process.exit(9);',
    '  return realApply(...args);',
    '};',
    "await app.runAction({ module: 'quote', action: 'request-signature', recordId: " + JSON.stringify(crashed.quote.id) + ',',
    `  input: { quoteVersionId: ${JSON.stringify(crashed.versionId)}, provider: 'fixture-signature', providerVersion: 1, signers: [{ name: 'Mario Rossi', email: 'crash@example.com', role: 'customer', order: 1 }] },`,
    "  actor: { type: 'user', id: 'crash' } });",
    'process.exit(0);',
    '',
  ].join('\n'));
  const crash = spawnSync(process.execPath, ['--no-warnings', join(root, 'crash.mjs')], {
    encoding: 'utf8', cwd: root,
    env: { ...process.env, ACCORDO_FIXTURE_SIGNATURE_STORE: join(root, 'fixture-provider.json') },
  });
  assert.equal(crash.status, 9, `the child must die during finalization (${crash.stderr})`);

  context = await boot(root, dbPath);
  const restarted = context.app;
  const strandedEnvelope = restarted.modules.get('signature-envelope').service.listWhere({ quoteVersionId: crashed.versionId })[0];
  assert.ok(strandedEnvelope, 'the intent survived the crash');
  assert.equal(strandedEnvelope.status, 'preparing', 'a crash before finalization leaves the intent, not a lie');
  assert.equal(strandedEnvelope.providerEnvelopeId, null);
  // Re-requesting is refused: reconciliation is the only recovery path.
  await assert.rejects(
    () => context.client.module('quote').action(crashed.quote.id, 'request-signature', {
      quoteVersionId: crashed.versionId, provider: 'fixture-signature', providerVersion: 1, signers: signerList('crash@example.com'),
    }),
    (error) => error.code === 'ENVELOPE_EXISTS',
  );
  const recovered = await restarted.reconcileSignature({ envelopeId: strandedEnvelope.id, actor });
  assert.equal(recovered.applied, true, 'reconciliation recovers the provider envelope the crash lost');
  assert.equal(restarted.modules.get('signature-envelope').service.get(strandedEnvelope.id).status, 'sent');
  assert.match(restarted.modules.get('signature-envelope').service.get(strandedEnvelope.id).providerEnvelopeId, /^env_/);
  assert.equal(restarted.modules.get('signature-envelope').service.list().filter((row) => row.quoteVersionId === crashed.versionId).length, 1, 'no second envelope was ever created');

  // 5. An event that arrives BEFORE the provider id is known is quarantined,
  //    and the completion is still recoverable — never silently lost.
  const early = await approvedQuote(restarted, { name: 'Early Deal' });
  const earlyKey = `env:quote-version:${early.versionId}`;
  await context.client.module('quote').action(early.quote.id, 'request-signature', {
    quoteVersionId: early.versionId, provider: 'fixture-signature', providerVersion: 1, signers: signerList('early@example.com'),
  });
  const earlyEnvelope = restarted.modules.get('signature-envelope').service.listWhere({ quoteVersionId: early.versionId })[0];
  // Simulate the race: forget the provider id locally, then deliver completion.
  restarted.database.raw.prepare('UPDATE signature_envelopes SET provider_envelope_id = NULL WHERE id = ?').run(earlyEnvelope.id);
  signatureFixture.markCompleted(earlyKey);
  const earlyEvent = signatureFixture.event(earlyKey, 'completed', { providerEventId: 'evt_early' });
  const quarantined = await restarted.ingestSignatureEvent({ provider: 'fixture-signature', rawBody: earlyEvent.rawBody, headers: earlyEvent.headers });
  assert.equal(quarantined.quarantined, true);
  const inboxRow = restarted.modules.get('signature-event').service.listWhere({ providerEventId: 'evt_early' })[0];
  assert.equal(inboxRow.effect, 'quarantined');
  assert.equal(inboxRow.envelopeId, null);
  assert.equal(restarted.modules.get('order').service.listWhere({ quoteVersionId: early.versionId }).length, 0);
  // Reconciliation recovers the completion AND adopts the quarantined evidence.
  const recoveredEarly = await restarted.reconcileSignature({ envelopeId: earlyEnvelope.id, actor });
  assert.equal(recoveredEarly.applied, true);
  assert.equal(restarted.modules.get('order').service.listWhere({ quoteVersionId: early.versionId }).length, 1, 'a quarantined completion is never silently lost');
  assert.equal(
    restarted.modules.get('signature-event').service.listWhere({ providerEventId: 'evt_early' })[0].envelopeId,
    earlyEnvelope.id,
    'the quarantined event is linked to its envelope once the provider id is known',
  );

  // 6. Completion fault injection: a failure at any point rolls the whole
  //    completion back, leaves the event retryable, and a retry produces
  //    exactly one complete order.
  for (const [label, moduleName] of [['artifact', 'signed-artifact'], ['order', 'order'], ['order line', 'order-line'], ['order component', 'order-component'], ['order total', 'order-total']]) {
    const victim = await approvedQuote(restarted, { name: `Fault ${label} Deal` });
    await context.client.module('quote').action(victim.quote.id, 'request-signature', {
      quoteVersionId: victim.versionId, provider: 'fixture-signature', providerVersion: 1, signers: signerList(`fault-${moduleName}@example.com`),
    });
    const victimEnvelope = restarted.modules.get('signature-envelope').service.listWhere({ quoteVersionId: victim.versionId })[0];
    signatureFixture.markCompleted(victimEnvelope.idempotencyKey);
    const service = restarted.modules.get(moduleName).service;
    const realCreateManaged = service.createManaged.bind(service);
    let injected = false;
    service.createManaged = async (...args) => {
      if (!injected) { injected = true; throw new Error(`injected ${label} failure`); }
      return realCreateManaged(...args);
    };
    const faultEvent = signatureFixture.event(victimEnvelope.idempotencyKey, 'completed', { providerEventId: `evt_fault_${moduleName}` });
    await assert.rejects(
      () => restarted.ingestSignatureEvent({ provider: 'fixture-signature', rawBody: faultEvent.rawBody, headers: faultEvent.headers }),
      new RegExp(`injected ${label} failure`),
    );
    service.createManaged = realCreateManaged;
    // Nothing partial survived, and the envelope did not lie about completing.
    assert.equal(restarted.modules.get('signature-envelope').service.get(victimEnvelope.id).status, 'sent', `${label}: no premature completion`);
    assert.equal(restarted.modules.get('order').service.listWhere({ quoteVersionId: victim.versionId }).length, 0, `${label}: no partial order`);
    assert.equal(restarted.modules.get('signed-artifact').service.listWhere({ envelopeId: victimEnvelope.id }).length, 0, `${label}: no orphan artifact`);
    // The inbox row itself is written in the FIRST transaction and survives:
    // it is durable evidence that the provider delivered this event, and it
    // stays unprocessed so a redelivery resumes rather than being stranded.
    const pending = restarted.modules.get('signature-event').service.listWhere({ providerEventId: `evt_fault_${moduleName}` });
    assert.equal(pending.length, 1, `${label}: the delivery is recorded`);
    assert.equal(pending[0].processed, false, `${label}: and is still unprocessed`);
    assert.equal(pending[0].effect, 'pending', `${label}: with no effect claimed`);
    // The retry is the same verified event, and it completes exactly once.
    const retry = await restarted.ingestSignatureEvent({ provider: 'fixture-signature', rawBody: faultEvent.rawBody, headers: faultEvent.headers });
    assert.equal(retry.applied, true, `${label}: the retry resumes and succeeds`);
    assert.equal(retry.duplicate, undefined, `${label}: a failed delivery is resumed, never dismissed as a duplicate`);
    assert.equal(restarted.modules.get('signature-event').service.listWhere({ providerEventId: `evt_fault_${moduleName}` })[0].processed, true);
    const retried = restarted.modules.get('order').service.listWhere({ quoteVersionId: victim.versionId });
    assert.equal(retried.length, 1, `${label}: exactly one order after the retry`);
    assert.equal(restarted.modules.get('order-line').service.countWhere({ orderId: retried[0].id }), 1, `${label}: the order is complete`);
    assert.equal(restarted.modules.get('order-total').service.countWhere({ orderId: retried[0].id }), 2, `${label}: totals are complete`);
  }

  // 7. Order independence: an order renders its whole commercial truth from
  //    order rows alone, with the catalog deactivated and without reading any
  //    catalog, quote or quote-version row.
  const independentOrder = renamedOrder;
  restarted.database.raw.prepare('UPDATE offers SET active = 0').run();
  restarted.database.raw.prepare('UPDATE price_components SET unit_amount_cents = 1').run();
  const rendered = {
    customer: restarted.modules.get('order').service.get(independentOrder.id).customerName,
    currency: restarted.modules.get('order').service.get(independentOrder.id).currency,
    lines: restarted.modules.get('order-line').service.listWhere({ orderId: independentOrder.id }),
    components: restarted.modules.get('order-component').service.listWhere({ orderId: independentOrder.id }),
    tiers: restarted.modules.get('order-tier').service.listWhere({ orderId: independentOrder.id }),
    totals: restarted.modules.get('order-total').service.listWhere({ orderId: independentOrder.id }),
  };
  assert.equal(rendered.customer, 'Rename Deal SpA');
  assert.equal(rendered.currency, 'EUR');
  assert.equal(rendered.lines.length, 1);
  assert.equal(rendered.lines[0].offerName, 'Enterprise Plan');
  assert.equal(rendered.lines[0].quantity, 20);
  assert.equal(rendered.components.length, 3);
  assert.equal(rendered.components.find((row) => row.pricingModel === 'volume').unitAmountCents, null);
  assert.ok(rendered.components.find((row) => row.pricingModel === 'volume').tiersJson.includes('"unitAmountCents":5000'), 'the signed tier prices, not the mutated catalog');
  assert.equal(rendered.tiers.length, 3);
  assert.equal(rendered.totals.length, 2);
  assert.equal(restarted.modules.get('signed-artifact').service.listWhere({ envelopeId: renamedEnvelope.id }).length, 1);

  // 8. Exact indexed lookups stay exact well past the 500-row list bound.
  const inbox = restarted.modules.get('signature-event').service;
  const before = inbox.countWhere({ provider: 'fixture-signature' });
  for (let index = 0; index < 520; index += 1) {
    await inbox.createManaged({
      sourceKey: `sev:bulk:${index}`, provider: 'fixture-signature', providerVersion: 1,
      providerFingerprint: 'f'.repeat(64), providerEventId: `bulk_${index}`, providerEnvelopeId: 'env_bulk',
      payloadFingerprint: 'a'.repeat(64), envelopeId: null, status: 'sent', sequence: index,
      occurredAt: '2026-08-05T12:00:00.000Z', receivedAt: '2026-08-05T12:00:00.000Z',
      processed: true, effect: 'quarantined', effectReason: 'bulk',
    }, { actor });
  }
  assert.equal(inbox.countWhere({ provider: 'fixture-signature' }), before + 520);
  assert.equal(inbox.listWhere({ providerEventId: 'bulk_517' }).length, 1, 'an exact lookup finds a row beyond the list bound');
  assert.equal(inbox.list({ limit: 500 }).length, 500, 'the paged list is bounded, and is never the correctness path');
  assert.equal(restarted.modules.get('signature-envelope').service.listWhere({ quoteVersionId: renamed.versionId }).length, 1);
});

test('audit, events and traces are exact, and hostile input stays inert data', async (t) => {
  const root = project(t);
  const { signatureFixture } = await fixture(root);
  signatureFixture.reset();
  const context = await boot(root, join(root, 'data', 'audit.sqlite'));
  t.after(() => context.close());
  const { app, client, baseUrl } = context;
  const post = (body, headers) => fetch(`${baseUrl}/api/signature/providers/fixture-signature/events`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
  });
  const auditFor = (entityType) => app.audit.list({ entityType, limit: 500 }).length;

  const { quote, versionId } = await approvedQuote(app, { name: 'Audit Deal' });
  const before = {
    envelope: auditFor('signature-envelope'),
    signer: auditFor('signature-signer'),
    event: auditFor('signature-event'),
    artifact: auditFor('signed-artifact'),
    order: auditFor('order'),
  };

  // ---- exact counts for the request ----
  await client.module('quote').action(quote.id, 'request-signature', {
    quoteVersionId: versionId, provider: 'fixture-signature', providerVersion: 1, signers: signerList('audit@example.com'),
  });
  const envelope = app.modules.get('signature-envelope').service.listWhere({ quoteVersionId: versionId })[0];
  assert.equal(auditFor('signature-signer') - before.signer, 1, 'exactly one signer snapshot');
  assert.equal(auditFor('signed-artifact') - before.artifact, 0, 'a request creates no completion evidence');
  assert.equal(auditFor('order') - before.order, 0);
  assert.ok(auditFor('signature-envelope') - before.envelope >= 2, 'the intent creation and the finalize update are both audited');

  // ---- exact counts for one verified completion ----
  signatureFixture.markCompleted(envelope.idempotencyKey);
  const completion = signatureFixture.event(envelope.idempotencyKey, 'completed', { providerEventId: 'evt_audit' });
  await post(completion.rawBody, completion.headers);
  const afterCompletion = {
    envelope: auditFor('signature-envelope'),
    signer: auditFor('signature-signer'),
    event: auditFor('signature-event'),
    artifact: auditFor('signed-artifact'),
    order: auditFor('order'),
  };
  assert.equal(afterCompletion.artifact - before.artifact, 1, 'exactly one artifact creation is audited');
  assert.equal(afterCompletion.order - before.order, 1, 'exactly one order creation is audited');
  assert.equal(afterCompletion.event - before.event, 2, 'the inbox row is created, then marked processed');
  assert.equal(afterCompletion.signer - before.signer, 2, 'the signer snapshot plus its one completion update');

  // ---- a replay adds evidence of nothing ----
  await post(completion.rawBody, completion.headers);
  assert.equal(auditFor('signature-envelope'), afterCompletion.envelope, 'a replay writes no envelope audit');
  assert.equal(auditFor('signature-event'), afterCompletion.event, 'a replay writes no inbox audit');
  assert.equal(auditFor('signed-artifact'), afterCompletion.artifact, 'a replay creates no second artifact');
  assert.equal(auditFor('order'), afterCompletion.order, 'a replay creates no second order');
  assert.equal(app.modules.get('order').service.list().length, 1);

  // ---- the trace tells the truth about phases, and leaks nothing ----
  const runs = app.workflows.listRuns({ limit: 50 });
  const requestRun = app.workflows.getRun(runs.find((run) => run.workflowName === 'quote.request-signature' && run.status === 'completed').id);
  assert.deepEqual(
    requestRun.spans.map((span) => span.name).filter((name) => name.startsWith('quote.request-signature.')),
    ['quote.request-signature.intent', 'quote.request-signature.external', 'quote.request-signature.finalize'],
  );
  const eventRun = app.workflows.getRun(runs.find((run) => run.workflowName === 'signature.event').id);
  const traceText = JSON.stringify(eventRun);
  assert.ok(!traceText.includes('not-a-secret'), 'no verification key in the trace');
  assert.ok(!traceText.includes(completion.headers['x-signature-256']), 'no signature value in the trace');

  // ---- hostile input is stored and rendered as inert data everywhere ----
  const hostile = await approvedQuote(app, { name: 'Hostile Deal' });
  const nasty = '<img src=x onerror=alert(1)>${7*7}`;--  ';
  const sent = await client.module('quote').action(hostile.quote.id, 'request-signature', {
    quoteVersionId: hostile.versionId,
    provider: 'fixture-signature',
    providerVersion: 1,
    signers: [{ name: nasty, email: 'hostile@example.com', role: nasty.slice(0, 40) }],
  });
  assert.equal(sent.result.envelope.status, 'sent');
  const hostileEnvelope = app.modules.get('signature-envelope').service.listWhere({ quoteVersionId: hostile.versionId })[0];
  const hostileSigner = app.modules.get('signature-signer').service.listWhere({ envelopeId: hostileEnvelope.id })[0];
  // Outer whitespace is trimmed by the signer contract; everything else is
  // stored verbatim as text and never interpreted.
  assert.equal(hostileSigner.name, nasty.trim(), 'stored verbatim as text, never interpreted');

  // Prototype-shaped keys in a verified provider payload pollute nothing.
  signatureFixture.markCompleted(hostileEnvelope.idempotencyKey);
  const polluting = JSON.stringify({
    providerEventId: 'evt_hostile',
    providerEnvelopeId: hostileEnvelope.providerEnvelopeId,
    status: 'completed',
    sequence: 1,
    occurredAt: '2026-08-05T12:00:00.000Z',
    __proto__: { polluted: true },
    constructor: 'x',
    prototype: 'y',
    signers: [{ signerKey: hostileSigner.signerKey, status: 'signed', decidedAt: '2026-08-05T12:00:00.000Z' }],
  });
  const pollutingHeaders = signatureFixture.event(hostileEnvelope.idempotencyKey, 'completed', { rawBody: polluting, providerEventId: 'evt_hostile' }).headers;
  const pollutingResult = await (await post(polluting, pollutingHeaders)).json();
  assert.equal(pollutingResult.applied, true);
  assert.equal({}.polluted, undefined, 'no prototype pollution from a provider payload');
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(app.modules.get('order').service.listWhere({ quoteVersionId: hostile.versionId }).length, 1);

  // Unknown, prototype-shaped and wrongly-cased provider names are stable 404s
  // that invoke nothing and leak nothing.
  for (const path of ['/api/signature/providers/unknown-provider/events', '/api/signature/providers/__proto__/events', '/api/signature/providers/FIXTURE-SIGNATURE/events']) {
    const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 404, path);
    assert.ok(!JSON.stringify(await response.json()).includes('not-a-secret'), path);
  }
  await assert.rejects(
    () => client.module('quote').action(hostile.quote.id, 'request-signature', {
      quoteVersionId: hostile.versionId, provider: 'fixture-signature', providerVersion: 99, signers: signerList('v99@example.com'),
    }),
    (error) => error.status === 404 || error.code === 'ENVELOPE_EXISTS',
  );

  // An oversized body is refused by size, before any provider code runs.
  const oversized = await fetch(`${baseUrl}/api/signature/providers/fixture-signature/events`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(70_000),
  });
  assert.equal(oversized.status, 413);
});
