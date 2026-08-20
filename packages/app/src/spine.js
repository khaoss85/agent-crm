// @ts-check

import {
  ANONYMOUS_IDENTITY,
  LOCAL_ORGANIZATION_SLUG,
  PERMISSIONS,
  ROLE_BUNDLES,
  TENANT_LIMITATIONS,
  authorizationFingerprint,
  createSpineStore,
  decideAuthorization,
  defineIdentity,
  identityEvidence,
  requireAuthorization,
  resolveRuntimeMode,
} from '../../core/index.js';

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

/** The spine contract version published in the schema. */
export const SPINE_CONTRACT = 1;

/**
 * **The tenant-isolation gap, published rather than implied.**
 *
 * A review measured what this milestone actually delivers, and it is less than
 * the schema was claiming. `createTenantStorage` exists, validates a tenant id
 * as a path fragment and resolves one database file per tenant — and **nothing
 * calls it.** `tenantStrategy` is checked for presence at startup and then
 * never used, so every organization composed into one application shares one
 * database, and the authorizer answers "may this subject do this?" without ever
 * asking "does this row belong to this subject's tenant?".
 *
 * The reproduction, against a production-mode application with a verifier
 * configured and two bootstrapped organizations:
 *
 * - `alice`, owner of A, creates a company. `mallory`, owner of B, requests
 *   `GET /api/companies` and receives **200 with A's record in it**.
 * - `mallory` writes, and the row appears in A's own list.
 * - `mallory` requests `GET /api/audit` and receives rows authored by `alice`.
 * - The **control plane holds**: `mallory` pointed at A's organization is
 *   refused `403 MEMBERSHIP_MISSING`, so memberships are correctly scoped.
 *
 * Publishing `database-per-tenant` as this application's tenancy while that is
 * true would be the exact failure this repository exists to avoid: a limitation
 * that a reader has to discover by attacking the product. So the strategy is
 * published as **declared**, the enforcement is published as **false**, and
 * closing the gap is a tenancy-model decision left to a human — see the PR and
 * `ROADMAP.md`. `tests/spine-tenancy-truth.test.js` holds the published claim
 * and the measured behaviour together, in both directions.
 */
export const TENANT_ISOLATION_NOT_ENFORCED =
  'TENANT_ISOLATION_NOT_ENFORCED — the declared tenant strategy is NOT enforced for the CRM data '
  + 'plane in this milestone. The tenant-storage boundary is defined and exercised by its own tests '
  + 'but is not wired into the application, so every organization composed into one application '
  + 'shares one database and cross-tenant CRM reads and writes, including reads of audit evidence, '
  + 'are currently possible. The control plane — organizations and memberships — IS correctly '
  + 'scoped: an identity holding no membership in an organization is refused. Do not read the '
  + 'declared strategy as a delivered isolation guarantee.';

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
 * @param {{
 *   database: any,
 *   audit?: any,
 *   now?: () => string,
 *   config?: {
 *     mode?: string,
 *     identityVerifier?: unknown,
 *     tenantStrategy?: unknown,
 *     organizationId?: string|null,
 *   },
 * }} deps
 */
export function createSpine({ database, audit, now, config = {} }) {
  const mode = resolveRuntimeMode({
    mode: config.mode,
    identityVerifier: config.identityVerifier,
    tenantStrategy: config.tenantStrategy,
  });

  const store = createSpineStore({ database, audit, now });

  /**
   * In local-development mode the project gets exactly one organization, marked
   * with its provenance so it can never later be mistaken for one an operator
   * configured. Created on demand rather than by migration, so an existing
   * database is not rewritten just by being opened.
   */
  function localOrganization() {
    if (!mode.allowsAssertedActors) return null;
    return store.organizations.bySlug(LOCAL_ORGANIZATION_SLUG)
      ?? store.organizations.create({
        slug: LOCAL_ORGANIZATION_SLUG,
        name: 'Local development',
        provenance: 'local-development-migration',
      });
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
    const membership = (identity?.subject && org)
      ? store.memberships.find({ organizationId: org, subject: identity.subject })
      : null;
    return decideAuthorization({ identity, organizationId: org, permission, membership, mode });
  }

  /**
   * Decide, and throw 401/403 when refused.
   *
   * @param {{identity: any, organizationId?: string|null, permission: string}} question
   */
  function authorize({ identity, organizationId, permission }) {
    const org = organizationId ?? identity?.organizationId ?? null;
    const membership = (identity?.subject && org)
      ? store.memberships.find({ organizationId: org, subject: identity.subject })
      : null;
    return requireAuthorization({ identity, organizationId: org, permission, membership, mode });
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
        mode: mode.mode,
        allowsAssertedActors: mode.allowsAssertedActors,
        warning: mode.warning,
        // The strategy an operator DECLARED, named as declared. The old key was
        // `tenantStrategy`, which read as a delivered property of the running
        // application; it was renamed rather than kept-and-qualified, because a
        // consumer reading one key must not be able to reach the wrong answer.
        tenantStrategyDeclared: config.tenantStrategy
          ? /** @type {any} */ (config.tenantStrategy).strategy ?? 'configured'
          : null,
        /**
         * What is actually enforced, separated from what was declared.
         *
         * `crmDataPlaneEnforced` is a literal `false` on purpose: no code path
         * in this milestone opens a per-tenant database or scopes a CRM read by
         * organization, so there is no runtime condition that could make it
         * true. A sniff of the configured object would be worse than useless —
         * checking a strategy for presence and then not using it is precisely
         * the defect being published here.
         */
        tenantIsolation: {
          declaredStrategy: config.tenantStrategy
            ? /** @type {any} */ (config.tenantStrategy).strategy ?? 'configured'
            : null,
          controlPlaneScoped: true,
          crmDataPlaneEnforced: false,
          storageBoundaryWired: false,
          crossTenantCrmReadPossible: true,
          crossTenantCrmWritePossible: true,
          crossTenantAuditReadPossible: true,
        },
        permissions: [...PERMISSIONS],
        roles: Object.fromEntries(Object.entries(ROLE_BUNDLES).map(([role, keys]) => [role, [...keys]])),
        defaultActionPermission: DEFAULT_ACTION_PERMISSION,
        authorizationFingerprint: authorizationFingerprint(),
        organizationIsNotACompany:
          'An Accordo Organization is a tenant of this software. A CRM Company is a customer '
          + 'recorded inside one tenant\'s data. They are never the same thing and never render as '
          + 'one another.',
        // The unenforced-isolation gap leads, because it is the one a reader
        // most needs before they trust anything else in this block.
        limitations: [TENANT_ISOLATION_NOT_ENFORCED, ...TENANT_LIMITATIONS],
        notModeled: [
          'PostgreSQL or shared-database row-level tenancy (Spine v2)',
          'durable jobs, outbox or scheduler (Spine v3)',
          'secret manager, backups, restore, deploy or rollback (Spine v4)',
          'password, session or credential storage — the framework authenticates nobody',
          'email invitations',
          'SOC2, GDPR or any compliance posture',
        ],
      };
    },
  });
}
