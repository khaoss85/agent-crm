import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { boot, project } from './helpers/contracts-project.js';
import { ACTOR, FORGED, OFFERS, TERM, activate, fingerprintOf, refusal, scene } from './helpers/signed-terms-scene.js';
import { signedOrder } from './helpers/contracts-project.js';

/**
 * Signed-term integrity, shard 4 of 4: the anchor outside the attacker's reach.
 * Split from `tests/signed-terms-integrity.test.js` (backlog:d549f58bfcf8):
 * the whole file exceeded the 600 s per-file ceiling of the scheduled full,
 * so the 16 unchanged cases now live in four files of four. No case removed,
 * no assertion changed — only the import moved to the shared scene helper.
 *
 * Self-consistency and snapshot linkage both compare a row to another row. The
 * threat this verifier models is an out-of-band writer, and a writer that can
 * rewrite one row can rewrite two: rewriting the order copy *and* the version
 * snapshot together, recomputing both fingerprints, satisfies both questions
 * about a term nobody signed. The same writer can INSERT a matching pair for an
 * order whose signed document carried no term at all, manufacturing signed
 * evidence out of nothing.
 *
 * Both were reachable before the signed-document check existed, and both are
 * proven closed here. The canonical document is the anchor: it is what the
 * customer signed, its bytes are stored on the envelope, and its hash is the
 * one the order, envelope and artifact must already agree on.
 */

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

test('a consistent two-row forgery is refused: linkage alone cannot survive a writer that rewrites both', async (t) => {
  const s = await scene(t, 'forge-both-rows');
  const fingerprint = await fingerprintOf(FORGED);

  // Rewrite the order copy AND the authoritative version snapshot together,
  // recomputing both fingerprints — the forgery that satisfies both row-to-row
  // questions at once.
  s.db.prepare('UPDATE order_terms SET term_end_date = ?, term_days = ?, terms_fingerprint = ? WHERE order_id = ?')
    .run(FORGED.termEndDate, FORGED.termDays, fingerprint, s.order.id);
  s.db.prepare('UPDATE quote_version_terms SET term_end_date = ?, term_days = ?, terms_fingerprint = ? WHERE version_id = ?')
    .run(FORGED.termEndDate, FORGED.termDays, fingerprint, s.versionId);

  const refused = await refusal(activate(s.app, s.order.id));
  assert.equal(refused.ok, false, 'a term the signed document does not contain must never activate');
  assert.equal(refused.code, 'TERMS_NOT_IN_SIGNED_DOCUMENT');
  assert.match(refused.message, /does not match the term inside the signed document/);

  // The refusal names fields, never the planted value.
  assert.equal(JSON.stringify(refused.details ?? {}).includes('2030-12-31'), false,
    'the refusal must not echo the attacker-controlled value');
  assert.deepEqual(refused.details.fields, ['termEndDate', 'termDays']);

  // Fails closed: nothing was written on the way to the refusal.
  for (const table of ['commercial_contracts', 'contract_versions', 'contract_activations', 'subscriptions']) {
    assert.equal(s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} must be empty`);
  }

  // And the signed document still says what was actually signed.
  const envelope = s.db.prepare('SELECT document_json FROM signature_envelopes WHERE quote_version_id = ?').get(s.versionId);
  assert.equal(JSON.parse(envelope.document_json).terms.termEndDate, '2027-08-31');
});

test('signed terms cannot be manufactured for an order whose document signed none', async (t) => {
  const root = project(t, { withLifecycle: true });
  const context = await boot(root, join(root, 'data', 'forge-from-nothing.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const db = app.database.raw;

  // An order signed with NO term at all: the historical, ordinary case.
  const bare = await signedOrder(root, app, { name: 'no term deal', offers: OFFERS });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_terms WHERE order_id = ?').get(bare.order.id).n, 0);
  assert.equal(Object.hasOwn(JSON.parse(db.prepare('SELECT document_json FROM signature_envelopes WHERE quote_version_id = ?').get(bare.versionId).document_json), 'terms'), false,
    'the signed document carried no terms section at all');

  // Plant a self-consistent, correctly linked PAIR out of thin air.
  const fingerprint = await fingerprintOf(FORGED);
  const stamp = '2026-09-01T00:00:00.000Z';
  db.prepare(`INSERT INTO quote_version_terms
      (id, source_key, version_id, quote_id, effective_date, term_start_date, term_end_date, term_days, auto_renew, renewal_notice_days, terms_contract, terms_fingerprint, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('forged-qvt', `qvt:${bare.versionId}`, bare.versionId, bare.quote.id, FORGED.effectiveDate, FORGED.termStartDate,
      FORGED.termEndDate, FORGED.termDays, 1, FORGED.renewalNoticeDays, FORGED.termsContract, fingerprint, stamp, stamp);
  const documentHash = db.prepare('SELECT document_hash FROM signature_envelopes WHERE quote_version_id = ?').get(bare.versionId).document_hash;
  db.prepare(`INSERT INTO order_terms
      (id, source_key, order_id, quote_version_id, effective_date, term_start_date, term_end_date, term_days, auto_renew, renewal_notice_days, terms_contract, terms_fingerprint, document_hash, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('forged-ot', `order-term:order:${bare.order.id}`, bare.order.id, bare.versionId, FORGED.effectiveDate, FORGED.termStartDate,
      FORGED.termEndDate, FORGED.termDays, 1, FORGED.renewalNoticeDays, FORGED.termsContract, fingerprint, documentHash, stamp, stamp);

  const refused = await refusal(activate(app, bare.order.id));
  assert.equal(refused.ok, false, 'a term the customer never signed must never become signed evidence');
  assert.equal(refused.code, 'TERMS_NOT_IN_SIGNED_DOCUMENT');
  assert.match(refused.message, /signed document carried no commercial term/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM commercial_contracts').get().n, 0);
});

test('a caller that cannot produce the signed document is refused, never downgraded', async (t) => {
  const s = await scene(t, 'forge-no-document');
  const rows = s.app.modules.get('order-term').service.listWhere({ orderId: s.order.id });
  const quotes = s.app.domains.capability({
    consumer: 'contracts', capability: 'commercial-quotes', version: 2, context: { modules: s.app.modules },
  });

  // Omitting `documentTerms` entirely is a caller that never produced the
  // signed bytes: the weaker guarantee is refused rather than silently given.
  const refused = await refusal(Promise.resolve().then(() => quotes.verifySignedTerms({ scope: 'order', orderId: s.order.id, rows })));
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'TERMS_DOCUMENT_UNAVAILABLE');

  // Supplying the real document verifies, and answers the term that was signed.
  const document = JSON.parse(s.db.prepare('SELECT document_json FROM signature_envelopes WHERE quote_version_id = ?').get(s.versionId).document_json);
  const verified = await quotes.verifySignedTerms({ scope: 'order', orderId: s.order.id, rows, documentTerms: document.terms });
  assert.equal(verified.verified.termEndDate, '2027-08-31');
});
