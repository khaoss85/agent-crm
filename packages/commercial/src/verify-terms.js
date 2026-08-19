// @ts-check

import { AppError } from '../../core/index.js';
import { signedTermFingerprint } from './terms.js';

/**
 * **The signed-term verifier — Commercial's authority, and the only one.**
 *
 * ADR-033 stamps every signed-term snapshot with a canonical
 * `termsFingerprint`. Storing one and never recomputing it makes the
 * fingerprint a decoration: an out-of-band mutation of the stored row (direct
 * SQL — every public and HTTP write path to these managed records is already
 * closed) then travels through activation, `contract-lifecycle-source`, M16b
 * succession and Admin **as signed evidence**. That was the M-1 finding of the
 * M16b review, and this module closes it.
 *
 * The semantics of a term fingerprint belong to Commercial, which owns
 * `quote-version-term` and `signedTermFingerprint`. They stay here: no other
 * package recomputes a fingerprint, and nothing moves into core. Consumers
 * reach this only through `commercial-quotes@2`.
 *
 * An `order-term` is a **copy** of a `quote-version-term`, so verifying one is
 * two questions, both Commercial's to answer:
 *
 * 1. **self-consistency** — do the row's own values still hash to the
 *    fingerprint it carries?
 * 2. **linkage** — are those values the ones the authoritative version
 *    snapshot froze, for the version this row names?
 *
 * A forgery can satisfy the first by recomputing the fingerprint over its own
 * lie; only the second catches it. Both are required, and both refuse before
 * any business write and before any provider call.
 *
 * The refusals name **ids and field names only**. A refusal that echoed the
 * planted value would put attacker-controlled text into an operator's console,
 * a log line and an error page, which is exactly the surface this repository
 * closes everywhere else.
 */

/** The fields that constitute a signed term, in the canonical tuple order. */
export const SIGNED_TERM_FIELDS = Object.freeze([
  'termsContract', 'effectiveDate', 'termStartDate', 'termEndDate', 'termDays', 'autoRenew', 'renewalNoticeDays',
]);

export const TERMS_FINGERPRINT_MISMATCH = 'TERMS_FINGERPRINT_MISMATCH';
export const TERMS_SNAPSHOT_DIVERGED = 'TERMS_SNAPSHOT_DIVERGED';
export const TERMS_SNAPSHOT_AMBIGUOUS = 'TERMS_SNAPSHOT_AMBIGUOUS';
/** The snapshot is not what the signed document says — or says nothing at all. */
export const TERMS_NOT_IN_SIGNED_DOCUMENT = 'TERMS_NOT_IN_SIGNED_DOCUMENT';
/** The signed bytes are unavailable, so "signed" cannot be proven either way. */
export const TERMS_DOCUMENT_UNAVAILABLE = 'TERMS_DOCUMENT_UNAVAILABLE';

/**
 * Normalize a stored snapshot row into the exact tuple the fingerprint covers.
 * SQLite answers booleans as 0/1 and the generated services map them back, so
 * both shapes arrive here and both must normalize identically — otherwise the
 * verifier would refuse honest evidence depending on which reader produced it.
 *
 * @param {any} row
 */
export function normalizeSignedTerm(row) {
  return {
    termsContract: Number(row?.termsContract),
    effectiveDate: String(row?.effectiveDate ?? ''),
    termStartDate: String(row?.termStartDate ?? ''),
    termEndDate: String(row?.termEndDate ?? ''),
    termDays: Number(row?.termDays),
    autoRenew: row?.autoRenew === true || row?.autoRenew === 1,
    renewalNoticeDays: Number(row?.renewalNoticeDays ?? 0),
  };
}

/** @param {string} code @param {string} message @param {any} details */
function refuse(code, message, details) {
  throw new AppError(message, { code, status: 409, details: Object.freeze(details) });
}

/**
 * Verify one snapshot against its own fingerprint.
 *
 * @param {any} row a `quote-version-term` or `order-term` row
 * @param {{kind: string, id: string}} subject what is being verified, for the refusal
 * @returns {Readonly<ReturnType<typeof normalizeSignedTerm>>} the frozen normalized term
 */
export function verifySelfConsistent(row, subject) {
  const normalized = normalizeSignedTerm(row);
  for (const field of SIGNED_TERM_FIELDS) {
    const value = /** @type {any} */ (normalized)[field];
    if (value === '' || (typeof value === 'number' && !Number.isFinite(value))) {
      refuse(TERMS_FINGERPRINT_MISMATCH,
        `The ${subject.kind} signed-term snapshot is incomplete and cannot be verified as signed evidence`,
        { [`${subject.kind}Id`]: subject.id, field });
    }
  }
  const recomputed = signedTermFingerprint(normalized);
  const claimed = typeof row?.termsFingerprint === 'string' ? row.termsFingerprint : '';
  if (recomputed !== claimed) {
    // Neither fingerprint is echoed: the stored one is attacker-controlled in
    // exactly the case this refusal exists for.
    refuse(TERMS_FINGERPRINT_MISMATCH,
      `The ${subject.kind} signed-term snapshot does not match its own recorded fingerprint, so it is not the term that was signed`,
      { [`${subject.kind}Id`]: subject.id });
  }
  return Object.freeze(normalized);
}

/**
 * Verify that a copied snapshot still says what the authoritative one froze.
 *
 * @param {any} copy the `order-term` row
 * @param {any} authoritative the `quote-version-term` row it was copied from
 * @param {{orderId: string, quoteVersionId: string}} subject
 */
