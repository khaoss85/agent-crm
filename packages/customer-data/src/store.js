// @ts-check

import { AppError } from '../../core/index.js';

/**
 * Storage handles and the subject envelope, in one place.
 *
 * Every record this package owns is fully managed: there is no public create
 * or update path to any of them, so a client cannot forge an identity link, a
 * duplicate verdict or an import receipt. `trusted()` refuses a module that is
 * not read-only-managed, which is the same guard Commercial and Signature use.
 */

/** @param {Record<string, string>} [config] */
export function resolvedNames(config = {}) {
  return {
    run: config.importRunModule ?? 'customer-import-run',
    row: config.importRowModule ?? 'customer-import-row',
    identity: config.externalIdentityModule ?? 'external-identity',
    candidate: config.duplicateCandidateModule ?? 'duplicate-candidate',
    link: config.canonicalLinkModule ?? 'canonical-link',
    issue: config.dataQualityIssueModule ?? 'data-quality-issue',
  };
}

/** @param {any} modules @param {string} name */
export function trusted(modules, name) {
  const service = modules.get(name)?.service;
  if (!service || typeof service.createManaged !== 'function') {
    throw new AppError(`Module "${name}" is not a read-only managed record module — regenerate it from the current manifest`, {
      code: 'CUSTOMER_DATA_STORAGE_INVALID', status: 500,
    });
  }
  return service;
}

/**
 * A module this package can read but does not require. The foundation projects
 * across optional packages, so "the package is not composed" is an ordinary
 * answer — reported as **not available**, never as an empty result.
 *
 * @param {any} modules @param {string} name
 */
export function optional(modules, name) {
  try {
    return modules.get(name)?.service ?? null;
  } catch {
    return null;
  }
}

/**
 * The ADR-030 subject envelope: how this package points at a record another
 * package owns without a foreign key, a copy, or knowledge of its internals.
 *
 * @param {{resource: string, id: string, owner?: string, ownerPackage?: string|null, label?: string|null}} subject
 */
export function subjectFields(subject, prefix = 'subject') {
  return {
    [`${prefix}Resource`]: subject.resource,
    [`${prefix}Id`]: subject.id,
    [`${prefix}Owner`]: subject.owner ?? 'host',
    [`${prefix}OwnerPackage`]: subject.ownerPackage ?? null,
    [`${prefix}Label`]: subject.label ?? null,
  };
}

/**
 * Read a subject envelope back off a stored row.
 *
 * The stored label is a **display snapshot taken when the row was written**.
 * It is never refreshed, so it goes stale the moment somebody renames the
 * source record — and this foundation's whole claim is that the source record
 * remains the truth. It is therefore published as `labelSnapshot`, never as
 * `label`, with `labelIsAuthoritative: false` beside it: a consumer that wants
 * the customer's current name reads the source record, which every subject
 * envelope names exactly so that it can. This is the contract `packages/work`
 * already states for the identically-named field it stores.
 */
export function subjectOf(row, prefix = 'subject') {
  if (!row) return null;
  return Object.freeze({
    resource: row[`${prefix}Resource`],
    id: row[`${prefix}Id`],
    owner: row[`${prefix}Owner`],
    ownerPackage: row[`${prefix}OwnerPackage`] ?? null,
    labelSnapshot: row[`${prefix}Label`] ?? null,
    labelIsAuthoritative: false,
  });
}

/** A stable key for one subject, used for cluster membership and dedupe. */
export function subjectKey(subject) {
  return `${subject.resource}:${subject.id}`;
}

/**
 * The deterministic ordering of a candidate pair. Without this the same two
 * records could be recorded as two different candidates depending on which one
 * the import happened to see first.
 *
 * @param {any} a @param {any} b
 */
export function orderedPair(a, b) {
  return subjectKey(a) <= subjectKey(b) ? { left: a, right: b } : { left: b, right: a };
}
