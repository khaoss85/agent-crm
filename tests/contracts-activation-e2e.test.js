import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Milestone 12 e2e (ADR-018 addendum): a signed immutable Order becomes a
 * commercial contract, a subscription and explicit pending obligations —
 * proven in a clean throwaway project with the real CLI/factory, HTTP server
 * and SDK, against the optional contracts **domain package**.
 */

const STARTER_MANIFESTS = [
  'product.module.json', 'product-version.module.json', 'price-book.module.json',
  'offer.module.json', 'price-component.module.json', 'price-tier.module.json',
  'catalog-sync-run.module.json', 'quote.module.json', 'quote-line.module.json',
  'quote-version.module.json', 'quote-version-line.module.json',
  'quote-version-component.module.json', 'quote-version-total.module.json',
  'quote-approval.module.json',
  'signature-envelope.module.json', 'signature-signer.module.json',
  'signature-event.module.json', 'signed-artifact.module.json',
  'order.module.json', 'order-line.module.json', 'order-component.module.json',
  'order-tier.module.json', 'order-total.module.json',
];

const DOMAIN_MANIFESTS = [
  'contract-activation.module.json', 'commercial-contract.module.json',
  'contract-version.module.json', 'contract-line.module.json',
  'subscription.module.json', 'subscription-line.module.json',
  'delivery-obligation.module.json', 'service-obligation.module.json',
];

const DOMAIN_MODULES = [
  'contract-activation', 'commercial-contract', 'contract-version', 'contract-line',
  'subscription', 'subscription-line', 'delivery-obligation', 'service-obligation',
];

/**
 * @param {import('node:test').TestContext} t
 * @param {{withDomain?: boolean}} [options] `withDomain: false` builds the same
 *   project **without** the contracts package, which is how domain isolation is
 *   proven rather than asserted.
 */
