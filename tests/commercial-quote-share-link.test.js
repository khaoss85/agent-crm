// @ts-check

/**
 * A5 offerta via link (backlog:a3b394dd): the three acceptance criteria,
 * each proven against the real composition with an in-process app.
 *
 * 1. double acceptance stays one acceptance (idempotent accept-link);
 * 2. the accepted price is the frozen version price even when the catalog
 *    reprices afterwards (accept reads version rows only, never the live
 *    catalog);
 * 3. an expired link answers «offerta scaduta» and never accepts, without
 *    leaking names, prices or rows.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const ACTOR = { type: 'user', id: 'quote-share-link-test' };
// The customer holds no account: possession of the token is the credential.
const PUBLIC = { type: 'public', id: 'link-holder' };

const COMMERCIAL_MANIFESTS = [
  'product.module.json', 'product-version.module.json', 'price-book.module.json',
  'offer.module.json', 'price-component.module.json', 'price-tier.module.json',
  'catalog-sync-run.module.json', 'quote.module.json', 'quote-line.module.json',
  'quote-version.module.json', 'quote-version-line.module.json',
  'quote-version-component.module.json', 'quote-version-total.module.json',
  'quote-approval.module.json', 'quote-share.module.json',
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
  writeFileSync(
    join(root, 'packages/domains/generated/index.js'),
    [
      '// @ts-check',
      "import { createCommercialDomain } from '../../commercial/src/index.js';",
      "import { fixtureSaasCatalogProvider, standardSalesDiscountV1, standardSalesDiscountV2 } from '../../../examples/starters/b2b-lead-qualification/commercial.js';",
      'export const generatedDomains = [',
      '  createCommercialDomain({',
      '    catalogProviders: [fixtureSaasCatalogProvider],',
      '    discountPolicies: [standardSalesDiscountV1, standardSalesDiscountV2],',
      '  }),',
      '];',
      '',
    ].join('\n'),
  );
}

let appliedTemplate = null;
function appliedTemplateRoot() {
  if (!appliedTemplate) {
    appliedTemplate = mkdtempSync(join(tmpdir(), 'accordo-quote-share-template-'));
    for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
      cpSync(join(repoRoot, entry), join(appliedTemplate, entry), { recursive: true });
    }
    applyManifests(appliedTemplate);
  }
  return appliedTemplate;
}
after(() => {
  if (appliedTemplate) rmSync(appliedTemplate, { recursive: true, force: true });
  appliedTemplate = null;
});

async function bootApp(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-quote-share-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(appliedTemplateRoot(), root, { recursive: true });
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  return app;
}

const COMPONENT = (flatAmountCents) => ({
  key: 'pacchetto',
  label: 'Prezzo del pacchetto',
  chargeType: 'one_time',
  pricingModel: 'flat_fee',
  flatAmountCents,
});

/** An approved quote over a manual product priced at `cents`. */
async function approvedQuote(app, { sku, cents }) {
  const created = await app.createManualProduct({
    sku, name: `Prodotto ${sku}`, currency: 'EUR', components: [COMPONENT(cents)],
  }, ACTOR);
  const company = await app.services.companies.create({ name: `Co ${sku}` }, { actor: ACTOR });
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, name: `Deal ${sku}`, type: 'new_business', valueCents: 1_000_000, currency: 'EUR', stage: 'discovery', owner: 'seed' },
    { actor: ACTOR },
  );
  const quote = (await app.runAction({
    module: 'opportunity', action: 'create-quote', recordId: opportunity.id,
    input: { priceBookId: created.priceBook.id }, actor: ACTOR,
  })).result.quote;
  await app.runAction({
    module: 'quote', action: 'add-line', recordId: quote.id,
    input: { offerId: created.offers[0].id, quantity: 1 }, actor: ACTOR,
  });
  const submitted = await app.runAction({
    module: 'quote', action: 'submit', recordId: quote.id,
    input: { policy: 'standard-sales-discount', version: 1 }, actor: ACTOR,
  });
  if (submitted.result.version.decision === 'approval_required') {
    await app.runAction({ module: 'quote', action: 'approve', recordId: quote.id, input: {}, actor: ACTOR });
  }
  const record = await app.modules.get('quote').service.get(quote.id);
  assert.equal(record.status, 'approved');
  return { quote: record, product: created.product, offerId: created.offers[0].id };
}

async function refusal(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, code: error.code ?? null, status: error.status ?? null, message: String(error.message) };
  }
}

