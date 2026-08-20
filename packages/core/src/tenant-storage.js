// @ts-check

import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AppError, ValidationError } from './errors.js';

/**
 * **The tenant storage boundary (ADR-038, Spine v1).**
 *
 * ### The model, decided by a human and enforced here
 *
 * > one running Accordo application instance ↔ one authoritative tenant data
 * > plane ↔ one tenant storage binding
 *
 * Row-level tenancy — an `organization_id` column on every mutable table — is
 * the model most products end up with, and it is the right long-term answer.
 * It is **explicitly not** this slice: this repository has 76 module manifests
 * and 10 core tables, every one of which would need the column, a backfill of
 * every shipped database, reworked unique constraints and a rescoped read on
 * every correctness path. A half-migrated version of that is strictly worse
 * than none, because it *looks* isolated. It is also not required by the model
 * this product is being deployed under, which provisions one isolated instance
 * and one isolated database per tenant.
 *
 * So isolation here is the isolation the storage engine already gives for free:
 * **one database file per tenant, and one tenant per running instance.** Two
 * tenants cannot cross-read because they are not in the same database — not
 * because a `WHERE` clause was remembered somewhere.
 *
 * **Multiple CRM tenants inside one application are NOT SUPPORTED**, and that
 * is the enforcement, not a limitation to work around: a configuration that
 * would need it is refused at startup rather than accommodated at runtime.
 *
 * ### Why a *binding*, and not a lookup
 *
 * The first version of this module exported `databasePathFor(tenantId)` and
 * nothing called it. A review measured the consequence — two organizations in
 * one application shared one database and read each other's records — and the
 * shape of the API was part of why: a resolver that can name *any* tenant's
 * database has to be used correctly on every single call, forever.
 *
 * {@link bindTenantStorage} closes that by construction. It resolves **one**
 * tenant once and returns an object that carries `dataPlanePath` and
 * `controlPlanePath` and **exposes no way to ask for another tenant's path at
 * all.** There is no argument to get wrong, so there is no call site to audit.
 * A second tenant is not refused by a check that could be forgotten; it is
 * unreachable through the object the application actually holds.
 *
 * ### Two planes, named apart
 *
 * - **Control plane** — Organizations and Memberships. Its own database, shared
 *   across the deployment's tenants. It holds no CRM row and its schema has no
 *   CRM table, so a stray CRM write against it fails rather than succeeds.
 * - **Tenant data plane** — every CRM record, audit row, workflow run and trace
 *   span. One file per tenant, named by the bound tenant and nothing else.
 *
 * Neither plane's migrations are applied to the other, which is what turns
 * "we would never do that" into "that raises `no such table`".
 *
 * ### The honest limitations, published in the schema
 *
 * - A tenant is a file. Cross-tenant *reporting* therefore has no query, and
 *   nothing in this milestone provides one.
 * - Tenant count per deployment is bounded by instances, not rows. This model
 *   does not scale to very large tenant counts in one process — it is not meant
 *   to; each tenant gets an instance.
 * - Backup, restore and point-in-time recovery do not exist here.
 *
 * ### The attack this module exists to stop
 *
 * A tenant id becomes part of a filesystem path, so a tenant id is untrusted
 * input on a path. `../`, an absolute path, a NUL, a drive letter or a symlink
 * escape would each turn "open my tenant's database" into "open any file". The
 * resolver refuses anything that is not a bounded slug, and then *proves* the
 * resolved path is still inside the root before returning it.
 */

/**
 * The boundary contract version.
 *
 * **2** because the shape changed semantically: v1 offered an unbound resolver
 * and promised isolation it did not deliver; v2 offers a binding and enforces
 * it. Under ADR-036 doctrine a required shape and a semantic guarantee both
 * moved, so this is exactly the case a contract version exists for.
 */
export const TENANT_STORAGE_CONTRACT = 2;

/** The strategy this version implements. Named so the schema can publish it. */
export const TENANT_STRATEGY = 'one-tenant-per-instance';

/**
 * A tenant id is a bounded slug and nothing else. Not a path, not a URL, not a
 * name — a slug, because everything else has an escape in it somewhere.
 */
const TENANT_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;

/** What this strategy does and does not promise, published verbatim. */
export const TENANT_LIMITATIONS = Object.freeze([
  'NOT_SHARED_DATABASE_TENANCY — isolation comes from one database file per tenant and one tenant '
  + 'per running instance, not from a row-level organization column. Row-level tenancy is a later '
  + 'slice and this milestone neither implements nor claims it.',
  'ONE_TENANT_PER_INSTANCE — a single application instance serves exactly one tenant. Serving two '
  + 'tenants from one process is not supported and is refused at startup, not handled at runtime.',
  'NO_CROSS_TENANT_QUERY — tenants are separate databases, so there is no cross-tenant report, '
  + 'aggregate or join, and none is provided.',
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
 * This still exists, and is still the thing that knows where a tenant's
 * database lives — but an application never holds it. {@link bindTenantStorage}
 * consumes it and hands back something narrower. Kept exported because it is
 * the provisioning-side view: a control plane that creates tenants legitimately
 * needs to name more than one.
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

/**
 * Bind one instance to exactly one tenant's storage.
 *
 * The returned object is what an application holds for the rest of its life.
 * It **cannot name a second tenant** — `databasePathFor` is deliberately not on
 * it — so "this instance accidentally opened another tenant's database" is not
 * a bug that can be written, rather than a bug that must be tested for.
 *
 * @param {{root: string, tenantId: unknown, controlPlanePath?: string}} options
 */
export function bindTenantStorage({ root, tenantId, controlPlanePath }) {
  const storage = createTenantStorage({ root, controlPlanePath });
  const boundTenantId = assertTenantId(tenantId);
  const dataPlanePath = storage.databasePathFor(boundTenantId);

  // The one thing a binding must never do is put both planes in one file: that
  // would put Memberships inside the data a tenant's own users can reach.
  if (dataPlanePath === storage.controlPlanePath) {
    throw new AppError(
      'the tenant data plane and the control plane resolved to the same database, which would put '
      + 'memberships inside tenant-reachable data',
      { code: 'TENANT_PLANES_COLLIDE', status: 500 },
    );
  }

  return Object.freeze({
    tenantStorageContract: TENANT_STORAGE_CONTRACT,
    strategy: TENANT_STRATEGY,
    boundTenantId,
    root: storage.root,
    dataPlanePath,
    controlPlanePath: storage.controlPlanePath,
    limitations: TENANT_LIMITATIONS,
  });
}
