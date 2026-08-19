import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { POLICY, boot, project, signedOrder } from './helpers/contracts-project.js';

/**
 * **Signed-term integrity: the fingerprint is checked, not decorated.**
 *
 * ADR-033 stamps every signed-term snapshot with a canonical
 * `termsFingerprint`. Until this suite existed nothing ever recomputed it, so an
 * out-of-band mutation of the stored row — direct SQL, modelling database-level
 * corruption or a compromised operator, since every public and HTTP write path
 * to these managed records is already closed — travelled through activation,
 * `contract-lifecycle-source`, M16b succession and Admin **as signed evidence**.
 *
 * Each case here mutates exactly one thing and asserts the boundary fails
 * closed. The mutations are deliberately made with raw SQL: that is the threat
 * being modelled, and no supported interface can produce them.
 *
 * The compatibility rule the suite also pins: a snapshot that verifies produces
 * a byte-identical outcome, and history without a snapshot is untouched.
 */

const ACTOR = { type: 'user', id: 'integrity' };
const TERM = {
  effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31',
  autoRenew: true, renewalNoticeDays: 60,
};
const OFFERS = ['fixture:offer:enterprise', 'fixture:offer:support-annual'];

/** A signed order with a signed term, ready to activate. */
async function scene(t, tag) {
  const root = project(t, { withLifecycle: true });
  const context = await boot(root, join(root, 'data', `${tag}.sqlite`));
  t.after(() => context.close());
  const { app } = context;
  const signed = await signedOrder(root, app, { name: `${tag} deal`, offers: OFFERS, term: TERM });
  return { root, context, app, db: app.database.raw, ...signed };
}

async function refusal(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, code: error.code ?? null, status: error.status ?? null, message: String(error.message), details: error.details ?? null };
  }
}

const activate = (app, orderId) => app.runAction({
  module: 'order', action: 'activate-contract', recordId: orderId, input: { ...POLICY }, actor: ACTOR,
});

/**
 * Every single-field tamper on the Order's signed-term snapshot. Each one keeps
 * `document_hash` intact — that check already existed and is not what this
 * suite is about; what is new is that the values must match the fingerprint
 * they carry and the authoritative version snapshot they were copied from.
 */
const FIELD_TAMPERS = [
  ['effectiveDate alone', "UPDATE order_terms SET effective_date = '2026-01-01' WHERE order_id = ?"],
  ['termStartDate alone', "UPDATE order_terms SET term_start_date = '2026-10-01' WHERE order_id = ?"],
  ['termEndDate alone', "UPDATE order_terms SET term_end_date = '2099-12-31' WHERE order_id = ?"],
  ['termDays alone', 'UPDATE order_terms SET term_days = 99999 WHERE order_id = ?'],
  ['autoRenew alone', 'UPDATE order_terms SET auto_renew = 0 WHERE order_id = ?'],
  ['renewalNoticeDays alone', 'UPDATE order_terms SET renewal_notice_days = 5 WHERE order_id = ?'],
  ['termsContract alone', 'UPDATE order_terms SET terms_contract = 2 WHERE order_id = ?'],
  ['termsFingerprint alone', "UPDATE order_terms SET terms_fingerprint = 'f' || substr(terms_fingerprint, 2) WHERE order_id = ?"],
];

for (const [label, sql] of FIELD_TAMPERS) {
  test(`a tampered signed term fails closed at activation: ${label}`, async (t) => {
    const s = await scene(t, `tamper-${label.replace(/[^a-z]+/gi, '-').toLowerCase()}`);
    s.db.prepare(sql).run(s.order.id);

    const refused = await refusal(activate(s.app, s.order.id));
    assert.equal(refused.ok, false, `${label} must not activate`);
    assert.equal(refused.code, 'TERMS_FINGERPRINT_MISMATCH');
    assert.equal(refused.status, 409);

    // Nothing was written, and the refusal never echoes the hostile value.
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM commercial_contracts').get().n, 0);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM contract_activations').get().n, 0);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n, 0);
    assert.doesNotMatch(refused.message, /2099|99999|2026-01-01|2026-10-01/,
      'a refusal states what failed, never the value somebody planted');
    // The failed attempt leaves an honest failed trace and no success audit.
    const runs = s.app.workflows.listRuns({ workflowName: 'order.activate-contract', limit: 5 });
    assert.ok(runs.every((entry) => entry.status === 'failed'), 'no run claims success');
  });
}

