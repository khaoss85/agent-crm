// @ts-check

import { createHash } from 'node:crypto';
import { AppError, ValidationError } from '../../core/index.js';
import {
  MAX_ROWS, domainShape, emailShape, normalizeCompanyName, normalizeEmail,
  requireExternalId, requireSystem, safeString,
} from './normalize.js';
import { assertMatchResult } from './policy.js';

export { MAX_ROWS };

/**
 * **Customer import v1 — preview writes nothing, apply proves everything again.**
 *
 * Rows arrive as bounded data. There is no file path, no remote provider, no
 * credential and no arbitrary execution in this milestone: an import is a
 * bounded ask with a hard row cap, hard field caps and control-safe strings.
 *
 * Two properties this file exists to guarantee:
 *
 * 1. **Preview is free of consequence.** It runs the whole resolution and
 *    returns the receipts it *would* write, and it writes nothing at all —
 *    not a business record, not even a `customer-data` row. A test fingerprints
 *    the entire database around it.
 * 2. **Apply is authoritative.** It never trusts a preview: it re-reads, re-
 *    resolves and re-decides inside its own transaction. A stale preview
 *    authorises nothing, which is the same rule M16b execution follows.
 *
 * The idempotency key is **business-derived** — the system, the mapping
 * fingerprint and the canonical digest of the rows — so the same payload
 * retried returns the same run, and a *different* payload under the same key
 * is a conflict refusal rather than a silent adoption. `now()` and randomness
 * appear nowhere in it.
 */

export const IMPORT_MAPPING = Object.freeze({
  name: 'customer-rows',
  version: 1,
  /** Declared field mapping: input key → normalized meaning. */
  fields: Object.freeze([
    { input: 'externalId', meaning: 'external identifier within the declared system' },
    { input: 'email', meaning: 'contact email; matched through the core adapter that owns email uniqueness' },
    { input: 'firstName', meaning: 'contact given name' },
    { input: 'lastName', meaning: 'contact family name' },
    { input: 'companyName', meaning: 'company legal or trading name' },
    { input: 'domain', meaning: 'company primary domain' },
  ]),
});

/** Stable reason codes. A receipt names one of these, never free text alone. */
export const REASON = Object.freeze({
  MATCHED: 'MATCHED_EXISTING',
  CREATED: 'CREATED_RECORD',
  AMBIGUOUS: 'AMBIGUOUS_CANDIDATES',
  INVALID_EMAIL: 'INVALID_EMAIL',
  INVALID_DOMAIN: 'INVALID_DOMAIN',
  MISSING_IDENTITY: 'MISSING_REQUIRED_IDENTITY',
  UNSAFE_VALUE: 'UNSAFE_VALUE',
  DUPLICATE_IN_BATCH: 'DUPLICATE_WITHIN_BATCH',
});

/** The mapping fingerprint: declared shape only, no closure state. */
export function mappingFingerprint() {
  return createHash('sha256')
    .update(JSON.stringify(['customer-import-mapping', IMPORT_MAPPING.name, IMPORT_MAPPING.version,
      IMPORT_MAPPING.fields.map((field) => field.input)]), 'utf8')
    .digest('hex');
}

/** One row's canonical digest — order-independent across the batch. */
function rowDigest(row) {
  return createHash('sha256')
    .update(JSON.stringify([
      row.externalId ?? null, row.email ?? null, row.firstName ?? null,
      row.lastName ?? null, row.companyName ?? null, row.domain ?? null,
    ]), 'utf8')
    .digest('hex');
}

/**
 * The business-derived idempotency key. Sorted row digests, so the same set of
 * rows in a different order is the same import — and a different set is a
 * different key rather than an accidental collision.
 *
 * @param {{system: string, rows: any[]}} input
 */
export function idempotencyKeyFor({ system, rows }) {
  const digests = rows.map((row) => rowDigest(row)).sort();
  return createHash('sha256')
    .update(JSON.stringify(['customer-import', system, mappingFingerprint(), digests]), 'utf8')
    .digest('hex');
}