test('A5-1: accepting twice from the link stays one acceptance', async (t) => {
  const app = await bootApp(t);
  const { quote } = await approvedQuote(app, { sku: 'LINK-1', cents: 10000 });
  const shared = await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  const token = shared.result.share.token;
  assert.match(token, /^[0-9a-f]{64}$/, 'the token is unguessable');

  const first = await app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token }, actor: PUBLIC,
  });
  assert.equal(first.result.accepted, true, 'the first accept lands without a login');
  assert.equal(first.result.offer.oneTimeNetCents, 10000, 'the accepted price is the sent one');
  const acceptedAt = first.result.acceptedAt;

  const second = await app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token }, actor: PUBLIC,
  });
  assert.equal(second.result.alreadyAccepted, true, 'the second accept answers already accepted');
  assert.equal(second.result.acceptedAt, acceptedAt, 'the acceptance instant never moves');
  assert.equal(second.result.offer.oneTimeNetCents, 10000, 'the price still answers, unchanged');

  const share = app.modules.get('quote-share').service.listWhere({ token })[0];
  assert.equal(share.status, 'accepted');
  assert.equal(share.acceptCount, 1, 'exactly one acceptance is recorded');

  const info = await app.runAction({
    module: 'quote', action: 'link-info', recordId: quote.id, input: { token }, actor: PUBLIC,
  });
  assert.equal(info.result.status, 'accepted');
  assert.equal(info.result.message, 'già accettata');
});

test('A5-2: the accepted price is the frozen send price after a catalog reprice', async (t) => {
  const app = await bootApp(t);
  const { quote, product, offerId } = await approvedQuote(app, { sku: 'LINK-2', cents: 10000 });
  const { token } = (await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: ACTOR,
  })).result.share;

  // The catalog moves AFTER the send: revision 2 doubles the price.
  await app.setManualPrices({
    productId: product.id,
    offerIds: [offerId],
    offers: [{ name: 'Prodotto LINK-2', components: [COMPONENT(20000)] }],
  }, ACTOR);
  const live = (await app.listCatalogProducts({})).products[0].offers[0];
  assert.equal(live.components[0].flatAmountCents, 20000, 'the live catalog really moved');

  const accepted = await app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token }, actor: PUBLIC,
  });
  assert.equal(accepted.result.accepted, true);
  assert.equal(accepted.result.offer.oneTimeNetCents, 10000, 'the link still accepts the frozen send price');
  assert.equal(accepted.result.offer.lines[0].netAmountCents, 10000);
  const versionTotals = app.modules.get('quote-version-total').service.listWhere({ versionId: accepted.result.offer.versionId });
  assert.equal(versionTotals[0].netAmountCents, 10000, 'the version rows never moved');
});

test('A5-3: an expired link shows «offerta scaduta» and never accepts', async (t) => {
  const app = await bootApp(t);
  const { quote } = await approvedQuote(app, { sku: 'LINK-3', cents: 10000 });
  const shared = await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: { expiresInDays: 1 }, actor: ACTOR,
  });
  const { token } = shared.result.share;
  // Time passes: the link expires without any other change.
  const shares = app.modules.get('quote-share').service;
  const shareId = shares.listWhere({ token })[0].id;
  await shares.applyManaged(shareId, { expiresAt: '2000-01-01T00:00:00.000Z' }, { actor: ACTOR });

  const denied = await refusal(app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token }, actor: PUBLIC,
  }));
  assert.equal(denied.ok, false, 'an expired link never accepts');
  assert.equal(denied.code, 'QUOTE_LINK_EXPIRED');
  assert.equal(denied.status, 410);
  assert.equal(denied.message, 'offerta scaduta');
  assert.doesNotMatch(denied.message, /\d{4,}/, 'the refusal carries no price');

  const info = await app.runAction({
    module: 'quote', action: 'link-info', recordId: quote.id, input: { token }, actor: PUBLIC,
  });
  assert.equal(info.result.status, 'expired');
  assert.equal(info.result.message, 'offerta scaduta');
  assert.ok(!('offer' in info.result), 'an expired link leaks no rows');

  const unknown = await refusal(app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token: '0'.repeat(64) }, actor: PUBLIC,
  }));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'QUOTE_LINK_INVALID');
  assert.equal(unknown.message, 'link non valido o scaduto');

  const row = shares.listWhere({ token })[0];
  assert.equal(row.status, 'active', 'the refused accept wrote nothing');
  assert.equal(row.acceptCount, 0);
});

test('sharing stays a human act on an approved quote only', async (t) => {
  const app = await bootApp(t);
  const { quote } = await approvedQuote(app, { sku: 'LINK-4', cents: 5000 });
  const refused = await refusal(app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: PUBLIC,
  }));
  assert.equal(refused.ok, false, 'no login-free share');
  assert.equal(refused.code, 'HUMAN_ACTOR_REQUIRED');

  const created = await app.createManualProduct({
    sku: 'LINK-DRAFT', name: 'Bozza', currency: 'EUR', components: [COMPONENT(1000)],
  }, ACTOR);
  const company = await app.services.companies.create({ name: 'Co draft' }, { actor: ACTOR });
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, name: 'Deal draft', type: 'new_business', valueCents: 1000, currency: 'EUR', stage: 'discovery', owner: 'seed' },
    { actor: ACTOR },
  );
  const draft = (await app.runAction({
    module: 'opportunity', action: 'create-quote', recordId: opportunity.id,
    input: { priceBookId: created.priceBook.id }, actor: ACTOR,
  })).result.quote;
  const draftShare = await refusal(app.runAction({
    module: 'quote', action: 'share-link', recordId: draft.id, input: {}, actor: ACTOR,
  }));
  assert.equal(draftShare.ok, false, 'a draft carries no sendable price');
});
