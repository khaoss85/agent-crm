import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  CATALOG_PRICE_RULES, CATALOG_PRICE_RULES_VERSION, DEFAULT_OWNER_APPROVAL_KEY,
  createCatalogPriceRules,
} from '../packages/commercial/src/price-rules.js';
import { VAT_RATE_BPS } from '../packages/commercial/src/money.js';
import { suggestQuoteLines } from '../packages/commercial/src/quote-suggest.js';
import { project, boot } from './helpers/contracts-project.js';

/**
 * BO-F2-04 — catalog price rules evaluated by the package, never by the
 * interface: a quote that breaks a rule stays a draft with its reason, and
 * an AI proposal is blocked exactly like an operator-entered one.
 *
 * No UI, no network: the policy is a pure definition and the gate is the
 * server-side `quote.submit` action.
 */

const ACTOR = { type: 'user', id: 'price-rules' };
const PRICE_RULES = { autoApproveMaxBps: 1000, ownerApprovalMaxBps: 3000, approvalKey: 'owner' };

function evaluate(policy, maxLineDiscountBps) {
  return policy.evaluate({ maxLineDiscountBps, config: policy.config });
}

test('price rules: identity, defaults and config validation', () => {
  const policy = createCatalogPriceRules();
  assert.equal(policy.name, CATALOG_PRICE_RULES, 'the rule set has its shipped name');
  assert.equal(policy.version, CATALOG_PRICE_RULES_VERSION, 'the rule set is versioned');
  assert.deepEqual(
    policy.config,
    { autoApproveMaxBps: 1000, ownerApprovalMaxBps: 3000, approvalKey: 'owner' },
    'sane defaults: 10% auto, owner above, 30% hard cap',
  );
  assert.equal(DEFAULT_OWNER_APPROVAL_KEY, 'owner', 'the owner key default names the titolare role');
  assert.equal(typeof policy.evaluate, 'function', 'the definition carries its evaluation');
  for (const bad of [
    { autoApproveMaxBps: 3001, ownerApprovalMaxBps: 3000 },
    { autoApproveMaxBps: -1 },
    { ownerApprovalMaxBps: 10_001 },
    { autoApproveMaxBps: 10.5 },
    { approvalKey: '' },
    { approvalKey: '   ' },
    { approvalKey: 42 },
  ]) {
    assert.throws(() => createCatalogPriceRules(bad), /./, `refused config ${JSON.stringify(bad)}`);
  }
});

test('price rules: the three bands decide with their reason', () => {
  const policy = createCatalogPriceRules(PRICE_RULES);
  assert.deepEqual(
    [evaluate(policy, 0).decision, evaluate(policy, 1000).decision],
    ['auto_approve', 'auto_approve'],
    'within the auto band, including the boundary, no human step',
  );
  assert.equal(evaluate(policy, 1000).matchedRule, 'auto-approve-within-limit', 'the band is named');
  for (const bps of [1001, 3000]) {
    const result = evaluate(policy, bps);
    assert.equal(result.decision, 'approval_required', `${bps}bps needs the owner`);
    assert.equal(result.requiredApprovalKey, 'owner', 'the owner key travels with the request');
    assert.equal(result.matchedRule, 'owner-approval-above-max', 'the band is named');
    assert.match(result.reason, /owner/i, 'the reason says who must approve');
  }
  const refused = evaluate(policy, 3001);
  assert.equal(refused.decision, 'reject', 'above the maximum nothing can release it');
  assert.equal(refused.matchedRule, 'above-maximum', 'the band is named');
  assert.match(refused.reason, /3001/, 'the reason carries the offending figure');
  const custom = createCatalogPriceRules({ autoApproveMaxBps: 500, ownerApprovalMaxBps: 2000, approvalKey: 'sales-manager' });
  assert.equal(evaluate(custom, 501).requiredApprovalKey, 'sales-manager', 'the key is config, not code');
  assert.equal(evaluate(custom, 2001).decision, 'reject', 'custom caps hold');
});