export function verifyMatchesAuthoritative(copy, authoritative, subject) {
  const left = normalizeSignedTerm(copy);
  const right = normalizeSignedTerm(authoritative);
  const diverged = SIGNED_TERM_FIELDS.filter((field) => /** @type {any} */ (left)[field] !== /** @type {any} */ (right)[field]);
  if (diverged.length > 0) {
    refuse(TERMS_SNAPSHOT_DIVERGED,
      'The order\'s signed-term snapshot no longer matches the quote version it was copied from, so it is not the term that was signed',
      { orderId: subject.orderId, quoteVersionId: subject.quoteVersionId, fields: Object.freeze([...diverged]) });
  }
  return Object.freeze(left);
}

/**
 * Verify the snapshot against **the signed document itself** — the third and
 * only anchor outside the attacker's reach in the threat model this verifier
 * exists for.
 *
 * Self-consistency and snapshot linkage both compare rows to other rows. An
 * out-of-band writer — the exact threat ADR-036 names — can rewrite the order
 * copy *and* the version snapshot together and recompute both fingerprints;
 * the two questions then agree with each other about a term nobody signed.
 * Worse, the same writer can INSERT a matching pair for an order whose signed
 * document carried no term at all, manufacturing signed evidence from nothing.
 *
 * The canonical document is what the customer actually signed: its bytes are
 * stored on the envelope, its hash is the `documentHash` the order, envelope
 * and artifact must all agree on, and completion re-hashes the stored bytes
 * before an Order exists. Comparing the snapshot to the `terms` section of
 * those bytes is therefore a check a row-rewriter cannot satisfy without also
 * forging the document and every hash that covers it.
 *
 * `documentTerms` is the parsed `terms` section (or `null` when the signed
 * document carried none). Passing `undefined` is a programming error: a caller
 * that cannot produce the document must say so, not silently downgrade the
 * guarantee.
 *
 * @param {any} normalized the normalized snapshot tuple
 * @param {any} documentTerms the signed document's `terms` section, or null
 * @param {{orderId: string, quoteVersionId: string}} subject
 */
export function verifyMatchesSignedDocument(normalized, documentTerms, subject) {
  if (documentTerms === undefined) {
    refuse(TERMS_DOCUMENT_UNAVAILABLE,
      'The signed document was not supplied, so this snapshot cannot be confirmed against what was signed',
      { orderId: subject.orderId, quoteVersionId: subject.quoteVersionId });
  }
  if (documentTerms === null) {
    refuse(TERMS_NOT_IN_SIGNED_DOCUMENT,
      'The signed document carried no commercial term, so this snapshot is not evidence of a signed term',
      { orderId: subject.orderId, quoteVersionId: subject.quoteVersionId });
  }
  const signed = normalizeSignedTerm(documentTerms);
  const diverged = SIGNED_TERM_FIELDS.filter(
    (field) => /** @type {any} */ (normalized)[field] !== /** @type {any} */ (signed)[field]);
  if (diverged.length > 0) {
    refuse(TERMS_NOT_IN_SIGNED_DOCUMENT,
      'The signed-term snapshot does not match the term inside the signed document, so it is not the term that was signed',
      { orderId: subject.orderId, quoteVersionId: subject.quoteVersionId, fields: Object.freeze([...diverged]) });
  }
  return Object.freeze(signed);
}

/**
 * The `order-term` verification in full: exactly one snapshot, self-consistent,
 * identical to the authoritative version snapshot it names, **and** identical
 * to the term inside the document that was actually signed.
 *
 * `rows`, `authoritativeFor` and `documentTerms` are supplied by the caller,
 * which is the only thing holding storage handles — this function never
 * reaches a database.
 *
 * @param {{rows: any[], authoritativeFor: (versionId: string) => any, orderId: string, documentTerms?: any}} input
 */
export function verifyOrderTermRows({ rows, authoritativeFor, orderId, documentTerms }) {
  const snapshots = Array.isArray(rows) ? rows : [];
  if (snapshots.length === 0) return null; // absence is history, never a failure
  if (snapshots.length > 1) {
    refuse(TERMS_SNAPSHOT_AMBIGUOUS,
      'This order carries more than one signed-term snapshot, so which term was signed cannot be decided from the evidence',
      { orderId, count: snapshots.length });
  }
  const [row] = snapshots;
  const verified = verifySelfConsistent(row, { kind: 'order', id: orderId });
  const quoteVersionId = typeof row?.quoteVersionId === 'string' ? row.quoteVersionId : '';
  const authoritative = quoteVersionId ? authoritativeFor(quoteVersionId) : null;
  if (!authoritative) {
    refuse(TERMS_SNAPSHOT_DIVERGED,
      'The order\'s signed-term snapshot names a quote version that has no signed term, so its provenance cannot be confirmed',
      { orderId, quoteVersionId });
  }
  verifySelfConsistent(authoritative, { kind: 'quoteVersion', id: quoteVersionId });
  verifyMatchesAuthoritative(row, authoritative, { orderId, quoteVersionId });
  // The anchor the other two questions cannot provide: both compare rows to
  // rows, and a writer that can rewrite one can rewrite the other.
  verifyMatchesSignedDocument(verified, documentTerms, { orderId, quoteVersionId });
  return { verified, row };
}
