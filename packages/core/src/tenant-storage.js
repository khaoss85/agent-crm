// @ts-check

import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AppError, ValidationError } from './errors.js';

/**
 * **The tenant storage boundary (ADR-038, Spine v1).**
 *
 * ### Why database-per-tenant, and what it is not
 *
 * Row-level tenancy — an `organization_id` column on every mutable table — is
 * the model most products end up with, and it is the right long-term answer.
 * It is not this slice: this repository has **76 module manifests and 10 core
 * tables**, every one of which would need the column, a backfill of every
 * shipped database, reworked unique constraints and a rescoped read on every
 * correctness path. A half-migrated version of that is strictly worse than
 * none, because it *looks* isolated.
 *
 * So v1 *declares* isolation the storage engine already gives for free: **one
 * database file per tenant**. Two tenants would not cross-read because they
 * would not be in the same database — not because a `WHERE` clause was
 * remembered.
 *
 * **What v1 shipped, stated plainly.** This boundary is defined and covered by
 * its own tests, and **it is not wired into the application.** A review
 * measured the consequence: two organizations composed into one application
 * share one database, and the owner of one reads and writes the other's CRM
 * records and audit rows. The application therefore publishes
 * `TENANT_ISOLATION_NOT_ENFORCED` beside the declared strategy, and nothing
 * here — this comment included — may be read as a delivered isolation
 * guarantee. Which way that gap closes (bind one application to one tenant, or
 * row-level scoping as a Spine v2 slice) is a tenancy-model decision for a
 * human, and this module deliberately does not pre-empt it.
 *
 * **This is explicitly NOT shared-database multi-tenancy and must never be
 * described as such.** Row-level tenancy in PostgreSQL is Spine v2.
 *
 * ### The honest limitations, stated here and published in the schema
 *
 * - A tenant is a file. Cross-tenant *reporting* therefore has no query, and
 *   nothing in this milestone provides one.
 * - Tenant count is bounded by open file handles and connection pooling, not by
 *   rows. This model does not scale to very large tenant counts.
 * - The control plane — the organization and membership tables — lives in its
 *   own database, so it is the one thing every tenant's request touches.
 *
 * ### The attack this module exists to stop
 *
 * A tenant id becomes part of a filesystem path, so a tenant id is untrusted
 * input on a path. `../`, an absolute path, a NUL, a drive letter or a symlink
 * escape would each turn "open my tenant's database" into "open any file". The
 * resolver refuses anything that is not a bounded slug, and then *proves* the
 * resolved path is still inside the root before returning it.
 */

/** The boundary contract version. A semantic change bumps it deliberately. */
export const TENANT_STORAGE_CONTRACT = 1;

/** The strategy this version implements. Named so the schema can publish it. */
export const TENANT_STRATEGY = 'database-per-tenant';

/**
 * A tenant id is a bounded slug and nothing else. Not a path, not a URL, not a
 * name — a slug, because everything else has an escape in it somewhere.
 */
const TENANT_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;

/** What this strategy does and does not promise, published verbatim. */
export const TENANT_LIMITATIONS = Object.freeze([
  'NOT_SHARED_DATABASE_TENANCY — this strategy would take isolation from separate database files, '
  + 'not from a row-level organization column. Row-level tenancy in PostgreSQL is a later slice, and '
  + 'this milestone does not claim it. See TENANT_ISOLATION_NOT_ENFORCED: the strategy is declared '
  + 'and not yet enforced for the CRM data plane.',
  'NO_CROSS_TENANT_QUERY — tenants are separate databases, so there is no cross-tenant report, '
  + 'aggregate or join, and none is provided.',
  'TENANT_COUNT_IS_BOUNDED_BY_FILE_HANDLES — this model does not scale to very large tenant counts; '
  + 'that is a storage question deferred with PostgreSQL.',
  'NO_BACKUP_OR_RESTORE — per-tenant backup, restore and point-in-time recovery do not exist here.',
]);

/**
 * Validate a tenant id destined for a filesystem path.
 *
 * @param {unknown} tenantId
 * @returns {string}
 */
export function assertTenantId(tenantId) {
  if (typeof tenantId !== 'string' || tenantId === '') {
    throw new ValidationError('a tenant id is required — there is no ambient or default tenant', {
      field: 'tenantId',
    });
  }
  if (!TENANT_ID_RE.test(tenantId)) {
    // Deliberately does not echo the input: a rejected path fragment is exactly
    // the string you do not want appearing in a log a human later greps.
    throw new ValidationError(
      'a tenant id must be lowercase letters, digits and hyphens, starting with a letter, at most 63 characters',
      { field: 'tenantId' },
    );
  }
  return tenantId;
}

/**
 * Create the tenant storage boundary.
 *
 * @param {{root: string, controlPlanePath?: string}} options
 */
export function createTenantStorage({ root, controlPlanePath }) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new ValidationError('tenant storage needs a root directory', { field: 'root' });
  }
  const resolvedRoot = resolve(root);

  /**
   * The database path for one tenant, proven to be inside the root.
   *
   * @param {string} tenantId
   */
  function databasePathFor(tenantId) {
    const id = assertTenantId(tenantId);
    const candidate = resolve(join(resolvedRoot, 'tenants', `${id}.sqlite`));

    // Belt and braces. The slug rule already makes traversal impossible, but a
    // containment check costs nothing and survives someone later "just
    // relaxing" the regex.
    const rel = relative(resolvedRoot, candidate);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
      throw new AppError('the resolved tenant database path escaped the storage root', {
        code: 'TENANT_PATH_ESCAPE', status: 500,
      });
    }
    return candidate;
  }

  return Object.freeze({
    tenantStorageContract: TENANT_STORAGE_CONTRACT,
    strategy: TENANT_STRATEGY,
    root: resolvedRoot,
    /** The organization/membership database. One, shared, and never a tenant's. */
    controlPlanePath: controlPlanePath ? resolve(controlPlanePath) : join(resolvedRoot, 'control-plane.sqlite'),
    databasePathFor,
    limitations: TENANT_LIMITATIONS,
  });
}
