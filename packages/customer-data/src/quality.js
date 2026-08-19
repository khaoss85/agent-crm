// @ts-check

import { REASON } from './import.js';
import { subjectKey, trusted } from './store.js';

/**
 * **Data-quality detectors: explainable findings, not a rules engine.**
 *
 * Each detector answers one narrow question with evidence a person can read,
 * and there is deliberately **no universal DSL** — a query language here would
 * be a second product, and an unbounded one. Adding a detector means writing a
 * function and naming its `kind` in the manifest enum, which is a reviewable
 * change rather than a configuration surface.
 *
 * Nothing here is a compliance claim. A finding is a finding.
 */

export const DETECTOR = 'customer-data-quality-v1';

/**
 * Findings from one import's own evidence, plus the standing invariants that
 * can be checked from stored rows.
 *
 * @param {{resolution: any, modules: any, names: any}} input
 */
export function detectIssues({ resolution, modules, names }) {
  const issues = [];

  for (const receipt of resolution.receipts) {
    // A row that identified nobody is a quality problem in the source, and it
    // is recorded against the run rather than against a record that
    // does not exist.
    if (receipt.reasonCode === REASON.MISSING_IDENTITY) {
      issues.push({
        kind: 'missing_required_identity', subject: null, index: receipt.index, detector: DETECTOR,
        evidence: `import row ${receipt.index} carried no external id, no email and no company name`,
      });
    }
    if (receipt.reasonCode === REASON.INVALID_EMAIL) {
      issues.push({
        kind: 'invalid_email', subject: null, index: receipt.index, detector: DETECTOR,
        evidence: `import row ${receipt.index} carried an email that is not a valid address shape`,
      });
    }
    if (receipt.reasonCode === REASON.INVALID_DOMAIN) {
      issues.push({
        kind: 'invalid_domain', subject: null, index: receipt.index, detector: DETECTOR,
        evidence: `import row ${receipt.index} carried a domain that is not a valid domain shape`,
      });
    }
    // An unresolved row is a standing question, not a silent skip.
    if (receipt.outcome === 'skipped' && receipt.reasonCode === REASON.AMBIGUOUS) {
      issues.push({
        kind: 'unresolved_import_row', subject: null, index: receipt.index, detector: DETECTOR,
        evidence: `import row ${receipt.index} matched more than one existing record and was left for a human: ${receipt.reason}`,
      });
      for (const candidate of receipt.candidates ?? []) {
        issues.push({
          kind: 'duplicate_candidate_open', subject: candidate, index: receipt.index, detector: DETECTOR,
          evidence: `this record is one of ${receipt.candidates.length} deterministic duplicate candidates from import row ${receipt.index}`,
        });
      }
    }
  }

  // One external identifier may name exactly one record. Two active rows under
  // the same `system:externalId` cannot both be right, and the import path
  // cannot create that state — but a restore, a migration or a second writer
  // can, so it is detected rather than assumed impossible.
  const identities = trusted(modules, names.identity).list({ limit: 1000 });
  const bySourceKey = new Map();
  for (const row of identities) {
    if (row.status !== 'active') continue;
    const key = row.sourceKey;
    const seen = bySourceKey.get(key);
    if (seen && subjectKey({ resource: seen.subjectResource, id: seen.subjectId }) !== subjectKey({ resource: row.subjectResource, id: row.subjectId })) {
      issues.push({
        kind: 'conflicting_external_identity',
        subject: { resource: row.subjectResource, id: row.subjectId, owner: row.subjectOwner, ownerPackage: row.subjectOwnerPackage, labelSnapshot: row.subjectLabel, labelIsAuthoritative: false },
        detector: DETECTOR,
        evidence: `external identity ${key} is active against more than one record`,
      });
      continue;
    }
    bySourceKey.set(key, row);
  }

  return issues;
}

/**
 * Orphan detection: an identity or link pointing at a host record that no
 * longer resolves. Deliberately limited to what is *detectable* — this package
 * cannot see inside every optional package's storage, and it does not pretend
 * to.
 *
 * @param {{modules: any, core: any, names: any}} input
 */
export function detectOrphans({ modules, core, names }) {
  const found = [];
  if (!core || typeof core.findContactByEmail !== 'function') return found;
  const identities = trusted(modules, names.identity).list({ limit: 1000 });
  for (const row of identities) {
    if (row.status !== 'active') continue;
    if (row.subjectResource !== 'company' && row.subjectResource !== 'contact') continue;
    const service = modules.get(row.subjectResource === 'company' ? 'company' : 'contact')?.service;
    if (!service || typeof service.get !== 'function') continue;
    let exists = true;
    try { service.get(row.subjectId); } catch { exists = false; }
    if (!exists) {
      found.push({
        kind: 'orphaned_reference',
        subject: { resource: row.subjectResource, id: row.subjectId, owner: 'host', ownerPackage: null, labelSnapshot: row.subjectLabel, labelIsAuthoritative: false },
        detector: DETECTOR,
        evidence: `external identity ${row.sourceKey} points at a ${row.subjectResource} that no longer resolves`,
      });
    }
  }
  return found;
}