/**
 * Normalize and bound the request before anything else happens. Everything
 * refused here is refused before a transaction opens.
 *
 * @param {any} request
 */
export function normalizeRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new ValidationError('an import needs a request object');
  }
  const system = requireSystem(request.system);
  const acceptance = request.acceptance ?? 'partial';
  if (acceptance !== 'partial' && acceptance !== 'all_or_nothing') {
    throw new ValidationError('acceptance must be "partial" or "all_or_nothing"', { field: 'acceptance' });
  }
  const rows = request.rows;
  if (!Array.isArray(rows)) throw new ValidationError('rows must be an array', { field: 'rows' });
  if (rows.length === 0) throw new ValidationError('an import needs at least one row', { field: 'rows' });
  if (rows.length > MAX_ROWS) {
    throw new ValidationError(`an import is bounded to ${MAX_ROWS} rows`, { field: 'rows' });
  }
  return { system, acceptance, rows };
}

/**
 * Validate and normalize one input row. Returns either a normalized row or the
 * receipt that explains why it cannot be one — a rejected row is never dropped.
 *
 * @param {any} raw @param {number} index @param {string} system
 */
export function normalizeRow(raw, index, system) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, index, reasonCode: REASON.UNSAFE_VALUE, reason: 'the row is not an object' };
  }
  let externalId = null;
  let firstName = null;
  let lastName = null;
  let companyName = null;
  try {
    externalId = raw.externalId === undefined || raw.externalId === null || raw.externalId === ''
      ? null : requireExternalId(raw.externalId);
    firstName = safeString(raw.firstName, 'firstName');
    lastName = safeString(raw.lastName, 'lastName');
    companyName = safeString(raw.companyName, 'companyName');
  } catch (error) {
    // The offending value is never echoed back into the receipt.
    return {
      ok: false, index, reasonCode: REASON.UNSAFE_VALUE,
      reason: error instanceof ValidationError ? error.message : 'the row carries a value this import will not store',
    };
  }

  const email = emailShape(raw.email);
  if (!email.ok && email.reason === 'shape') {
    return { ok: false, index, reasonCode: REASON.INVALID_EMAIL, reason: 'the email is not a valid address shape' };
  }
  const domain = domainShape(raw.domain);
  if (!domain.ok && domain.reason === 'shape') {
    return { ok: false, index, reasonCode: REASON.INVALID_DOMAIN, reason: 'the domain is not a valid domain shape' };
  }

  // Identity floor: without one of these the row names nobody.
  if (!externalId && !email.value && !companyName) {
    return {
      ok: false, index, reasonCode: REASON.MISSING_IDENTITY,
      reason: 'the row carries no external id, no email and no company name, so it identifies nobody',
    };
  }

  return {
    ok: true,
    index,
    row: Object.freeze({
      system,
      externalId,
      email: email.value ? normalizeEmail(email.value) : null,
      firstName,
      lastName,
      companyName,
      normalizedCompanyName: companyName ? normalizeCompanyName(companyName) : null,
      domain: domain.ok ? domain.value : null,
    }),
  };
}

/**
 * Resolve the whole batch against current state. **Read-only** — it opens no
 * transaction and writes nothing, so preview and apply share exactly one
 * resolution path and cannot drift.
 *
 * @param {{request: any, policy: any, reader: any}} input
 */