test('a snapshot whose values diverge from the authoritative version snapshot fails closed', async (t) => {
  const s = await scene(t, 'diverged');
  // Self-consistent — fingerprint recomputed to match the tampered values — but
  // no longer the term the quote version froze and the document hashed. Only
  // the linkage check catches this one.
  const { signedTermFingerprint } = await import('../packages/commercial/src/terms.js');
  const forged = {
    termsContract: 1,
    effectiveDate: '2026-09-01',
    termStartDate: '2026-09-01',
    termEndDate: '2030-08-31',
    termDays: 1461,
    autoRenew: true,
    renewalNoticeDays: 60,
  };
  s.db.prepare('UPDATE order_terms SET term_end_date = ?, term_days = ?, terms_fingerprint = ? WHERE order_id = ?')
    .run(forged.termEndDate, forged.termDays, signedTermFingerprint(forged), s.order.id);

  const refused = await refusal(activate(s.app, s.order.id));
  assert.equal(refused.ok, false, 'a self-consistent forgery is still not what was signed');
  assert.equal(refused.code, 'TERMS_SNAPSHOT_DIVERGED');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM commercial_contracts').get().n, 0);
});

test('a signed term borrowed from another order is refused, and so is a duplicate snapshot', async (t) => {
  const s = await scene(t, 'crosslinked');
  const other = await signedOrder(s.root, s.app, {
    name: 'other deal', offers: OFFERS, company: s.company,
    term: { ...TERM, effectiveDate: '2027-01-01', termStartDate: '2027-01-01', termEndDate: '2027-12-31' },
  });

  // Point this order's snapshot at another order's quote version: every value
  // is real and self-consistent, and it is still not this order's evidence.
  s.db.prepare('UPDATE order_terms SET quote_version_id = ? WHERE order_id = ?').run(other.versionId, s.order.id);
  const crossed = await refusal(activate(s.app, s.order.id));
  assert.equal(crossed.ok, false);
  assert.equal(crossed.code, 'TERMS_SNAPSHOT_DIVERGED');

  // A second snapshot for one order cannot exist at all: the schema's own
  // UNIQUE constraint refuses it before any verifier is consulted, which is a
  // stronger guarantee than a check in code. The verifier keeps its
  // `TERMS_SNAPSHOT_AMBIGUOUS` arm as defence in depth for a project that
  // renamed the record and lost the constraint — but the guarantee this
  // repository actually ships is the database's.
  s.db.prepare('UPDATE order_terms SET quote_version_id = ? WHERE order_id = ?').run(s.versionId, s.order.id);
  const row = s.db.prepare('SELECT * FROM order_terms WHERE order_id = ?').get(s.order.id);
  assert.throws(
    () => s.db.prepare(`INSERT INTO order_terms (id, source_key, order_id, quote_version_id, effective_date,
        term_start_date, term_end_date, term_days, auto_renew, renewal_notice_days, terms_contract,
        terms_fingerprint, document_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`${row.id}-dup`, `${row.source_key}-dup`, row.order_id, row.quote_version_id, row.effective_date,
        row.term_start_date, '2031-01-01', row.term_days, row.auto_renew, row.renewal_notice_days,
        row.terms_contract, row.terms_fingerprint, row.document_hash, row.created_at, row.updated_at),
    /UNIQUE constraint failed: order_terms.order_id/,
    'one order carries at most one signed-term snapshot, enforced by the schema',
  );

  // …and with the linkage restored, the untampered order still activates.
  const activated = await activate(s.app, s.order.id);
  assert.equal(activated.result.contract.termsSource, 'signed-order-terms');
});

test('a removed snapshot is absence, not a signed term — and the order stays unactivatable as signed', async (t) => {
  const s = await scene(t, 'removed');
  s.db.prepare('DELETE FROM order_terms WHERE order_id = ?').run(s.order.id);
  // Absence is the ordinary historical case: activation falls back to the M12
  // operational path, which requires its own inputs and says so.
  const refused = await refusal(activate(s.app, s.order.id));
  assert.equal(refused.ok, false, 'the operational path needs its own inputs');
  assert.match(refused.message, /effectiveDate/);
  assert.notEqual(refused.code, 'TERMS_FINGERPRINT_MISMATCH');
});

test('the tamper is caught before the successor exists, and a restored snapshot activates identically', async (t) => {
  const s = await scene(t, 'restore');
  const original = s.db.prepare('SELECT term_end_date, terms_fingerprint FROM order_terms WHERE order_id = ?').get(s.order.id);

  s.db.prepare("UPDATE order_terms SET term_end_date = '2099-12-31' WHERE order_id = ?").run(s.order.id);
  assert.equal((await refusal(activate(s.app, s.order.id))).code, 'TERMS_FINGERPRINT_MISMATCH');

  // Restoring the evidence restores the behaviour: a valid snapshot is
  // byte-identical to what it always produced, and the retry is safe.
  s.db.prepare('UPDATE order_terms SET term_end_date = ? WHERE order_id = ?').run(original.term_end_date, s.order.id);
  const activated = await activate(s.app, s.order.id);
  const contract = activated.result.contract;
  assert.equal(contract.termsSource, 'signed-order-terms');
  assert.equal(contract.termEndDate, TERM.termEndDate);
  assert.equal(contract.termDays, 365);

  const lifecycle = s.app.domains.capability({
    consumer: 'lifecycle', capability: 'contract-lifecycle-source', version: 2, context: { modules: s.app.modules },
  });
  assert.equal(lifecycle.termEvidence(contract.id).term.signed, true);
});

test('a tampered version snapshot cannot be signed: the document builder refuses before the provider is called', async (t) => {
  const root = project(t, { withDomain: false });
  const context = await boot(root, join(root, 'data', 'presign.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const db = app.database.raw;

  await app.syncCatalog({ provider: 'fixture-saas-catalog', actor: ACTOR });
  const book = app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
  const offer = app.modules.get('offer').service.listWhere({ logicalKey: 'fixture:offer:enterprise', active: true })[0];
  const company = await app.services.companies.create({ name: 'Presign SpA' }, { actor: ACTOR });
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, name: 'Presign', type: 'new_business', valueCents: 100_000, currency: 'EUR', stage: 'discovery', owner: 'e2e' },
    { actor: ACTOR },
  );
  const quote = (await app.runAction({ module: 'opportunity', action: 'create-quote', recordId: opportunity.id, input: { priceBookId: book.id }, actor: ACTOR })).result.quote;
  await app.runAction({ module: 'quote', action: 'add-line', recordId: quote.id, input: { offerId: offer.id, quantity: 5 }, actor: ACTOR });
  await app.modules.get('quote-term').service.create({ quoteId: quote.id, ...TERM }, { actor: ACTOR });
  const submitted = await app.runAction({ module: 'quote', action: 'submit', recordId: quote.id, input: { policy: 'standard-sales-discount', version: 1 }, actor: ACTOR });
  const versionId = submitted.result.version.id;
  if (submitted.result.version.decision === 'approval_required') {
    await app.runAction({ module: 'quote', action: 'approve', recordId: quote.id, input: {}, actor: ACTOR });
  }

  // Corrupt the frozen version snapshot BEFORE the signature is requested: the
  // customer must never be asked to sign a document built from evidence that
  // does not match its own fingerprint.
  db.prepare("UPDATE quote_version_terms SET term_end_date = '2099-12-31' WHERE version_id = ?").run(versionId);

  const refused = await refusal(app.runAction({
    module: 'quote', action: 'request-signature', recordId: quote.id,
    input: {
      quoteVersionId: versionId, provider: 'fixture-signature', providerVersion: 1,
      signers: [{ name: 'Mario Rossi', email: 'presign@example.com', role: 'customer' }],
    },
    actor: ACTOR,
  }));
  assert.equal(refused.ok, false, 'a corrupt snapshot must not reach a signature request');
  assert.equal(refused.code, 'TERMS_FINGERPRINT_MISMATCH');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM signature_envelopes').get().n, 0,
    'no envelope exists, so no provider was called');
});
