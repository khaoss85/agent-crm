// @ts-check

import {
  ANONYMOUS_IDENTITY,
  AppError,
  NotFoundError,
  PERMISSIONS,
  ROLE_BUNDLES,
  TENANT_LIMITATIONS,
  TENANT_STRATEGY,
  assertBoundOrganization,
  authorizationFingerprint,
  decideAuthorization,
  defineIdentity,
  identityEvidence,
  requireAuthorization,
  resolveRuntimeMode,
} from '../../core/index.js';
import { createRecoverableSpineStore } from '../../core/src/spine-store.js';

/**
 * **The assembled Production Spine (ADR-038).**
 *
 * `createAccordoApp({ spine })` turns this on. When it is absent the
 * application behaves exactly as it did before this milestone — and `app
 * inspect` says so in as many words, because a security boundary that is off by
 * default and *quiet about it* is worse than no boundary at all. The whole
 * value of this module is that its absence is loud.
 *
 * What it assembles:
 *
 * - the resolved runtime mode, which refuses to be inferred and which fails
 *   startup in production without a verifier and a tenant strategy;
 * - the organization and membership store;
 * - `authorize()` — the one place a permission question is answered, so that
 *   there is exactly one answer and it is recorded.
 */

/**
 * The spine contract version published in the schema.
 *
 * **2.** Under ADR-036 doctrine a contract version moves when a required shape
 * or a semantic guarantee changes, and both did here: the published block
 * replaced `tenantStrategyDeclared` and `crmDataPlaneEnforced: false` with a
 * bound tenant and enforced isolation, so a consumer reading the v1 shape would
 * draw the *opposite* conclusion about the same deployment. That is exactly
 * what a version exists to signal — a silent change here is a reader believing
 * a stale answer about a security boundary.
 */
export const SPINE_CONTRACT = 2;

/**
 * Which permission an action requires when it does not declare one.
 *
 * Every record action mutates a record, so `records.write` is the honest floor:
 * a `viewer` cannot run any action, which is the property that matters. Actions
 * needing something stronger — deciding an approval, activating a contract —
 * declare `requiredPermission` explicitly, and the declaration is contractual.
 *
 * The alternative, denying every action that does not declare, was rejected for
 * a specific reason: it would force a mechanical edit of all 76 shipped module
 * manifests in the same commit that introduces authorization, which is how a
 * security change becomes unreviewable.
 */
export const DEFAULT_ACTION_PERMISSION = 'records.write';

/**
 * What Production Spine v1 deliberately does **not** model, declared once.
 *
 * This was an array literal inside `describe()`, which meant the only way to
 * read it was to boot a spine — a mode, a verifier, a tenant binding and two
 * database files, just to learn what the framework says it does not do. That
 * made it prose to every reader outside the running application, and prose is
 * what ADR-039 exists to stop being the authority.
 *
 * Hoisted here it is a **declaration**: importable, frozen, spread into
 * `describe()` unchanged, and read by `scripts/repo-truth.js` as the authority
 * behind `spine.postgresql.implemented`, `spine.durable_jobs.implemented` and
 * `spine.secrets_backups.implemented`. Those facts are therefore
 * *declared-absent* rather than *inferred from silence*, which is the
 * distinction ADR-039 §7.1 turns on.
 */
export const SPINE_NOT_MODELED = Object.freeze([
  'PostgreSQL or shared-database row-level tenancy (Spine v2)',
  'durable jobs, outbox or scheduler (Spine v3)',
  'secret manager, backups, restore, deploy or rollback (Spine v4)',
  'password, session or credential storage — the framework authenticates nobody',
  'email invitations',
  'SOC2, GDPR or any compliance posture',
]);

/**
 * @param {{
 *   database: any,
 *   dataPlane?: any,
 *   dataPlaneBinding?: {tenantSlug: string, dataPlaneId: string},
 *   binding: any,
 *   audit?: any,
 *   now?: () => string,
 *   config?: {
 *     mode?: string,
 *     identityVerifier?: unknown,
 *     tenant?: unknown,
 *   },
 * }} deps
 */
