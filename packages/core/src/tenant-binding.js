// @ts-check

import { AppError, ConflictError, NotFoundError, ValidationError } from './errors.js';
import { assertTenantId, bindTenantStorage } from './tenant-storage.js';

/**
 * **The tenant binding configuration contract (ADR-038, amended).**
 *
 * > one running Accordo application instance ↔ one authoritative tenant data
 * > plane ↔ one tenant storage binding
 *
 * This module is the *only* place that turns configuration into a bound tenant,
 * and it is deliberately joyless about it: everything is explicit, nothing is
 * defaulted, and every rejection has a stable code.
 *
 * ### What is never consulted
 *
 * The tenant is **never** inferred from `localhost`, the listening interface,
 * `NODE_ENV`, the first membership row, the first Organization row, the request
 * body, a header, a cookie, a subdomain or a JWT claim the framework did not
 * bind itself. Every one of those is a way for the answer to "whose data is
 * this?" to be supplied by the party asking the question.
 *
 * The strongest of those temptations is *"there is only one organization, so
 * use it"*. It is wrong for a reason worth writing down: it makes provisioning
 * order a security control. An instance that boots before its organization
 * exists, or after a second one is created by a control plane, silently changes
 * which data it serves. So the bound tenant is configuration, and a mismatch is
 * a refusal.
 *
 * ### Why the request must name its tenant
 *
 * A verified identity that carries no organization is **refused**, rather than
 * assumed to mean the bound one. Assuming would mean a token minted for tenant
 * A is accepted by tenant B's instance — the exact cross-instance replay that
 * one-tenant-per-instance is supposed to make impossible. Requiring the
 * identity to state its tenant, and requiring equality with the binding, is
 * what turns "each tenant has its own instance" into a boundary rather than a
 * deployment convention.
 *
 * ### The refusal matrix
 *
 * Every code below is stable, and no message contains a filesystem path, a
 * secret, a token or any configured value that could be sensitive — a startup
 * failure is frequently the first thing pasted into a chat window.
 *
 * | Configuration | Code |
 * |---|---|
 * | production without an identity verifier | `SPINE_VERIFIER_REQUIRED` |
 * | no tenant configuration at all | `SPINE_TENANT_STRATEGY_REQUIRED` |
 * | tenant configuration without a bound tenant id | `SPINE_BOUND_TENANT_REQUIRED` |
 * | a bound tenant id that is not a valid slug | `SPINE_BOUND_TENANT_INVALID` |
 * | no storage root to bind the tenant into | `SPINE_TENANT_STORAGE_ROOT_REQUIRED` |
 * | more than one data-plane binding | `SPINE_MULTIPLE_DATA_PLANE_BINDINGS` |
 * | an explicit CRM database path beside a tenant binding | `SPINE_DATA_PLANE_PATH_NOT_CONFIGURABLE` |
 * | a bound tenant with no Organization, un-provisioned | `SPINE_BOUND_TENANT_UNKNOWN` |
 * | local-development mode with no explicit local tenant | `SPINE_LOCAL_TENANT_REQUIRED` |
 * | local-development mode bound to a remote address | `SPINE_LOCAL_MODE_REMOTE_BIND` |
 * | the two planes resolving to one file | `TENANT_PLANES_COLLIDE` |
 */

/** The binding contract version published in the schema. */
export const TENANT_BINDING_CONTRACT = 1;

/** Portable descriptor used by the async PostgreSQL/SQLite composition path. */
export const TENANT_BINDING_CONTRACT_V2 = 2;

/**
 * Bounded portable tenant binding. Locators and connection details never belong.
 *
 * @param {{
 *   adapter: 'sqlite' | 'postgresql',
 *   tenantBound: boolean,
 *   controlPlaneAdapter: 'sqlite' | 'postgresql',
 *   dataPlaneIsolation: 'dedicated_database' | 'dedicated_file',
 * }} input
 */
export function describePortableTenantBinding(input) {
  return Object.freeze({
    contract: TENANT_BINDING_CONTRACT_V2,
    adapter: input.adapter,
    tenantBound: input.tenantBound === true,
    controlPlaneAdapter: input.controlPlaneAdapter,
    dataPlaneIsolation: input.dataPlaneIsolation,
  });
}