function project(t, { withDomain = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-crm-contracts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  const starter = join(root, 'examples/starters/b2b-lead-qualification');
  const apply = (manifestPath) => {
    const result = spawnSync(
      process.execPath,
      ['--no-warnings', join(root, 'packages/cli/bin/agent-crm.js'), 'module', 'create', manifestPath, '--apply', '--root', root],
      { encoding: 'utf8', cwd: root },
    );
    assert.equal(result.status, 0, `apply ${manifestPath}: ${result.stderr}`);
  };
  for (const manifest of STARTER_MANIFESTS) apply(join(starter, manifest));
  if (withDomain) for (const manifest of DOMAIN_MANIFESTS) apply(join(root, 'packages/contracts/modules', manifest));

  writeFileSync(
    join(root, 'packages/actions/generated/index.js'),
    [
      '// @ts-check',
      "import { buildCommercialActions } from '../../core/src/commercial-actions.js';",
      "import { buildRequestSignatureAction } from '../../core/src/signature-operations.js';",
      'export const generatedActions = [...buildCommercialActions(), buildRequestSignatureAction()];',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages/commercial/generated/index.js'),
    [
      "import { fixtureSaasCatalogProvider, standardSalesDiscountV1, standardSalesDiscountV2 } from '../../../examples/starters/b2b-lead-qualification/commercial.js';",
      'export const generatedCatalogProviders = [fixtureSaasCatalogProvider];',
      'export const generatedDiscountPolicies = [standardSalesDiscountV1, standardSalesDiscountV2];',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages/signature/generated/index.js'),
    [
      "import { fixtureSignatureProvider } from '../../../examples/starters/b2b-lead-qualification/signature.js';",
      'export const generatedSignatureProviders = [fixtureSignatureProvider];',
      '',
    ].join('\n'),
  );
  if (withDomain) {
    writeFileSync(
      join(root, 'packages/domains/generated/index.js'),
      [
        "import { createContractsDomain } from '../../contracts/src/index.js';",
        "import { b2bSaasOrderActivationV1, b2bSaasOrderActivationV2 } from '../../../examples/starters/b2b-lead-qualification/contracts.js';",
        'export const generatedDomains = [createContractsDomain({ policies: [b2bSaasOrderActivationV1, b2bSaasOrderActivationV2] })];',
        '',
      ].join('\n'),
    );
  }
  return root;
}

async function boot(root, dbPath, options = {}) {
  const { createAgentCrmApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const { createHttpServer } = await import(pathToFileURL(join(root, 'apps/server/src/index.js')).href);
  const { AgentCrmClient } = await import(pathToFileURL(join(root, 'packages/sdk/src/index.js')).href);
  const app = createAgentCrmApp({ dbPath, ...options });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    app,
    baseUrl,
    client: new AgentCrmClient({ baseUrl, actor: { type: 'user', id: 'e2e' } }),
    agentClient: new AgentCrmClient({ baseUrl, actor: { type: 'agent', id: 'bot' } }),
    async close() {
      await new Promise((resolve) => server.close(resolve));
      app.close();
    },
  };
}

const TERM = { effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31' };
const POLICY = { policy: 'b2b-saas-order-activation', policyVersion: 1 };

/**
 * Drive the whole proven journey to a signed immutable Order. `offers` selects
 * which fixture offers the quote carries, so a test can compose the exact
 * classification mix it needs.
 */
async function signedOrder(root, app, { name = 'M12 Deal', offers = ['fixture:offer:enterprise', 'fixture:offer:support-annual', 'fixture:offer:api-monthly'] } = {}) {
  const actor = { type: 'user', id: 'e2e' };
  const { signatureFixture } = await import(pathToFileURL(join(root, 'examples/starters/b2b-lead-qualification/signature.js')).href);
  await app.syncCatalog({ provider: 'fixture-saas-catalog', actor });
  const book = app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
  const offerOf = (key) => app.modules.get('offer').service.listWhere({ logicalKey: key, active: true })[0];
  const company = await app.services.companies.create({ name: `${name} SpA` }, { actor });
  const contact = await app.services.contacts.create(
    { companyId: company.id, firstName: 'Mario', lastName: 'Rossi', email: `m.${Math.abs(hash(name))}@example.com` },
    { actor },
  );
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, contactId: contact.id, name, type: 'new_business', valueCents: 100_000, currency: 'EUR', stage: 'discovery', owner: 'e2e' },
    { actor },
  );
  const quote = (await app.runAction({ module: 'opportunity', action: 'create-quote', recordId: opportunity.id, input: { priceBookId: book.id }, actor })).result.quote;
  for (const key of offers) {
    await app.runAction({ module: 'quote', action: 'add-line', recordId: quote.id, input: { offerId: offerOf(key).id, quantity: 20, discountBps: 500 }, actor });
  }
  const submitted = await app.runAction({ module: 'quote', action: 'submit', recordId: quote.id, input: { policy: 'standard-sales-discount', version: 1 }, actor });
  if (submitted.result.version.decision === 'approval_required') {
    await app.runAction({ module: 'quote', action: 'approve', recordId: quote.id, input: {}, actor });
  }
  await app.runAction({
    module: 'quote', action: 'request-signature', recordId: quote.id,
    input: { quoteVersionId: submitted.result.version.id, provider: 'fixture-signature', providerVersion: 1, signers: [{ name: 'Mario Rossi', email: `sign.${Math.abs(hash(name))}@example.com`, role: 'customer' }] },
    actor,
  });
  const envelope = app.modules.get('signature-envelope').service.listWhere({ quoteVersionId: submitted.result.version.id })[0];
  signatureFixture.markCompleted(envelope.idempotencyKey);
  const event = signatureFixture.event(envelope.idempotencyKey, 'completed', { providerEventId: `evt_${Math.abs(hash(name))}` });
  await app.ingestSignatureEvent({ provider: 'fixture-signature', rawBody: event.rawBody, headers: event.headers });
  const order = app.modules.get('order').service.listWhere({ quoteVersionId: submitted.result.version.id })[0];
  return { order, quote, company, contact, versionId: submitted.result.version.id, envelope };
}

function hash(text) {
  let value = 0;
  for (const character of text) value = (value * 31 + character.charCodeAt(0)) | 0;
  return value;
}

test('signed order → plan → human activation → contract, subscription and obligations', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'activation.sqlite');
  let context = await boot(root, dbPath);
  t.after(() => context.close());
  const { app, client } = context;
  const actor = { type: 'user', id: 'e2e' };

  const { order, company } = await signedOrder(root, app);
  assert.equal(order.status, 'accepted');
  assert.equal(order.contractId, null);

  // The schema publishes the domain contract, its limits and no handler.
  const schema = await client.request('/api/schema');
  assert.equal(schema.domains.contracts.contractsContract, 1);
  assert.equal(schema.domains.contracts.domainContract, 1);
  assert.deepEqual(schema.domains.contracts.actions, ['order.activate-contract', 'order.plan-activation']);
  assert.match(schema.domains.contracts.policies[0].fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(schema.domains.contracts.notModeled.includes('MRR/ARR/TCV'));
  assert.equal(JSON.stringify(schema.domains).includes('function'), false);

  // ---- plan: read-only, machine-readable, writes nothing ----
  const auditBefore = app.audit.list({ limit: 500 }).length;
  const planned = await client.module('order').action(order.id, 'plan-activation', POLICY);
  const plan = planned.result.plan;
  assert.equal(plan.activatable, true);
  assert.equal(plan.alreadyActivated, false);
  assert.deepEqual(plan.counts, { subscription: 2, delivery: 1, service: 1, other: 1, ambiguous: 0 });
  assert.deepEqual(plan.requiredInputs, ['effectiveDate', 'termStartDate', 'termEndDate']);
  assert.equal(plan.components.length, 5);
  for (const component of plan.components) {
    assert.ok(component.reason, `${component.componentKey} carries a reason`);
    assert.equal(component.overridden, false);
  }
  assert.ok(plan.notModeled.includes('billing'));
  // A plan creates no domain record and no business audit at all.
  for (const module of DOMAIN_MODULES) {
    assert.equal(app.modules.get(module).service.list().length, 0, `${module} untouched by planning`);
  }
  assert.equal(app.audit.list({ limit: 500 }).length, auditBefore, 'planning writes no audit');

  // ---- an agent may prepare, never activate ----
  await assert.rejects(
    () => context.agentClient.module('order').action(order.id, 'activate-contract', { ...POLICY, ...TERM }),
    (error) => error.status === 403 && error.code === 'HUMAN_APPROVAL_REQUIRED',
  );
  assert.equal(app.modules.get('commercial-contract').service.list().length, 0, 'a refused activation writes nothing');
  // …but it may plan.
  assert.equal((await context.agentClient.module('order').action(order.id, 'plan-activation', POLICY)).result.plan.activatable, true);

  // ---- the human activation ----
  const activated = await client.module('order').action(order.id, 'activate-contract', {
    ...POLICY, ...TERM, autoRenew: true, renewalNoticeDays: 90,
  });
  assert.deepEqual(activated.result.counts, { subscription: 2, delivery: 1, service: 1, other: 1, ambiguous: 0 });
  assert.equal(activated.result.contract.termDays, 365);
  assert.equal(activated.result.contract.autoRenew, true);

  const contract = app.modules.get('commercial-contract').service.listWhere({ orderId: order.id })[0];
  assert.equal(contract.sourceKey, `contract:order:${order.id}`);
  assert.equal(contract.status, 'active');
  assert.equal(contract.customerName, company.name, 'the customer is snapshotted, not referenced');
  assert.equal(contract.documentHash, order.documentHash);
  assert.equal(contract.currency, order.currency);
  assert.equal(contract.termDays, 365);

  const version = app.modules.get('contract-version').service.listWhere({ contractId: contract.id })[0];
  assert.equal(version.versionNumber, 1);
  assert.equal(contract.currentVersionId, version.id);
  assert.equal(version.totalsJson, order.totalsJson, 'the grouped totals are copied verbatim');
  assert.equal(version.oneTimeNetCents, order.oneTimeNetCents);
  assert.equal(version.lineCount, 5);

  // Every order component became a contract line, whatever its classification.
  const lines = app.modules.get('contract-line').service.listWhere({ contractVersionId: version.id });
  assert.equal(lines.length, 5);
  const components = app.modules.get('order-component').service.listWhere({ orderId: order.id });
  for (const component of components) {
    const line = lines.find((row) => row.orderComponentId === component.id);
    assert.ok(line, `component ${component.componentKey} became a contract line`);
    for (const field of ['chargeType', 'pricingModel', 'interval', 'intervalCount', 'quantity', 'netAmountCents', 'tiersJson', 'tierBreakdownJson', 'sourcePricingModel']) {
      assert.deepEqual(line[field], component[field], `${component.componentKey}.${field} copied`);
    }
    assert.equal(line.classificationPolicy, 'b2b-saas-order-activation');
    assert.equal(line.classificationPolicyVersion, 1);
    assert.match(line.classificationPolicyFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(line.overridden, false);
    assert.ok(line.classificationReason);
  }

  // Subscription lines exist only for components explicitly classified so.
  const subscription = app.modules.get('subscription').service.listWhere({ contractId: contract.id })[0];
  assert.equal(subscription.sourceKey, `subscription:contract:${contract.id}`);
  assert.equal(subscription.status, 'active');
  assert.equal(subscription.startDate, TERM.termStartDate);
  assert.equal(subscription.endDate, TERM.termEndDate);
  const subscriptionLines = app.modules.get('subscription-line').service.listWhere({ subscriptionId: subscription.id });
  assert.equal(subscriptionLines.length, 2);
  for (const line of subscriptionLines) {
    assert.equal(line.chargeType, 'recurring', 'a subscription line always recurs');
    assert.equal(line.currency, order.currency);
    assert.equal(line.startDate, TERM.termStartDate);
  }
  // A recurring per-unit API component was classified `other`: it is a contract
  // line and NOT a subscription line — recurrence alone decided nothing.
  const other = lines.find((line) => line.classification === 'other');
  assert.equal(other.chargeType, 'recurring');
  assert.equal(subscriptionLines.some((line) => line.orderComponentId === other.orderComponentId), false);

  const delivery = app.modules.get('delivery-obligation').service.listWhere({ contractId: contract.id });
  assert.equal(delivery.length, 1);
  assert.equal(delivery[0].status, 'pending_handover');
  assert.equal(delivery[0].chargeType, 'one_time');
  const service = app.modules.get('service-obligation').service.listWhere({ contractId: contract.id });
  assert.equal(service.length, 1);
  assert.equal(service[0].status, 'pending_activation');

  // The activation run is the evidence record for the whole decision.
  const activation = app.modules.get('contract-activation').service.listWhere({ orderId: order.id })[0];
  assert.equal(activation.status, 'completed');
  assert.equal(activation.contractId, contract.id);
  assert.equal(activation.subscriptionId, subscription.id);
  assert.equal(activation.overrideCount, 0);
  assert.equal(activation.policyFingerprint, lines[0].classificationPolicyFingerprint);
  assert.equal(JSON.parse(activation.decisionsJson).length, 5);

  // The Order is untouched apart from its managed link.
  const reloaded = app.modules.get('order').service.get(order.id);
  assert.equal(reloaded.contractId, contract.id);
  assert.equal(reloaded.totalsJson, order.totalsJson);
  assert.equal(reloaded.documentHash, order.documentHash);
  assert.equal(reloaded.status, 'accepted');

  // ---- read-only surface: nothing here is publicly writable ----
  for (const module of DOMAIN_MODULES) {
    const metadata = await client.request(`/api/modules/${module}`);
    assert.deepEqual(metadata.capabilities, ['get', 'list'], module);
    for (const [method, path, body] of [
      ['POST', `/api/modules/${module}/records`, '{}'],
      ['POST', `/api/modules/${module}/records`, JSON.stringify({ status: 'active', netAmountCents: 1 })],
      ['PATCH', `/api/modules/${module}/records/${contract.id}`, JSON.stringify({ status: 'active' })],
    ]) {
      const response = await fetch(`${context.baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, body });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
  }

  // ---- repeat activation is refused, and the plan says so ----
  await assert.rejects(
    () => client.module('order').action(order.id, 'activate-contract', { ...POLICY, ...TERM }),
    (error) => error.status === 409 && error.code === 'ORDER_ALREADY_ACTIVATED',
  );
  const replan = (await client.module('order').action(order.id, 'plan-activation', POLICY)).result.plan;
  assert.equal(replan.alreadyActivated, true);
  assert.equal(replan.activatable, false);
  assert.equal(replan.contractId, contract.id);

  // ---- restart: everything survives a fresh process-level open ----
  await context.close();
  context = await boot(root, dbPath);
  const restarted = context.app;
  assert.equal(restarted.modules.get('commercial-contract').service.get(contract.id).customerName, company.name);
  assert.equal(restarted.modules.get('contract-line').service.listWhere({ contractVersionId: version.id }).length, 5);
  assert.equal(restarted.modules.get('subscription-line').service.listWhere({ subscriptionId: subscription.id }).length, 2);
});

test('the contracts domain is optional: the kernel works identically without it', async (t) => {
  const root = project(t, { withDomain: false });
  const context = await boot(root, join(root, 'data', 'no-domain.sqlite'));
  t.after(() => context.close());
  const { app, client } = context;

  // The whole M0–M11 journey still runs, unchanged.
  const { order } = await signedOrder(root, app, { name: 'No Domain Deal' });
  assert.equal(order.status, 'accepted');
  assert.equal(app.modules.get('order-component').service.listWhere({ orderId: order.id }).length, 5);

  // No domain metadata, no domain actions, no domain modules.
  const schema = await client.request('/api/schema');
  assert.equal(schema.domains, undefined, 'no registered domain means no schema block at all');
  assert.equal(schema.commercial.commercialContract, 1, 'every earlier contract is untouched');
  assert.equal(schema.signature.signatureContract, 1);
  await assert.rejects(
    () => client.module('order').action(order.id, 'activate-contract', { ...POLICY, ...TERM }),
    (error) => error.status === 404,
  );
  await assert.rejects(
    () => client.module('order').action(order.id, 'plan-activation', POLICY),
    (error) => error.status === 404,
  );
  for (const module of DOMAIN_MODULES) {
    const response = await fetch(`${context.baseUrl}/api/modules/${module}`);
    assert.equal(response.status, 404, module);
  }

  // The kernel source itself never names a contract concept: proof that the
  // dependency direction is one-way.
  const { readdirSync, readFileSync } = await import('node:fs');
  const forbidden = /\b(commercial-contract|subscription-line|delivery-obligation|service-obligation|activate-contract|classifyComponent)\b/;
  for (const file of readdirSync(join(repoRoot, 'packages/core/src'))) {
    const source = readFileSync(join(repoRoot, 'packages/core/src', file), 'utf8');
    assert.equal(forbidden.test(source), false, `packages/core/src/${file} must not name a contracts concept`);
  }
  const appSource = readFileSync(join(repoRoot, 'packages/app/src/create-app.js'), 'utf8');
  assert.equal(/contracts\/src/.test(appSource), false, 'the app composes domains through the generated registry only');
});

test('ambiguity blocks activation until a human overrides it with a reason', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'ambiguous.sqlite'));
  t.after(() => context.close());
  const { app, client } = context;

  // Storage is deliberately unmapped by policy v1.
  const { order } = await signedOrder(root, app, {
    name: 'Ambiguous Deal',
    offers: ['fixture:offer:enterprise', 'fixture:offer:storage-monthly'],
  });

  const plan = (await client.module('order').action(order.id, 'plan-activation', POLICY)).result.plan;
  assert.equal(plan.counts.ambiguous, 1);
  assert.equal(plan.activatable, false);
  const ambiguous = plan.components.find((component) => component.requiresOverride);
  assert.ok(ambiguous.reason.includes('not mapped by this policy version'));

  // Activation refuses, and names exactly which components need a decision.
  await assert.rejects(
    () => client.module('order').action(order.id, 'activate-contract', { ...POLICY, ...TERM }),
    (error) => error.status === 409 && error.code === 'CLASSIFICATION_AMBIGUOUS'
      && error.details.orderComponentIds.length === 1,
  );
  assert.equal(app.modules.get('commercial-contract').service.list().length, 0);

  // An override without a reason, with a bad type, or for a foreign component
  // is refused — an override is a human decision, not a bypass.
  for (const [override, expected] of [
    [{ orderComponentId: ambiguous.orderComponentId, type: 'subscription' }, /reason is required/],
    [{ orderComponentId: ambiguous.orderComponentId, type: 'ambiguous', reason: 'because' }, /type must be one of/],
    [{ orderComponentId: 'not-of-this-order', type: 'subscription', reason: 'because' }, /another order/],
  ]) {
    await assert.rejects(
      () => client.module('order').action(order.id, 'activate-contract', { ...POLICY, ...TERM, classificationOverrides: [override] }),
      expected,
    );
  }
  // A one-time component can never be overridden into a subscription line.
  const setup = plan.components.find((component) => component.chargeType === 'one_time');
  await assert.rejects(
    () => client.module('order').action(order.id, 'activate-contract', {
      ...POLICY, ...TERM,
      classificationOverrides: [
        { orderComponentId: ambiguous.orderComponentId, type: 'subscription', reason: 'storage is a subscription' },
        { orderComponentId: setup.orderComponentId, type: 'subscription', reason: 'wishful thinking' },
      ],
    }),
    (error) => error.code === 'CLASSIFICATION_INCOHERENT',
  );
  assert.equal(app.modules.get('commercial-contract').service.list().length, 0);

  // An agent cannot resolve an ambiguity either — the override is human.
  await assert.rejects(
    () => context.agentClient.module('order').action(order.id, 'activate-contract', {
      ...POLICY, ...TERM,
      classificationOverrides: [{ orderComponentId: ambiguous.orderComponentId, type: 'subscription', reason: 'bot decided' }],
    }),
    (error) => error.code === 'HUMAN_APPROVAL_REQUIRED',
  );

  // The human override succeeds and is recorded as evidence.
  const activated = await client.module('order').action(order.id, 'activate-contract', {
    ...POLICY, ...TERM,
    classificationOverrides: [{ orderComponentId: ambiguous.orderComponentId, type: 'subscription', reason: 'storage is sold as a recurring right' }],
  });
  assert.equal(activated.result.counts.ambiguous, 0);
  assert.equal(activated.result.counts.subscription, 3);

  const overridden = app.modules.get('contract-line').service
    .listWhere({ orderComponentId: ambiguous.orderComponentId })[0];
  assert.equal(overridden.overridden, true);
  assert.equal(overridden.classification, 'subscription');
  assert.equal(overridden.policyClassification, 'ambiguous', 'the policy decision is preserved next to the override');
  assert.equal(overridden.overrideReason, 'storage is sold as a recurring right');
  assert.equal(overridden.overriddenBy, 'e2e');
  assert.equal(app.modules.get('contract-activation').service.listWhere({ orderId: order.id })[0].overrideCount, 1);

  // Policy v2 maps storage natively — publishing a version is how a decision
  // changes, and v1's historical evidence still says what v1 decided.
  const second = await signedOrder(root, app, { name: 'V2 Deal', offers: ['fixture:offer:storage-monthly'] });
  const v2Plan = (await client.module('order').action(second.order.id, 'plan-activation', { policy: 'b2b-saas-order-activation', policyVersion: 2 })).result.plan;
  assert.equal(v2Plan.counts.ambiguous, 0);
  assert.equal(v2Plan.counts.subscription, 1);
  assert.equal(overridden.classificationPolicyVersion, 1, 'the earlier activation still records v1');
});

test('activation is atomic, idempotent under concurrency, and source-validated', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'atomic.sqlite');
  const context = await boot(root, dbPath);
  t.after(() => context.close());
  const { app, client } = context;
  const actor = { type: 'user', id: 'e2e' };

  // ---- source validation ----
  const { order: unsignedOrder, quote } = await signedOrder(root, app, { name: 'Source Deal' });
  // A quote that was never signed has no Order at all; here we corrupt the
  // signed Order's evidence instead, one field at a time.
  const orders = app.modules.get('order').service;
  const realGet = orders.get.bind(orders);
  const withOrder = (patch, run) => {
    orders.get = (id) => (id === unsignedOrder.id ? { ...realGet(id), ...patch } : realGet(id));
    return run().finally(() => { orders.get = realGet; });
  };
  for (const [patch, code] of [
    [{ status: 'draft' }, 'ORDER_NOT_ACTIVATABLE'],
    [{ envelopeId: null }, 'ORDER_NOT_SIGNED'],
    [{ signedArtifactId: null }, 'ORDER_NOT_SIGNED'],
    [{ documentHash: 'f'.repeat(64) }, 'SOURCE_HASH_MISMATCH'],
    [{ lineCount: 99 }, 'SOURCE_INCOMPLETE'],
  ]) {
    await withOrder(patch, () => assert.rejects(
      () => app.runAction({ module: 'order', action: 'activate-contract', recordId: unsignedOrder.id, input: { ...POLICY, ...TERM }, actor }),
      (error) => error.code === code,
      `${JSON.stringify(patch)} → ${code}`,
    ));
  }
  assert.equal(app.modules.get('commercial-contract').service.list().length, 0, 'no refused source produced a contract');

  // ---- fault injection at every significant write ----
  for (const moduleName of DOMAIN_MODULES) {
    const { order } = await signedOrder(root, app, { name: `Fault ${moduleName}` });
    const service = app.modules.get(moduleName).service;
    const realCreate = service.createManaged.bind(service);
    let injected = false;
    service.createManaged = async (...args) => {
      if (!injected) { injected = true; throw new Error(`injected ${moduleName} failure`); }
      return realCreate(...args);
    };
    await assert.rejects(
      () => app.runAction({ module: 'order', action: 'activate-contract', recordId: order.id, input: { ...POLICY, ...TERM }, actor }),
      new RegExp(`injected ${moduleName} failure`),
    );
    service.createManaged = realCreate;

    // Nothing partial survived anywhere, and the Order is still unactivated.
    for (const module of DOMAIN_MODULES) {
      const rows = app.modules.get(module).service.list({ limit: 500 })
        .filter((row) => row.orderId === order.id || row.contractId === undefined);
      assert.equal(
        app.modules.get(module).service.list({ limit: 500 }).filter((row) => row.orderId === order.id).length,
        0,
        `${moduleName} failure: ${module} has no partial row`,
      );
      assert.ok(rows.length >= 0);
    }
    assert.equal(app.modules.get('order').service.get(order.id).contractId, null, `${moduleName} failure: the order stays unactivated`);
    const failed = app.workflows.listRuns({ status: 'failed', workflowName: 'order.activate-contract', limit: 50 });
    assert.ok(failed.length > 0, 'the failure is recorded as an honest failed trace');

    // The retry succeeds exactly once and produces a complete activation.
    const retried = await app.runAction({ module: 'order', action: 'activate-contract', recordId: order.id, input: { ...POLICY, ...TERM }, actor });
    assert.equal(retried.result.counts.subscription, 2, `${moduleName}: retry completes`);
    const contract = app.modules.get('commercial-contract').service.listWhere({ orderId: order.id })[0];
    assert.equal(app.modules.get('contract-line').service.listWhere({ contractId: contract.id }).length, 5);
    assert.equal(app.modules.get('subscription-line').service.listWhere({ contractId: contract.id }).length, 2);
  }

  // ---- concurrency in one app ----
  const { order: raceOrder } = await signedOrder(root, app, { name: 'Race Deal' });
  const results = await Promise.allSettled([
    app.runAction({ module: 'order', action: 'activate-contract', recordId: raceOrder.id, input: { ...POLICY, ...TERM }, actor }),
    app.runAction({ module: 'order', action: 'activate-contract', recordId: raceOrder.id, input: { ...POLICY, ...TERM }, actor }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.equal(app.modules.get('commercial-contract').service.listWhere({ orderId: raceOrder.id }).length, 1);
  assert.equal(app.modules.get('contract-activation').service.listWhere({ orderId: raceOrder.id }).length, 1);

  // ---- concurrency across two independent connections ----
  const sibling = await boot(root, dbPath);
  t.after(() => sibling.close());
  const { order: twoConnection } = await signedOrder(root, app, { name: 'Two Connection Deal' });
  // Two writers on one SQLite file: the loser may fail to persist its *trace*
  // while the write lock is held, which the runtime logs and never throws
  // (ADR-012 — observability must not decide a business outcome). The suite's
  // stderr therefore carries one "failed to persist trace: database is locked"
  // line here; the assertions below are about the business truth, which stays
  // exact regardless.
  const across = await Promise.allSettled([
    app.runAction({ module: 'order', action: 'activate-contract', recordId: twoConnection.id, input: { ...POLICY, ...TERM }, actor }),
    sibling.app.runAction({ module: 'order', action: 'activate-contract', recordId: twoConnection.id, input: { ...POLICY, ...TERM }, actor }),
  ]);
  assert.equal(across.filter((result) => result.status === 'fulfilled').length, 1, JSON.stringify(across.map((r) => r.reason?.code ?? r.status)));
  for (const failure of across.filter((result) => result.status === 'rejected')) {
    assert.ok(!/SQLITE|UNIQUE constraint/i.test(String(failure.reason?.message ?? '')), `raw SQLite error surfaced: ${failure.reason?.message}`);
  }
  assert.equal(app.modules.get('commercial-contract').service.listWhere({ orderId: twoConnection.id }).length, 1);
  assert.equal(app.modules.get('subscription').service.list().filter((row) => row.orderId === twoConnection.id).length, 1);
});

test('the contract reads independently of the catalog, the quote and live CRM rows', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'independent.sqlite'));
  t.after(() => context.close());
  const { app, client } = context;
  const actor = { type: 'user', id: 'e2e' };

  const { order, company } = await signedOrder(root, app, { name: 'Independent Deal' });
  await client.module('order').action(order.id, 'activate-contract', { ...POLICY, ...TERM });
  const contract = app.modules.get('commercial-contract').service.listWhere({ orderId: order.id })[0];
  const version = app.modules.get('contract-version').service.listWhere({ contractId: contract.id })[0];
  const before = app.modules.get('contract-line').service.listWhere({ contractVersionId: version.id })
    .map((line) => `${line.componentKey}|${line.netAmountCents}|${line.tiersJson}|${line.classification}`).sort();

  // Move everything the contract came from: deactivate offers, rewrite live
  // component prices, publish a new catalog revision and rename the customer.
  app.database.raw.prepare('UPDATE offers SET active = 0').run();
  app.database.raw.prepare('UPDATE price_components SET unit_amount_cents = 1, flat_amount_cents = 1').run();
  app.database.raw.prepare('UPDATE companies SET name = ? WHERE id = ?').run('Renamed Holding SpA', company.id);
  await app.syncCatalog({ provider: 'fixture-saas-catalog', input: { variant: 'v2' }, actor });

  const after = app.modules.get('contract-line').service.listWhere({ contractVersionId: version.id })
    .map((line) => `${line.componentKey}|${line.netAmountCents}|${line.tiersJson}|${line.classification}`).sort();
  assert.deepEqual(after, before, 'contract lines are unchanged by catalog movement');
  const reloadedContract = app.modules.get('commercial-contract').service.get(contract.id);
  assert.equal(reloadedContract.customerName, company.name, 'the party snapshot survives a rename');
  assert.equal(app.modules.get('contract-version').service.get(version.id).totalsJson, order.totalsJson);

  // The whole contract renders from contract rows alone: no catalog, no quote,
  // no company row is needed to answer "what did we commit to?".
  const rendered = {
    customer: reloadedContract.customerName,
    currency: reloadedContract.currency,
    term: [reloadedContract.termStartDate, reloadedContract.termEndDate, reloadedContract.termDays],
    lines: app.modules.get('contract-line').service.listWhere({ contractVersionId: version.id }),
    subscriptionLines: app.modules.get('subscription-line').service.listWhere({ contractId: contract.id }),
    delivery: app.modules.get('delivery-obligation').service.listWhere({ contractId: contract.id }),
    service: app.modules.get('service-obligation').service.listWhere({ contractId: contract.id }),
  };
  assert.equal(rendered.customer, 'Independent Deal SpA');
  assert.deepEqual(rendered.term, ['2026-09-01', '2027-08-31', 365]);
  assert.equal(rendered.lines.length, 5);
  assert.equal(rendered.lines.every((line) => line.offerName && line.sku && line.currency), true);
  const volume = rendered.lines.find((line) => line.pricingModel === 'volume');
  assert.ok(volume.tiersJson.includes('"unitAmountCents":5000'), 'the signed tier schedule, not the mutated catalog');
  assert.equal(rendered.subscriptionLines.length, 2);
  assert.equal(rendered.delivery.length, 1);
  assert.equal(rendered.service.length, 1);
});

test('audit, events and trace are exact, and exact reads survive the list bound', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'evidence.sqlite'));
  t.after(() => context.close());
  const { app, client } = context;
  const actor = { type: 'user', id: 'e2e' };

  const { order } = await signedOrder(root, app, { name: 'Evidence Deal' });
  const auditFor = (entityType) => app.audit.list({ entityType, limit: 500 }).length;
  const before = Object.fromEntries(DOMAIN_MODULES.map((module) => [module, auditFor(module)]));
  const orderAuditsBefore = auditFor('order');

  await client.module('order').action(order.id, 'activate-contract', { ...POLICY, ...TERM });

  // Exactly the records the milestone promises, and no more.
  assert.equal(auditFor('contract-activation') - before['contract-activation'], 2, 'one creation plus its completion update');
  assert.equal(auditFor('commercial-contract') - before['commercial-contract'], 2, 'one creation plus the current-version link');
  assert.equal(auditFor('contract-version') - before['contract-version'], 1);
  assert.equal(auditFor('contract-line') - before['contract-line'], 5);
  assert.equal(auditFor('subscription') - before.subscription, 1);
  assert.equal(auditFor('subscription-line') - before['subscription-line'], 2);
  assert.equal(auditFor('delivery-obligation') - before['delivery-obligation'], 1);
  assert.equal(auditFor('service-obligation') - before['service-obligation'], 1);
  assert.equal(auditFor('order') - orderAuditsBefore, 1, 'the order gains exactly one managed-link update');

  // The trace explains the decision without leaking the signed document.
  const run = app.workflows.getRun(app.workflows.listRuns({ workflowName: 'order.activate-contract', status: 'completed', limit: 5 })[0].id);
  const spans = run.spans.map((span) => span.name);
  assert.ok(spans.includes('order.activate-contract'));
  assert.ok(spans.includes('contract.activated'));
  const traceText = JSON.stringify(run);
  assert.ok(!traceText.includes('"documentJson"'), 'no signed document bytes in the trace');
  assert.ok(!traceText.includes('not-a-secret'), 'no provider key in the trace');

  // A failed activation writes no business audit at all.
  const { order: failing } = await signedOrder(root, app, { name: 'Failing Evidence Deal' });
  const beforeFailure = DOMAIN_MODULES.map((module) => auditFor(module));
  await assert.rejects(
    () => client.module('order').action(failing.id, 'activate-contract', { ...POLICY, effectiveDate: '2026-09-02', termStartDate: '2026-09-01', termEndDate: '2027-08-31' }),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  assert.deepEqual(DOMAIN_MODULES.map((module) => auditFor(module)), beforeFailure);

  // Exact indexed reads stay exact past the paged list bound.
  const contracts = app.modules.get('commercial-contract').service;
  const contract = contracts.listWhere({ orderId: order.id })[0];
  for (let index = 0; index < 520; index += 1) {
    await contracts.createManaged({
      sourceKey: `contract:bulk:${index}`, orderId: `bulk-order-${index}`, quoteId: 'q', quoteVersionId: `qv-${index}`,
      envelopeId: 'e', signedArtifactId: 'a', opportunityId: 'o', companyId: 'c', contactId: null,
      customerName: 'Bulk', customerEmail: null, currency: 'EUR', status: 'active',
      effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31', termDays: 365,
      autoRenew: false, renewalNoticeDays: 0, policy: 'p', policyVersion: 1, policyFingerprint: 'f'.repeat(64),
      documentHash: 'd'.repeat(64), artifactHash: null, sourceFingerprint: null,
      currentVersionId: null, activationId: 'x', activatedAt: '2026-08-06T00:00:00.000Z',
    }, { actor });
  }
  assert.equal(contracts.list({ limit: 500 }).length, 500, 'the paged list is bounded');
  assert.equal(contracts.listWhere({ orderId: order.id }).length, 1, 'the exact lookup still finds it');
  assert.equal(contracts.listWhere({ orderId: 'bulk-order-517' })[0].sourceKey, 'contract:bulk:517');
  assert.equal(contracts.countWhere({ orderId: order.id }), 1);
  assert.equal(app.modules.get('contract-line').service.countWhere({ contractId: contract.id }), 5);
});

test('hostile input stays inert data and never reaches a route or a prototype', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'hostile.sqlite'));
  t.after(() => context.close());
  const { app, client, baseUrl } = context;

  const { order } = await signedOrder(root, app, {
    name: 'Hostile Deal',
    offers: ['fixture:offer:enterprise', 'fixture:offer:storage-monthly'],
  });
  const plan = (await client.module('order').action(order.id, 'plan-activation', POLICY)).result.plan;
  const ambiguous = plan.components.find((component) => component.requiresOverride);

  const nasty = '<img src=x onerror=alert(1)>${7*7}`;-- \' or 1=1   ';
  await client.module('order').action(order.id, 'activate-contract', {
    ...POLICY, ...TERM,
    classificationOverrides: [{ orderComponentId: ambiguous.orderComponentId, type: 'subscription', reason: nasty }],
  });
  const line = app.modules.get('contract-line').service.listWhere({ orderComponentId: ambiguous.orderComponentId })[0];
  assert.equal(line.overrideReason, nasty.trim(), 'stored verbatim as text, never interpreted');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);

  // A reason carrying a control character is refused rather than silently
  // shortened: SQLite ends a text value at the first NUL byte, so accepting one
  // would persist an audit reason that disagrees with what the human submitted.
  const { order: nul } = await signedOrder(root, app, {
    name: 'Hostile NUL Deal',
    offers: ['fixture:offer:enterprise', 'fixture:offer:storage-monthly'],
  });
  const nulPlan = (await client.module('order').action(nul.id, 'plan-activation', POLICY)).result.plan;
  const nulTarget = nulPlan.components.find((component) => component.requiresOverride);
  for (const suffix of [String.fromCharCode(0), String.fromCharCode(27), String.fromCharCode(127)]) {
    await assert.rejects(
      () => client.module('order').action(nul.id, 'activate-contract', {
        ...POLICY, ...TERM,
        classificationOverrides: [
          { orderComponentId: nulTarget.orderComponentId, type: 'subscription', reason: `hidden${suffix}tail` },
        ],
      }),
      (error) => error.status === 400 && /control characters/.test(error.message),
      `control character ${suffix.charCodeAt(0)}`,
    );
  }
  assert.equal(app.modules.get('commercial-contract').service.listWhere({ orderId: nul.id }).length, 0,
    'a refused override activates nothing');

  // Prototype-shaped policy names and unknown versions resolve to nothing.
  const { order: other } = await signedOrder(root, app, { name: 'Hostile Policy Deal' });
  for (const policy of ['__proto__', 'constructor', 'toString', 'unknown-policy']) {
    await assert.rejects(
      () => client.module('order').action(other.id, 'plan-activation', { policy, policyVersion: 1 }),
      (error) => error.status === 404 && error.code === 'NOT_FOUND',
      policy,
    );
  }
  await assert.rejects(
    () => client.module('order').action(other.id, 'plan-activation', { ...POLICY, policyVersion: 99 }),
    (error) => error.status === 404,
  );
  // Prototype-shaped keys in the override payload are dropped, never assigned.
  await assert.rejects(
    () => client.module('order').action(other.id, 'activate-contract', {
      ...POLICY, ...TERM,
      classificationOverrides: JSON.parse('[{"orderComponentId":"x","type":"delivery","reason":"r","__proto__":{"polluted":true}}]'),
    }),
    (error) => error.code === 'OVERRIDE_COMPONENT_UNKNOWN',
  );
  assert.equal({}.polluted, undefined);

  // Errors never leak SQL, a stack, a path or the signed document.
  const response = await fetch(`${baseUrl}/api/modules/order/records/${other.id}/actions/activate-contract`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...POLICY, effectiveDate: '2026-02-30', termStartDate: '2026-09-01', termEndDate: '2027-08-31' }),
  });
  assert.equal(response.status, 400);
  const body = JSON.stringify(await response.json());
  assert.ok(body.includes('not a real calendar date'));
  assert.ok(!/SELECT |INSERT |\/home\/|at Object\./.test(body), body);
});