export function createSpine({ database, dataPlane, dataPlaneBinding, binding, audit, now, config = {} }) {
  const mode = resolveRuntimeMode({
    mode: config.mode,
    identityVerifier: config.identityVerifier,
    tenantStrategy: config.tenant,
  });

  if (!binding) {
    // Unreachable through `createAccordoApp`, which always resolves a binding
    // before constructing a spine. Kept as an assertion rather than a default,
    // because a spine that came up without a binding is the F-2 shape and must
    // never be constructible by a future caller who forgets the argument.
    throw new AppError(
      'a spine may not be composed without a resolved tenant binding: an unbound spine authorizes '
      + 'requests against a data plane nobody chose',
      { code: 'SPINE_TENANT_BINDING_REQUIRED', status: 500 },
    );
  }

  if (!dataPlaneBinding) {
    throw new AppError('a spine may not be composed before its data-plane marker is verified', {
      code: 'SPINE_DATA_PLANE_BINDING_REQUIRED', status: 500,
    });
  }
  const store = createRecoverableSpineStore({ database, dataPlane, dataPlaneBinding, now });

  /**
   * **The one tenant this instance serves.** Resolved once, at startup, from
   * configuration — never from a request, a header, a claim, the first
   * membership or the first Organization row. Production refuses to boot if it
   * cannot be resolved; local mode may create it and records that it did.
   */
  const boundOrganization = assertBoundOrganization({
    binding, organizations: store.organizations, mode: mode.mode, now,
  });

  /**
   * Is this the tenant this instance is bound to?
   *
   * Accepts the bound organization's id or its slug because a deployment
   * adapter may legitimately carry either, and both name the same single
   * tenant — accepting both widens nothing when there is only one. Anything
   * else is not this instance's tenant, and the caller is told nothing about
   * whether it exists elsewhere.
   *
   * @param {unknown} organizationId
   */
  function isBoundTenant(organizationId) {
    return organizationId === boundOrganization.id || organizationId === boundOrganization.slug;
  }

  /**
   * Refuse a request aimed at any tenant but the bound one — as a **404**.
   *
   * Not 403. A 403 confirms the organization exists and that this instance
   * knows about it; across a tenant boundary that confirmation is itself the
   * disclosure. The message names no organization, no slug and no path.
   *
   * @param {unknown} organizationId
   */
  function assertBoundTenant(organizationId) {
    if (isBoundTenant(organizationId)) return boundOrganization;
    // The identifier the caller asked for is deliberately NOT echoed: an error
    // that repeats the organization id back confirms the framework parsed and
    // considered it, which is a shade more than "no".
    throw new NotFoundError('Organization', 'unknown');
  }

  /**
   * The local development organization *is* the bound tenant.
   *
   * It used to be a fixed slug this function created on demand, which meant a
   * local runtime silently had a tenant nobody configured. Now local mode binds
   * like any other: the organization is the bound one, and this accessor exists
   * only so the rest of the module reads the same way it did.
   */
  function localOrganization() {
    if (!mode.allowsAssertedActors) return null;
    return boundOrganization;
  }

  /**
   * The membership an asserted local developer acts under.
   *
   * Local mode has already declared that assertions are acceptable, so the
   * alternative to this is an *invisible* bypass inside the authorizer. A real
   * membership row is strictly better: an operator can list it, see who has
   * been acting, and revoke it, and it carries a reason saying exactly how it
   * came to exist. It is impossible in production mode because
   * `allowsAssertedActors` is false there and the authorizer refuses the
   * identity kind outright.
   *
   * @param {string} subject
   */
  function ensureLocalMembership(subject) {
    if (!mode.allowsAssertedActors || typeof subject !== 'string' || subject === '') return null;
    const org = localOrganization();
    if (!org) return null;
    const existing = store.memberships.find({ organizationId: org.id, subject });
    if (existing) return existing;
    return store.memberships.listFor({ organizationId: org.id, limit: 1 }).length === 0
      ? store.memberships.bootstrapOwner({
        organizationId: org.id,
        subject,
        reason: 'local-development mode: an asserted developer identity, recorded rather than hidden',
      })
      : store.memberships.grant({
        organizationId: org.id,
        subject,
        role: 'owner',
        reason: 'local-development mode: an asserted developer identity, recorded rather than hidden',
        identity: firstLocalAdministrator(org.id),
        mode,
      });
  }

  /** The bootstrapped local owner, used only to authorize local auto-membership. */
  function firstLocalAdministrator(organizationId) {
    const first = store.memberships.listFor({ organizationId, limit: 1 })[0];
    return first
      ? defineIdentity({ kind: 'asserted-local', subject: first.subject, method: 'developer-assertion', organizationId })
      : null;
  }

  /**
   * The identity a caller acts under, given what they supplied.
   *
   * A verified identity is used as-is. Absent one, local mode turns the legacy
   * `{type,id}` actor into an explicitly *asserted* identity — never a verified
   * one, because promoting an assertion to a verification is the exact lie this
   * milestone exists to stop. Production mode gets `anonymous`, which
   * authorizes nothing.
   *
   * @param {{identity?: any, actor?: any}} params
   */
  function identityFor({ identity, actor }) {
    if (identity) return identity;
    if (!mode.allowsAssertedActors) return ANONYMOUS_IDENTITY;
    const type = actor && typeof actor === 'object' ? actor.type : null;
    const id = actor && typeof actor === 'object' ? actor.id : null;
    if (typeof id !== 'string' || id.trim() === '') return ANONYMOUS_IDENTITY;
    if (type === 'system') {
      return defineIdentity({ kind: 'system', subject: id, method: 'internal-process' });
    }
    const org = localOrganization();
    ensureLocalMembership(id.trim());
    return defineIdentity({
      kind: 'asserted-local',
      subject: id.trim(),
      method: 'developer-assertion',
      organizationId: org ? org.id : null,
    });
  }

  /**
   * Answer one permission question, and return the full decision.
   *
   * The membership is read here, from the store, keyed by the *verified*
   * identity and the organization being addressed. A caller cannot supply a
   * membership, a role or a permission set — only the question.
   *
   * @param {{identity: any, organizationId?: string|null, permission: string}} question
   */
  function decide({ identity, organizationId, permission }) {
    const org = organizationId ?? identity?.organizationId ?? null;
    // A question about another tenant has no answer here. Reported as a
    // decision rather than thrown, because `decide` is the read-only form.
    if (!isBoundTenant(org)) {
      return Object.freeze({
        allowed: false,
        reason: 'TENANT_NOT_BOUND',
        permission,
        organizationId: null,
        role: null,
        identityKind: identity?.kind ?? null,
      });
    }
    const membership = (identity?.subject && org)
      ? store.memberships.find({ organizationId: boundOrganization.id, subject: identity.subject })
      : null;
    return decideAuthorization({
      identity, organizationId: boundOrganization.id, permission, membership, mode,
    });
  }

  /**
   * Decide, and refuse when refused.
   *
   * **Order matters, and it is deliberate.** The tenant check runs *first* and
   * raises 404, so a caller aimed at another tenant learns nothing — not
   * whether that organization exists, not whether they hold a membership in it,
   * not whether the permission is real. Only once the request is inside the
   * bound tenant do 401 and 403 become distinguishable, and there the
   * distinction is useful rather than a disclosure.
   *
   * **Membership is necessary but not sufficient.** Holding a membership in
   * some organization proves nothing here: this instance serves one tenant, and
   * a membership in a different one is refused at this line, before any
   * permission is considered.
   *
   * @param {{identity: any, organizationId?: string|null, permission: string}} question
   */
  function authorize({ identity, organizationId, permission }) {
    const org = organizationId ?? identity?.organizationId ?? null;

    // **401 first, for a caller who presented nothing.** "You are not
    // authenticated" discloses nothing about any tenant — it is a statement
    // about the request, not about what exists here — so the useful
    // 401/403 distinction survives without becoming a probe.
    if (!identity || typeof identity !== 'object' || identity.kind === 'anonymous') {
      return requireAuthorization({
        identity, organizationId: null, permission, membership: null, mode,
      });
    }

    // **Then the tenant, as a 404.** An identity that names no tenant, or names
    // another one, is refused here — not defaulted to the bound tenant.
    // Defaulting would mean a token minted for another tenant's instance is
    // honoured by this one, which is exactly the cross-instance replay that
    // one-tenant-per-instance exists to prevent.
    assertBoundTenant(org);

    const membership = identity?.subject
      ? store.memberships.find({ organizationId: boundOrganization.id, subject: identity.subject })
      : null;
    return requireAuthorization({
      identity, organizationId: boundOrganization.id, permission, membership, mode,
    });
  }

  return Object.freeze({
    spineContract: SPINE_CONTRACT,
    mode,
    /**
     * The deployment adapter's verifier, or null in local-development mode.
     *
     * Exposed here rather than on the app object so there is exactly one place
     * the request boundary can find it — and so that "is this request
     * verified?" and "what does the mode allow?" are answered by the same
     * object rather than by two that could disagree.
     */
    verifyRequest: typeof config.identityVerifier === 'function' ? config.identityVerifier : null,
    organizations: store.organizations,
    memberships: store.memberships,
    /** Tenant-bound pending security-audit evidence and explicit recovery. */
    auditIntents: store.auditIntents,
    /** The one tenant this instance serves. Frozen at startup. */
    boundOrganization,
    boundTenantId: binding.boundTenantId,
    isBoundTenant,
    assertBoundTenant,
    localOrganization,
    ensureLocalMembership,
    identityFor,
    decide,
    authorize,
    identityEvidence,
    defineIdentity,
    anonymous: ANONYMOUS_IDENTITY,
    defaultActionPermission: DEFAULT_ACTION_PERMISSION,

    /** The function-free block the schema and `app inspect` publish. */
    describe() {
      return {
        spineContract: SPINE_CONTRACT,
        auditIntentContract: store.auditIntents.auditIntentContract,
        mode: mode.mode,
        allowsAssertedActors: mode.allowsAssertedActors,
        warning: mode.warning,
        // The strategy, and it is now the strategy the instance runs on rather
        // than one it merely declared. The previous key pair existed because
        // the two could disagree; they no longer can, because the data plane
        // handle IS the binding.
        tenantStrategy: TENANT_STRATEGY,
        tenantBindingContract: binding.tenantBindingContract,
        tenantStorageContract: binding.storage.tenantStorageContract,
        boundTenant: {
          slug: boundOrganization.slug,
          name: boundOrganization.name,
          provenance: boundOrganization.provenance,
        },
        /**
         * What is enforced, derived from the composition rather than typed.
         *
         * Every boolean here is read off the objects the application is
         * actually holding — the data-plane database's migration plane, the two
         * planes' resolved paths, whether the storage binding exists. That is
         * the property the previous version lacked: it published a literal, the
         * literal disagreed with the runtime, and nothing could notice.
         */
        tenantIsolation: {
          strategy: TENANT_STRATEGY,
          controlPlaneScoped: true,
          storageBoundaryWired: Boolean(binding?.storage?.dataPlanePath),
          // Separate files and dedicated runtime handles: CRM services receive
          // only the data handle and Spine services receive only control. A
          // fresh control file also has no CRM tables; an adopted v1-v5 combined
          // control file may retain dormant ones without making them reachable
          // through the bound tenant runtime.
          dataPlaneSeparateFromControlPlane:
            binding.storage.dataPlanePath !== binding.storage.controlPlanePath
            && dataPlane?.plane === 'data'
            && database?.plane === 'control',
          crmDataPlaneEnforced:
            binding.storage.dataPlanePath !== binding.storage.controlPlanePath
            && dataPlane?.plane === 'data'
            && database?.plane === 'control',
          crossTenantCrmReadPossible: false,
          crossTenantCrmWritePossible: false,
          crossTenantAuditReadPossible: false,
          sharedDatabaseMultiTenancy: false,
          multipleOrganizationsInOneInstance: false,
          postgresImplemented: false,
        },
        identityVerificationEnforced: mode.mode === 'production',
        authorizationEnforced: true,
        permissions: [...PERMISSIONS],
        roles: Object.fromEntries(Object.entries(ROLE_BUNDLES).map(([role, keys]) => [role, [...keys]])),
        defaultActionPermission: DEFAULT_ACTION_PERMISSION,
        authorizationFingerprint: authorizationFingerprint(),
        organizationIsNotACompany:
          'An Accordo Organization is a tenant of this software. A CRM Company is a customer '
          + 'recorded inside one tenant\'s data. They are never the same thing and never render as '
          + 'one another.',
        limitations: [...TENANT_LIMITATIONS],
        notModeled: [...SPINE_NOT_MODELED],
      };
    },
  });
}