/**
 * Bound-tenant identity check for one-tenant-per-instance. A foreign tenant is
 * not found (404), never forbidden (403). The identifier is not echoed.
 *
 * @param {unknown} identity
 * @param {string} boundTenantId
 */
export function assertIdentityTenant(identity, boundTenantId) {
  if (identity == null) return;
  if (typeof identity !== 'object' || Array.isArray(identity)) {
    throw new NotFoundError('Organization', 'unknown');
  }
  const object = /** @type {Record<string, unknown>} */ (identity);
  const organizationId = object.organizationId ?? object.tenantId;
  if (organizationId == null || organizationId === '') {
    throw new AppError('verified identity did not name a tenant', {
      code: 'SPINE_TENANT_REQUIRED',
      status: 401,
    });
  }
  if (organizationId === boundTenantId) return;
  throw new NotFoundError('Organization', 'unknown');
}

/** Loopback hosts a local-development runtime may bind to. */
const LOOPBACK = Object.freeze(new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']));

/**
 * Resolve the configured tenant binding, or refuse.
 *
 * Pure: it touches no database. Whether the bound tenant *exists* is a control
 * plane question and is answered by {@link assertBoundOrganization} once the
 * control plane is open.
 *
 * @param {{
 *   mode: 'local-development'|'production',
 *   tenant?: unknown,
 *   dataPlanePathConfigured?: boolean,
 * }} options
 */
export function resolveTenantBinding(options) {
  const { mode, tenant } = options;

  // An explicit CRM database path beside a tenant binding is two answers to
  // "where does this tenant's data live". The previous design let the second
  // one win silently, which is how F-2 shipped.
  if (options.dataPlanePathConfigured) {
    throw new AppError(
      'a spine-composed application takes its CRM database from the tenant binding, so an explicit '
      + 'database path may not also be configured: two sources for one data plane is how a tenant '
      + 'ends up served from the wrong file',
      { code: 'SPINE_DATA_PLANE_PATH_NOT_CONFIGURABLE', status: 500, details: { mode } },
    );
  }

  if (tenant === undefined || tenant === null) {
    throw new AppError(
      mode === 'local-development'
        ? 'local-development mode still requires one explicit local tenant. The tenant is never '
          + 'inferred — not from localhost, not from the first organization row — because a tenant '
          + 'that appears by itself in development is a tenant that can appear by itself anywhere'
        : 'production mode requires a tenant strategy: without one there is no authoritative '
          + 'organization for a request, and an ambient tenant fallback is exactly what this '
          + 'milestone refuses to ship',
      {
        code: mode === 'local-development' ? 'SPINE_LOCAL_TENANT_REQUIRED' : 'SPINE_TENANT_STRATEGY_REQUIRED',
        status: 500,
        details: { mode },
      },
    );
  }

  if (typeof tenant !== 'object' || Array.isArray(tenant)) {
    throw new AppError(
      'the tenant binding must be a single configuration object naming exactly one tenant',
      { code: 'SPINE_MULTIPLE_DATA_PLANE_BINDINGS', status: 500, details: { mode } },
    );
  }

  const config = /** @type {Record<string, unknown>} */ (tenant);

  // A list of tenants is the configuration this model exists to refuse. Naming
  // it explicitly beats letting `String(['a','b'])` become a slug-shaped id.
  if (Array.isArray(config.id) || Array.isArray(config.ids) || config.tenants !== undefined) {
    throw new AppError(
      'this application serves exactly one tenant, so exactly one tenant may be bound. Serving two '
      + 'tenants from one process is not supported in this milestone: run one instance per tenant',
      { code: 'SPINE_MULTIPLE_DATA_PLANE_BINDINGS', status: 500, details: { mode } },
    );
  }

  if (config.id === undefined || config.id === null || config.id === '') {
    throw new AppError(
      'the tenant binding must name the tenant this instance serves; there is no default and no '
      + 'first-row fallback',
      { code: 'SPINE_BOUND_TENANT_REQUIRED', status: 500, details: { mode } },
    );
  }

  let boundTenantId;
  try {
    boundTenantId = assertTenantId(config.id);
  } catch (error) {
    // Re-coded so the refusal matrix has one stable code for "not a tenant id",
    // and still without echoing the offending value.
    throw new AppError(
      'the bound tenant id must be lowercase letters, digits and hyphens, starting with a letter, '
      + 'at most 63 characters — it becomes part of a filesystem path, so it is a slug and nothing else',
      { code: 'SPINE_BOUND_TENANT_INVALID', status: 500, details: { mode } },
    );
  }

  if (typeof config.storageRoot !== 'string' || config.storageRoot.trim() === '') {
    throw new AppError(
      'the tenant binding needs a storage root: the directory this deployment keeps tenant databases '
      + 'in. It is configuration, never a value derived from a request',
      { code: 'SPINE_TENANT_STORAGE_ROOT_REQUIRED', status: 500, details: { mode } },
    );
  }

  const storage = bindTenantStorage({
    root: config.storageRoot,
    tenantId: boundTenantId,
    controlPlanePath: typeof config.controlPlanePath === 'string' ? config.controlPlanePath : undefined,
  });

  // Provisioning is explicit in production and implicit only in local mode,
  // whose whole declared contract is "permissive, and loud about it".
  const provision = config.provision ?? null;
  if (provision !== null && (typeof provision !== 'object' || Array.isArray(provision))) {
    throw new ValidationError('tenant provisioning must be an object naming the organization', {
      field: 'tenant.provision',
    });
  }

  return Object.freeze({
    tenantBindingContract: TENANT_BINDING_CONTRACT,
    strategy: storage.strategy,
    boundTenantId,
    storage,
    /** Explicit provisioning intent, or null. Local mode provisions regardless. */
    provision: provision
      ? Object.freeze({ name: typeof (/** @type {any} */ (provision).name) === 'string' ? /** @type {any} */ (provision).name : boundTenantId })
      : null,
  });
}

/**
 * Refuse a local-development runtime that is being exposed beyond loopback.
 *
 * Local mode accepts asserted actors — anyone who can reach the socket can
 * claim to be anyone. That is acceptable on a loopback interface and nowhere
 * else, so the bind address is checked rather than trusted.
 *
 * @param {'local-development'|'production'} mode
 * @param {unknown} host
 */
export function assertBindAddress(mode, host) {
  if (mode !== 'local-development') return;
  // An omitted host means "every interface", which is the worst case, not the
  // safe one — so an unspecified host is refused in local mode rather than
  // treated as loopback.
  const candidate = typeof host === 'string' && host !== '' ? host : '0.0.0.0';
  if (LOOPBACK.has(candidate)) return;
  throw new AppError(
    'local-development mode accepts asserted, unverified identities, so it may only listen on a '
    + 'loopback address. Bind to 127.0.0.1, or run in production mode with an identity verifier',
    { code: 'SPINE_LOCAL_MODE_REMOTE_BIND', status: 500, details: { mode } },
  );
}

/**
 * Resolve the bound tenant to a real Organization, or refuse to boot.
 *
 * @param {{
 *   binding: any,
 *   organizations: any,
 *   mode: 'local-development'|'production',
 *   now: () => Date,
 * }} options
 */
export function assertBoundOrganization({ binding, organizations, mode }) {
  const existing = organizations.bySlug(binding.boundTenantId);
  if (existing) return existing;

  // Local mode may create its own tenant; that is the documented local rule and
  // the row records how it came to exist, so it can never be mistaken later for
  // one an operator configured.
  try {
    if (mode === 'local-development') {
      return organizations.create({
        slug: binding.boundTenantId,
        name: binding.provision?.name ?? binding.boundTenantId,
        provenance: 'local-development-migration',
      });
    }

    if (binding.provision) {
      return organizations.create({
        slug: binding.boundTenantId,
        name: binding.provision.name,
        provenance: 'operator-configured',
      });
    }
  } catch (error) {
    // Two processes provisioning the same fresh control file both observe an
    // empty slug, then one insert wins. The public create() surface still
    // refuses duplicates; startup must converge on the committed row.
    if (error instanceof ConflictError && error.details?.field === 'organization.slug') {
      const raced = organizations.bySlug(binding.boundTenantId);
      if (raced) return raced;
    }
    throw error;
  }

  throw new AppError(
    'the bound tenant has no Organization in the control plane. This instance will not serve a '
    + 'tenant it cannot resolve, and it will not create one implicitly: provision the organization '
    + 'first, or configure explicit provisioning for this deployment',
    { code: 'SPINE_BOUND_TENANT_UNKNOWN', status: 500, details: { mode } },
  );
}
