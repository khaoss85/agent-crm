import test from 'node:test';
import assert from 'node:assert/strict';
import { TERM, activate, refusal, scene } from './helpers/signed-terms-scene.js';
import { signedOrder } from './helpers/contracts-project.js';

/**
 * Signed-term integrity, shard 3 of 4: snapshot linkage.
 * Split from `tests/signed-terms-integrity.test.js` (backlog:d549f58bfcf8):
 * the whole file exceeded the 600 s per-file ceiling of the scheduled full,
 * so the 16 unchanged cases now live in four files of four. No case removed,
 * no assertion changed — only the import moved to the shared scene helper.
 *
 * The compatibility rule these cases pin: a snapshot that verifies produces
 * a byte-identical outcome, and history without a snapshot is untouched.
 */

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
    name: 'other deal', offers: ['fixture:offer:enterprise', 'fixture:offer:support-annual'], company: s.company,
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