test('price rules: a refused submit keeps the draft, with the reason on the frozen version', async (t) => {
  const root = project(t, { withDomain: false, priceRules: PRICE_RULES });
  const context = await boot(root, join(root, 'data', 'price-rules.sqlite'));
  t.after(() => context.close());
  const { app } = context;

  await app.syncCatalog({ provider: 'fixture-saas-catalog', actor: ACTOR });
  const book = app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
  const offerOf = (key) => app.modules.get('offer').service.listWhere({ logicalKey: key, active: true })[0];
  const company = await app.services.companies.create({ name: 'Regole SpA' }, { actor: ACTOR });
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, name: 'Regole deal', type: 'new_business', valueCents: 100_000, currency: 'EUR', stage: 'discovery', owner: 'price-rules' },
    { actor: ACTOR },
  );
  const quote = (await app.runAction({
    module: 'opportunity', action: 'create-quote', recordId: opportunity.id, input: { priceBookId: book.id }, actor: ACTOR,
  })).result.quote;
  await app.runAction({
    module: 'quote', action: 'add-line', recordId: quote.id,
    input: { offerId: offerOf('fixture:offer:enterprise').id, quantity: 2, discountBps: 6000 }, actor: ACTOR,
  });

  const refused = await app.runAction({
    module: 'quote', action: 'submit', recordId: quote.id,
    input: { policy: CATALOG_PRICE_RULES, version: CATALOG_PRICE_RULES_VERSION }, actor: ACTOR,
  });
  assert.equal(refused.result.version.decision, 'reject', '60% is above the 30% maximum');
  assert.equal(refused.result.quote.status, 'draft', 'the refused quote stays a draft');
  assert.equal(refused.result.quote.currentVersionId, null, 'no signable version points at the refusal');
  assert.equal(refused.result.quote.currentVersionNumber, 1, 'the attempt still numbers its evidence');
  assert.equal(refused.result.approvalId, null, 'no approval row for a refusal');
  assert.match(refused.result.version.reason, /6000/, 'the reason carries the offending figure');
  const stored = app.modules.get('quote-version').service.get(refused.result.version.id);
  assert.equal(stored.policyDecision, 'reject', 'the frozen version keeps the refusal');
  assert.ok(stored.decisionReason.length > 0, 'the frozen version keeps the reason');
  assert.equal(stored.policy, CATALOG_PRICE_RULES, 'the frozen version names the rule set');
  assert.equal(refused.result.version.totals.vatRateBps, VAT_RATE_BPS, 'the frozen view pins the default 22% VAT');

  // The draft stays editable: lower the line, resubmit, the owner band asks
  // for the titolare, and the human decision closes the loop.
  const lines = app.modules.get('quote-line').service.listWhere({ quoteId: quote.id });
  await app.runAction({
    module: 'quote', action: 'update-line', recordId: quote.id,
    input: { lineId: lines[0].id, quantity: 2, discountBps: 2500 }, actor: ACTOR,
  });
  const pending = await app.runAction({
    module: 'quote', action: 'submit', recordId: quote.id,
    input: { policy: CATALOG_PRICE_RULES, version: CATALOG_PRICE_RULES_VERSION }, actor: ACTOR,
  });
  assert.equal(pending.result.version.decision, 'approval_required', '25% is inside the owner band');
  assert.equal(pending.result.quote.status, 'pending_approval', 'the quote waits for the titolare');
  assert.equal(pending.result.version.versionNumber, 2, 'the retry freezes version 2');
  const approval = app.modules.get('quote-approval').service.get(pending.result.approvalId);
  assert.equal(approval.requiredApprovalKey, 'owner', 'the request names the owner key');
  const humanNo = await app.runAction({
    module: 'quote', action: 'reject', recordId: quote.id, input: { reason: 'Too deep for this deal' }, actor: ACTOR,
  });
  assert.equal(humanNo.result.decision, 'rejected', 'the human refusal still terminates');
  await app.runAction({ module: 'quote', action: 'revise', recordId: quote.id, input: {}, actor: ACTOR });
  const resubmitted = await app.runAction({
    module: 'quote', action: 'submit', recordId: quote.id,
    input: { policy: CATALOG_PRICE_RULES, version: CATALOG_PRICE_RULES_VERSION }, actor: ACTOR,
  });
  assert.equal(resubmitted.result.quote.status, 'pending_approval', 'revise reopens the draft for a new submit');
  const approved = await app.runAction({
    module: 'quote', action: 'approve', recordId: quote.id, input: { reason: 'Owner ok' }, actor: ACTOR,
  });
  assert.equal(approved.result.decision, 'approved', 'the owner approval releases the quote');
});

test('price rules: quantity pricing stays automatic and needs no approval', async (t) => {
  const root = project(t, { withDomain: false, priceRules: PRICE_RULES });
  const context = await boot(root, join(root, 'data', 'price-rules-qty.sqlite'));
  t.after(() => context.close());
  const { app } = context;

  await app.syncCatalog({ provider: 'fixture-saas-catalog', actor: ACTOR });
  const book = app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
  const seats = app.modules.get('offer').service.listWhere({ logicalKey: 'fixture:offer:seats-monthly', active: true })[0];
  const company = await app.services.companies.create({ name: 'Quantità SpA' }, { actor: ACTOR });
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, name: 'Quantità deal', type: 'new_business', valueCents: 100_000, currency: 'EUR', stage: 'discovery', owner: 'price-rules' },
    { actor: ACTOR },
  );
  const quote = (await app.runAction({
    module: 'opportunity', action: 'create-quote', recordId: opportunity.id, input: { priceBookId: book.id }, actor: ACTOR,
  })).result.quote;
  const added = await app.runAction({
    module: 'quote', action: 'add-line', recordId: quote.id,
    input: { offerId: seats.id, quantity: 50, discountBps: 0 }, actor: ACTOR,
  });
  assert.ok(
    added.result.line.netAmountCents < 50 * 5000,
    '50 seats price below the opening tier: the quantity band applied itself',
  );
  const submitted = await app.runAction({
    module: 'quote', action: 'submit', recordId: quote.id,
    input: { policy: CATALOG_PRICE_RULES, version: CATALOG_PRICE_RULES_VERSION }, actor: ACTOR,
  });
  assert.equal(submitted.result.version.decision, 'auto_approve', 'catalog-driven quantity pricing needs no human');
  assert.equal(submitted.result.quote.status, 'approved', 'the quote flows straight through');
});