export function resolveBatch({ request, policy, reader }) {
  const { system, acceptance, rows } = normalizeRequest(request);
  const receipts = [];
  const seenInBatch = new Map();

  rows.forEach((raw, index) => {
    const normalized = normalizeRow(raw, index, system);
    if (!normalized.ok) {
      receipts.push({
        index, outcome: 'rejected', reasonCode: normalized.reasonCode, reason: normalized.reason,
        rule: 'none', subject: null, candidates: [], inputDigest: rowDigest(rawShape(raw)),
      });
      return;
    }
    const row = normalized.row;
    const digest = rowDigest(row);

    // A batch that names the same identity twice is a data problem in the
    // batch, not a licence to write twice. EVERY identity the row carries is
    // a key, not just the first one that happens to be present: one row keyed
    // by external id and a later row keyed by the same person's email are the
    // same identity, and keying on "the first field present" would let the
    // second through.
    // The company key identifies the ROW only when the row carries no stronger
    // identity of its own: two different people at the same employer share a
    // company name and are emphatically not duplicates of each other.
    const identifiesByCompanyAlone = !row.externalId && !row.email;
    const batchKeys = [
      row.externalId ? `x:${row.externalId}` : null,
      row.email ? `e:${row.email}` : null,
      identifiesByCompanyAlone && row.normalizedCompanyName ? `c:${row.normalizedCompanyName}|${row.domain ?? ''}` : null,
    ].filter(Boolean);
    const clash = batchKeys.map((key) => seenInBatch.get(key)).find((seen) => seen !== undefined);
    if (clash !== undefined) {
      receipts.push({
        index, outcome: 'rejected', reasonCode: REASON.DUPLICATE_IN_BATCH,
        reason: `the same identity appears earlier in this batch at row ${clash}`,
        rule: 'none', subject: null, candidates: [], inputDigest: digest,
      });
      return;
    }

    const result = assertMatchResult(policy.resolve({ row, reader }), `Customer match policy "${policy.name}@${policy.version}"`);

    // …and two rows that RESOLVE to the same existing record are the same
    // identity too, however differently they were written.
    const subjectKey = result.subject && (identifiesByCompanyAlone || result.subject.resource !== 'company')
      ? `s:${result.subject.resource}:${result.subject.id}`
      : null;
    if (subjectKey && seenInBatch.has(subjectKey)) {
      receipts.push({
        index, outcome: 'rejected', reasonCode: REASON.DUPLICATE_IN_BATCH,
        reason: `this row resolves to the same record as row ${seenInBatch.get(subjectKey)} earlier in this batch`,
        rule: result.rule, subject: null, candidates: [], inputDigest: digest,
      });
      return;
    }
    for (const key of batchKeys) seenInBatch.set(key, index);
    if (subjectKey) seenInBatch.set(subjectKey, index);
    if (result.outcome === 'matched') {
      receipts.push({
        index, outcome: 'accepted', reasonCode: REASON.MATCHED, reason: result.evidence,
        rule: result.rule, subject: result.subject, candidates: [], inputDigest: digest, row, created: false,
      });
      return;
    }
    if (result.outcome === 'unresolved') {
      receipts.push({
        index, outcome: 'skipped', reasonCode: REASON.AMBIGUOUS, reason: result.evidence,
        rule: result.rule, subject: null, candidates: result.candidates, inputDigest: digest, row,
      });
      return;
    }
    receipts.push({
      index, outcome: 'accepted', reasonCode: REASON.CREATED, reason: 'no existing record matched, so this row creates one',
      rule: result.rule, subject: null, candidates: [], inputDigest: digest, row, created: true,
    });
  });

  const counts = {
    rows: rows.length,
    accepted: receipts.filter((receipt) => receipt.outcome === 'accepted').length,
    rejected: receipts.filter((receipt) => receipt.outcome === 'rejected').length,
    skipped: receipts.filter((receipt) => receipt.outcome === 'skipped').length,
  };
  // The reconciliation the brief demands, asserted rather than assumed.
  if (counts.accepted + counts.rejected + counts.skipped !== counts.rows) {
    throw new AppError('an import receipt went missing, so the run summary cannot be trusted', {
      code: 'IMPORT_RECEIPTS_UNRECONCILED', status: 500,
    });
  }
  return { system, acceptance, receipts, counts, idempotencyKey: idempotencyKeyFor({ system, rows: receipts.map((r) => r.row ?? rawShape(rows[r.index])) }) };
}

/** The shape a rejected raw row still hashes to, without trusting its types. */
function rawShape(raw) {
  const pick = (value) => (typeof value === 'string' ? value.slice(0, 300) : value === null || value === undefined ? null : String(value).slice(0, 300));
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    externalId: pick(source.externalId), email: pick(source.email), firstName: pick(source.firstName),
    lastName: pick(source.lastName), companyName: pick(source.companyName), domain: pick(source.domain),
  };
}
