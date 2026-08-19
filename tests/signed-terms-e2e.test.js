import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { boot, project, signedOrder, POLICY } from './helpers/contracts-project.js';

/**
 * Signed commercial terms, end to end (the M16b prerequisite): a draft term
 * on the quote → validated and frozen into the immutable version at submit →
 * embedded in the canonical document and covered by the signed documentHash →
 * copied onto the Order at verified completion → consumed by activation as
 * `signed-order-terms` provenance → reported `signed: true` by
 * `contract-lifecycle-source@2`.
 *
 * And the other half, which matters as much: everything that must REFUSE —
 * an incoherent draft at submit, manual term inputs against a signed order,
 * a draft edit trying to reach evidence that was already signed — and the
 * operational path staying byte-for-byte what it always was.
 */

const TERM = {
  effectiveDate: '2026-09-01',
  termStartDate: '2026-09-01',
  termEndDate: '2027-08-31',
  autoRenew: true,
  renewalNoticeDays: 60,
};

async function refusal(promise) {
  try {
    const value = await promise;
    return { ok: true, value };
  } catch (error) {
    return { ok: false, status: error.status ?? null, code: error.code ?? error.body?.error?.code ?? null, message: error.message };
  }
}

test('a signed term travels draft → version snapshot → document hash → Order → activation → lifecycle evidence', async (t) => {
  const root = project(t, { withLifecycle: true });
  const context = await boot(root, join(root, 'data', 'signed-terms.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const actor = { type: 'user', id: 'e2e' };

  const { order, quote, versionId, envelope } = await signedOrder(root, app, { name: 'Signed Terms Deal', term: TERM });

  // ── the version snapshot: write-once, exact, fingerprinted ──────────────
  const snapshot = app.modules.get('quote-version-term').service.listWhere({ versionId })[0];
  assert.ok(snapshot, 'submit froze the draft term into a version snapshot');
  assert.equal(snapshot.effectiveDate, '2026-09-01');
  assert.equal(snapshot.termEndDate, '2027-08-31');
  assert.equal(snapshot.termDays, 365, 'termEndDate is inclusive: both boundary days are inside the term');
  assert.equal(snapshot.autoRenew, true, 'the generated service answers real booleans');
  assert.equal(snapshot.renewalNoticeDays, 60);
  assert.equal(snapshot.termsContract, 1);
  assert.match(snapshot.termsFingerprint, /^[0-9a-f]{64}$/);

  // ── the signed document embeds the term and the hash covers it ──────────
  const document = JSON.parse(envelope.documentJson ?? app.modules.get('signature-envelope').service.get(envelope.id).documentJson);
  assert.deepEqual(document.terms, {
    termsContract: 1,
    effectiveDate: '2026-09-01',
    termStartDate: '2026-09-01',
    termEndDate: '2027-08-31',
    endDateInclusive: true,
    termDays: 365,
    autoRenew: true,
    renewalNoticeDays: 60,
  }, 'the customer signed exactly these values');
  assert.equal(document.documentContract, 1, 'an optional additive key is not a new document shape');

  // ── the Order carries the signed term, copied in the completion transaction
  const orderTerm = app.modules.get('order-term').service.listWhere({ orderId: order.id })[0];
  assert.ok(orderTerm, 'verified completion copied the term onto the Order');
  assert.equal(orderTerm.termsFingerprint, snapshot.termsFingerprint, 'same term identity end to end');
  assert.equal(orderTerm.documentHash, order.documentHash, 'the term names the signed document it belongs to');
  assert.equal(orderTerm.termDays, 365);

  // …and both capabilities hand it to consumers, frozen.
  const quotesCap = app.domains.capability({ consumer: 'signature', capability: 'commercial-quotes', version: 1, context: { modules: app.modules } });
  const viaQuotes = quotesCap.versionTerm(versionId);
  assert.equal(viaQuotes.termsFingerprint, snapshot.termsFingerprint);
  assert.equal(Object.isFrozen(viaQuotes), true);
  const ordersCap = app.domains.capability({ consumer: 'contracts', capability: 'signature-orders', version: 1, context: { modules: app.modules } });
  const viaOrders = ordersCap.orderTerm(order.id);
  assert.equal(viaOrders.termsFingerprint, snapshot.termsFingerprint);
  assert.equal(Object.isFrozen(viaOrders), true);

  // ── a draft edit after signature reaches NOTHING that was signed ────────
  const draft = app.modules.get('quote-term').service.listWhere({ quoteId: quote.id })[0];
  await app.modules.get('quote-term').service.update(draft.id, { termEndDate: '2030-12-31' }, { actor });
  assert.equal(app.modules.get('quote-version-term').service.listWhere({ versionId })[0].termEndDate, '2027-08-31',
    'the version snapshot never moves');
  assert.equal(app.modules.get('order-term').service.listWhere({ orderId: order.id })[0].termEndDate, '2027-08-31',
    'the Order term never moves');

  // ── the plan states the provenance and asks for NO term input ───────────
  const planned = await app.runAction({ module: 'order', action: 'plan-activation', recordId: order.id, input: { policy: POLICY.policy, policyVersion: POLICY.policyVersion }, actor });
  assert.equal(planned.result.plan.termsProvenance.source, 'signed-order-terms');
  assert.deepEqual(planned.result.plan.requiredInputs, [], 'nothing left to type: the signed snapshot is the term');
  assert.equal(planned.result.plan.signedTerm.termEndDate, '2027-08-31');
  assert.equal(planned.result.plan.signedTerm.termsFingerprint, snapshot.termsFingerprint);

  // ── manual term inputs against a signed order are refused, named ────────
  const manual = await refusal(app.runAction({
    module: 'order', action: 'activate-contract', recordId: order.id,
    input: { policy: POLICY.policy, policyVersion: POLICY.policyVersion, effectiveDate: '2026-10-01', termStartDate: '2026-10-01', termEndDate: '2027-09-30', termsReason: 'sales said so' },
    actor,
  }));
  assert.equal(manual.ok, false);
  assert.equal(manual.status, 409);
  assert.equal(manual.code, 'SIGNED_TERMS_AUTHORITATIVE');

  // ── activation copies the signed snapshot verbatim ──────────────────────
  const activated = await app.runAction({
    module: 'order', action: 'activate-contract', recordId: order.id,
    input: { policy: POLICY.policy, policyVersion: POLICY.policyVersion },
    actor,
  });
  const contract = activated.result.contract;
  assert.equal(contract.termsSource, 'signed-order-terms');
  assert.equal(contract.effectiveDate, '2026-09-01');
  assert.equal(contract.termEndDate, '2027-08-31');
  assert.equal(contract.termDays, 365);
  assert.equal(contract.autoRenew, true);
  assert.equal(contract.renewalNoticeDays, 60);
  assert.equal(contract.status, 'active', 'business date 2026-09-15 is inside the signed term');
  const activationRow = app.modules.get('contract-activation').service.listWhere({ orderId: order.id })[0];
  assert.equal(activationRow.termsSource, 'signed-order-terms');

  // ── the lifecycle capability derives signed: true from the source ───────
  const lifecycle = app.domains.capability({ consumer: 'lifecycle', capability: 'contract-lifecycle-source', version: 2, context: { modules: app.modules } });
  const evidence = lifecycle.termEvidence(contract.id);
  assert.equal(evidence.term.source, 'signed-order-terms');
  assert.equal(evidence.term.signed, true);
  assert.equal(evidence.term.signedBasis, 'DERIVED_FROM_DECLARED_TERM_SOURCE');
  assert.match(evidence.term.provenanceNote, /SIGNED commercial term/);
  assert.doesNotMatch(evidence.term.provenanceNote, /OPERATIONAL metadata/);
});

test('the hash algebra extends and never reshapes: with, without and with a changed term', async (t) => {
  const root = project(t, { withDomain: false });
  const context = await boot(root, join(root, 'data', 'signed-terms-hash.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const actor = { type: 'user', id: 'e2e' };

  // Two identical deals, one with a term and one without: only `terms`
  // separates their documents, and the hashes separate with it.
  const bare = await signedOrder(root, app, { name: 'Hash Bare', offers: ['fixture:offer:enterprise'] });
  const termed = await signedOrder(root, app, { name: 'Hash Termed', offers: ['fixture:offer:enterprise'], term: TERM });
  const bareDoc = JSON.parse(app.modules.get('signature-envelope').service.get(bare.envelope.id).documentJson);
  const termedDoc = JSON.parse(app.modules.get('signature-envelope').service.get(termed.envelope.id).documentJson);
  assert.equal('terms' in bareDoc, false, 'a termless version produces the exact pre-terms document: no key at all');
  assert.equal('terms' in termedDoc, true);
  assert.equal(app.modules.get('order-term').service.listWhere({ orderId: bare.order.id }).length, 0,
    'no silent backfill: an order signed without a term has no term row');

  // Only `terms` separates the two documents, and the hashes separate with
  // it: what was signed and what the Order records can never silently
  // diverge on the term.
  assert.notEqual(bare.order.documentHash, termed.order.documentHash);

  // A different term is a different version identity — same offer, same
  // quantity, only the term moved, and the fingerprint moved with it.
  const otherTerm = await signedOrder(root, app, {
    name: 'Hash Termed Longer', offers: ['fixture:offer:enterprise'],
    term: { ...TERM, termEndDate: '2028-08-31' },
  });
  const termedSnapshot = app.modules.get('quote-version-term').service.listWhere({ versionId: termed.versionId })[0];
  const otherSnapshot = app.modules.get('quote-version-term').service.listWhere({ versionId: otherTerm.versionId })[0];
  assert.notEqual(termedSnapshot.termsFingerprint, otherSnapshot.termsFingerprint);
  assert.notEqual(termed.order.documentHash, otherTerm.order.documentHash);
  assert.equal(termedSnapshot.termEndDate, '2027-08-31', 'each signed version keeps exactly the term it froze');
  assert.equal(otherSnapshot.termEndDate, '2028-08-31');
});

test('an incoherent draft term refuses the submission, field by field', async (t) => {
  const root = project(t, { withDomain: false });
  const context = await boot(root, join(root, 'data', 'signed-terms-refusals.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const actor = { type: 'user', id: 'e2e' };

  await app.syncCatalog({ provider: 'fixture-saas-catalog', actor });
  const book = app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
  const offer = app.modules.get('offer').service.listWhere({ logicalKey: 'fixture:offer:enterprise', active: true })[0];
  const company = await app.services.companies.create({ name: 'Refusal Co' }, { actor });
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, name: 'Refusal deal', type: 'new_business', valueCents: 100_000, currency: 'EUR', stage: 'discovery', owner: 'e2e' },
    { actor },
  );
  const quote = (await app.runAction({ module: 'opportunity', action: 'create-quote', recordId: opportunity.id, input: { priceBookId: book.id }, actor })).result.quote;
  await app.runAction({ module: 'quote', action: 'add-line', recordId: quote.id, input: { offerId: offer.id, quantity: 5 }, actor });

  const submit = () => app.runAction({ module: 'quote', action: 'submit', recordId: quote.id, input: { policy: 'standard-sales-discount', version: 1 }, actor });
  const terms = app.modules.get('quote-term').service;
  const setDraft = async (values) => {
    const existing = terms.listWhere({ quoteId: quote.id })[0];
    if (existing) return terms.update(existing.id, values, { actor });
    return terms.create({ quoteId: quote.id, ...values }, { actor });
  };

  // A date JavaScript would happily reinterpret is refused by the canonical
  // round-trip authority, not stored as March 2nd.
  await setDraft({ effectiveDate: '2026-02-30', termStartDate: '2026-03-01', termEndDate: '2027-02-28' });
  let refused = await refusal(submit());
  assert.equal(refused.ok, false);
  assert.match(refused.message, /effectiveDate/);

  await setDraft({ effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2026-08-31' });
  refused = await refusal(submit());
  assert.match(refused.message, /termEndDate cannot precede termStartDate/);

  await setDraft({ termEndDate: '2027-08-31', renewalNoticeDays: 30 });
  refused = await refusal(submit());
  assert.match(refused.message, /renewalNoticeDays requires autoRenew/);

  // A coherent draft submits — same quote, nothing else changed.
  await setDraft({ autoRenew: true });
  const submitted = await submit();
  assert.ok(app.modules.get('quote-version-term').service.listWhere({ versionId: submitted.result.version.id })[0]);

  // The draft record itself refuses a dangling quote reference.
  const dangling = await refusal(terms.create({ quoteId: 'no-such-quote', effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31' }, { actor }));
  assert.equal(dangling.ok, false);

  // The snapshots are evidence: no public write path exists at all.
  const versionTermId = app.modules.get('quote-version-term').service.listWhere({ versionId: submitted.result.version.id })[0].id;
  const snapshotWrite = await refusal(app.modules.get('quote-version-term').service.update?.(versionTermId, { termEndDate: '2099-01-01' }, { actor }) ?? Promise.reject(Object.assign(new Error('no public update'), { status: 404 })));
  assert.equal(snapshotWrite.ok, false, 'quote-version-term is fully managed');
});

test('the operational path is untouched: no snapshot, manual inputs, operational provenance', async (t) => {
  const root = project(t, { withLifecycle: true });
  const context = await boot(root, join(root, 'data', 'signed-terms-operational.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const actor = { type: 'user', id: 'e2e' };

  const { order } = await signedOrder(root, app, { name: 'Operational Deal' });
  const planned = await app.runAction({ module: 'order', action: 'plan-activation', recordId: order.id, input: { policy: POLICY.policy, policyVersion: POLICY.policyVersion }, actor });
  assert.equal(planned.result.plan.termsProvenance.source, 'post-signature-operational-activation');
  assert.deepEqual(planned.result.plan.requiredInputs, ['effectiveDate', 'termStartDate', 'termEndDate', 'termsReason']);
  assert.equal(planned.result.plan.signedTerm, null);

  // Omitting the operational inputs still refuses — conditionally required
  // means required on THIS path, enforced where the condition is known.
  const missing = await refusal(app.runAction({
    module: 'order', action: 'activate-contract', recordId: order.id,
    input: { policy: POLICY.policy, policyVersion: POLICY.policyVersion },
    actor,
  }));
  assert.equal(missing.ok, false);
  assert.match(missing.message, /effectiveDate/);

  const activated = await app.runAction({
    module: 'order', action: 'activate-contract', recordId: order.id,
    input: {
      policy: POLICY.policy, policyVersion: POLICY.policyVersion,
      effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31',
      termsReason: 'Standard 12-month term agreed on the kickoff call',
    },
    actor,
  });
  assert.equal(activated.result.contract.termsSource, 'post-signature-operational-activation');
  const lifecycle = app.domains.capability({ consumer: 'lifecycle', capability: 'contract-lifecycle-source', version: 2, context: { modules: app.modules } });
  const evidence = lifecycle.termEvidence(activated.result.contract.id);
  assert.equal(evidence.term.signed, false);
  assert.match(evidence.term.provenanceNote, /OPERATIONAL metadata/);
});