test('price rules: an AI proposal that breaks a rule is blocked exactly like an operator line', async (t) => {
  const root = project(t, { withDomain: false, priceRules: PRICE_RULES });
  const context = await boot(root, join(root, 'data', 'price-rules-ai.sqlite'));
  t.after(() => context.close());
  const { app } = context;

  await app.syncCatalog({ provider: 'fixture-saas-catalog', actor: ACTOR });
  const book = app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
  const enterprise = app.modules.get('offer').service.listWhere({ logicalKey: 'fixture:offer:enterprise', active: true })[0];
  const excerpts = [{ id: 'm1', text: 'Ci servono 2 licenze enterprise con uno sconto importante.' }];
  const offers = [{ offerId: enterprise.id, name: 'Enterprise' }];

  const overLimit = await suggestQuoteLines({
    excerpts,
    offers,
    complete: async () => ({
      text: JSON.stringify([{
        offerId: enterprise.id, quantity: 2, discountBps: 6000,
        motive: 'Il cliente chiede 2 licenze con uno sconto importante.', sourceExcerptId: 'm1',
      }]),
    }),
  });
  assert.equal(overLimit.suggestions.length, 1, 'the AI line lands with its proposed discount');
  assert.equal(overLimit.suggestions[0].discountBps, 6000, 'the proposed discount travels through');
  assert.ok(overLimit.suggestions[0].motive.length > 0, 'the motive travels with it');

  for (const bad of [20000, -100, 12.5, '10%', null]) {
    const refused = await suggestQuoteLines({
      excerpts,
      offers,
      complete: async () => ({
        text: JSON.stringify([{
          offerId: enterprise.id, quantity: 1, discountBps: bad,
          motive: 'Sconto oltre il formato.', sourceExcerptId: 'm1',
        }]),
      }),
    });
    assert.equal(refused.suggestions.length, 0, `no line lands for discount ${JSON.stringify(bad)}`);
    assert.deepEqual(
      refused.refused.map(({ code }) => code),
      ['SUGGESTION_DISCOUNT_INVALID'],
      `a malformed AI discount refuses with its code (${JSON.stringify(bad)})`,
    );
  }
  const plain = await suggestQuoteLines({
    excerpts,
    offers,
    complete: async () => ({
      text: JSON.stringify([{
        offerId: enterprise.id, quantity: 1, motive: 'Il cliente chiede una licenza.', sourceExcerptId: 'm1',
      }]),
    }),
  });
  assert.equal(plain.suggestions[0].discountBps, 0, 'a suggestion without discount defaults to list price');

  const company = await app.services.companies.create({ name: 'AI SpA' }, { actor: ACTOR });
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, name: 'AI deal', type: 'new_business', valueCents: 100_000, currency: 'EUR', stage: 'discovery', owner: 'price-rules' },
    { actor: ACTOR },
  );
  const quote = (await app.runAction({
    module: 'opportunity', action: 'create-quote', recordId: opportunity.id, input: { priceBookId: book.id }, actor: ACTOR,
  })).result.quote;
  for (const suggestion of overLimit.suggestions) {
    await app.runAction({
      module: 'quote', action: 'add-line', recordId: quote.id,
      input: { offerId: suggestion.offerId, quantity: suggestion.quantity, discountBps: suggestion.discountBps },
      actor: ACTOR,
    });
  }
  const blocked = await app.runAction({
    module: 'quote', action: 'submit', recordId: quote.id,
    input: { policy: CATALOG_PRICE_RULES, version: CATALOG_PRICE_RULES_VERSION }, actor: ACTOR,
  });
  assert.equal(blocked.result.version.decision, 'reject', 'the AI-proposed 60% refuses like the operator 60%');
  assert.equal(blocked.result.quote.status, 'draft', 'the AI-built quote stays a draft too');
  assert.match(blocked.result.version.reason, /6000/, 'the same reason, with the same figure');
});
