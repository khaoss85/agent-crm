import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Shared harness for the Milestone 12 suites: it builds a clean throwaway
 * project from the current repository with the real CLI and module factory,
 * boots the real app, HTTP server and SDK, and drives the whole proven journey
 * to a signed immutable Order. Every M12 test starts from real signed
 * evidence rather than a fixture that pretends to be one.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export const STARTER_MANIFESTS = [
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

export const DOMAIN_MANIFESTS = [
  'contract-activation.module.json', 'commercial-contract.module.json',
  'contract-version.module.json', 'contract-line.module.json',
  'subscription.module.json', 'subscription-line.module.json',
  'delivery-obligation.module.json', 'service-obligation.module.json',
];

export const DOMAIN_MODULES = [
  'contract-activation', 'commercial-contract', 'contract-version', 'contract-line',
  'subscription', 'subscription-line', 'delivery-obligation', 'service-obligation',
];

/** The Delivery package's own record modules (M13). */
export const DELIVERY_MANIFESTS = [
  'delivery-handover-run.module.json', 'delivery-project.module.json',
  'delivery-work-package.module.json', 'delivery-milestone.module.json',
  'delivery-partner-engagement.module.json',
  // M14b1: the immutable economics evidence.
  'delivery-time-entry.module.json', 'delivery-expense-entry.module.json',
  'delivery-economic-plan.module.json', 'delivery-economic-plan-line.module.json',
  'delivery-economic-snapshot.module.json',
  // M14b2: change, deliverables and acceptance evidence.
  'delivery-change-request.module.json', 'delivery-plan-revision.module.json',
  'delivery-commercial-change.module.json', 'delivery-deliverable.module.json',
  'delivery-acceptance-request.module.json', 'delivery-acceptance-evidence.module.json',
];
export const DELIVERY_MODULES = [
  'delivery-handover-run', 'delivery-project', 'delivery-work-package',
  'delivery-milestone', 'delivery-partner-engagement',
  'delivery-time-entry', 'delivery-expense-entry',
  'delivery-economic-plan', 'delivery-economic-plan-line', 'delivery-economic-snapshot',
  'delivery-change-request', 'delivery-plan-revision', 'delivery-commercial-change',
  'delivery-deliverable', 'delivery-acceptance-request', 'delivery-acceptance-evidence',
];
export const DELIVERY_POLICY = { policy: 'b2b-delivery-handover', policyVersion: 1 };

/**
 * @param {import('node:test').TestContext} t
 * @param {{withDomain?: boolean}} [options] `withDomain: false` builds the same
 *   project **without** the contracts package, which is how domain isolation is
 *   proven rather than asserted.
 */
export function project(t, { withDomain = true, withDelivery = false, withCustomPackage = false } = {}) {
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
  if (withDelivery) for (const manifest of DELIVERY_MANIFESTS) apply(join(root, 'packages/delivery/modules', manifest));
  if (withCustomPackage) apply(join(root, 'examples/custom-packages/partner-scorecard/modules/partner-scorecard.module.json'));

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
    // The composition file is the ONLY place a project names its packages:
    // this is the same static import list a customer edits by hand.
    writeFileSync(
      join(root, 'packages/domains/generated/index.js'),
      [
        "import { createContractsDomain } from '../../contracts/src/index.js';",
        "import { b2bSaasOrderActivationV1, b2bSaasOrderActivationV2 } from '../../../examples/starters/b2b-lead-qualification/contracts.js';",
        ...(withDelivery ? [
          "import { createDeliveryPackage } from '../../delivery/src/index.js';",
          "import { b2bDeliveryHandoverV1 } from '../../../examples/starters/b2b-lead-qualification/delivery.js';",
          "import { b2bDeliveryCostV1 } from '../../../examples/starters/b2b-lead-qualification/delivery-cost.js';",
        ] : []),
        ...(withCustomPackage ? [
          "import { createPartnerScorecardPackage } from '../../../examples/custom-packages/partner-scorecard/src/index.js';",
        ] : []),
        'export const generatedDomains = [',
        '  createContractsDomain({ policies: [b2bSaasOrderActivationV1, b2bSaasOrderActivationV2] }),',
        ...(withDelivery ? ['  createDeliveryPackage({ policies: [b2bDeliveryHandoverV1], costPolicies: [b2bDeliveryCostV1] }),'] : []),
        ...(withCustomPackage ? ['  createPartnerScorecardPackage(),'] : []),
        '];',
        '',
      ].join('\n'),
    );
  }
  return root;
}

/**
 * The business "today" every M12 suite runs against, so a term that starts on
 * 2026-09-01 is genuinely current and `scheduled` versus `active` is a
 * decision the test controls rather than a fact about the day it runs.
 */
export const BUSINESS_NOW = '2026-09-15T10:00:00.000Z';

export async function boot(root, dbPath, options = {}) {
  const { clock = () => BUSINESS_NOW, ...rest } = options;
  const { createAgentCrmApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const { createHttpServer } = await import(pathToFileURL(join(root, 'apps/server/src/index.js')).href);
  const { AgentCrmClient } = await import(pathToFileURL(join(root, 'packages/sdk/src/index.js')).href);
  const app = createAgentCrmApp({ dbPath, clock, ...rest });
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

export const TERM = { effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31' };
export const POLICY = { policy: 'b2b-saas-order-activation', policyVersion: 1 };

/**
 * Drive the whole proven journey to a signed immutable Order. `offers` selects
 * which fixture offers the quote carries, so a test can compose the exact
 * classification mix it needs.
 */
export async function signedOrder(root, app, { name = 'M12 Deal', offers = ['fixture:offer:enterprise', 'fixture:offer:support-annual', 'fixture:offer:api-monthly'] } = {}) {
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


/** The standard M12 activation input: dates plus the reason the term exists. */
export const ACTIVATION_INPUT = {
  ...TERM,
  termsReason: 'agreed with the customer after signature',
};

/**
 * Drive a signed order all the way to an activated contract, which is where
 * every Delivery (M13) test starts.
 */
export async function activatedContract(root, app, options = {}) {
  const actor = { type: 'user', id: 'e2e' };
  const signed = await signedOrder(root, app, options);
  await app.runAction({
    module: 'order', action: 'activate-contract', recordId: signed.order.id,
    input: { ...POLICY, ...ACTIVATION_INPUT, ...(options.activation ?? {}) }, actor,
  });
  const contract = app.modules.get('commercial-contract').service.listWhere({ orderId: signed.order.id })[0];
  return { ...signed, contract };
}
