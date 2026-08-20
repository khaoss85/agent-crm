// @ts-check

import { AppError, ForbiddenError, ValidationError } from './errors.js';
import { computeDefinitionFingerprint } from './definition-fingerprint.js';

/**
 * **Server-authoritative authorization (ADR-038).**
 *
 * Two shapes were compared and the reasoning belongs next to the code.
 *
 * A **fixed role enum** (`admin | manager | member`) is simple and immediately
 * inflexible: the first customer who wants "may reconcile signatures but may not
 * approve discounts" has to fork the enum, and every role check in the codebase
 * becomes a string comparison nobody can audit.
 *
 * **One permission per method** is the opposite failure. It looks rigorous and
 * produces hundreds of keys that no human can reason about, so in practice
 * everybody is granted all of them and the model means nothing.
 *
 * v1 takes the middle: **bounded semantic permissions, bundled into roles.**
 * There are eleven permissions because there are eleven genuinely different
 * things a person can be trusted with here — not because there are eleven
 * methods.
 *
 * ### Fail closed, everywhere
 *
 * Every path that cannot prove an allow **denies**. An unknown permission is a
 * denial, not a pass. An unknown role is a denial. A missing membership is a
 * denial. An identity of the wrong kind is a denial. The only way to reach an
 * allow is to hold a membership, in the organization being addressed, carrying a
 * role whose bundle contains the exact permission — and to be the kind of
 * identity that may hold a role at all.
 */

/**
 * The closed permission vocabulary.
 *
 * Each is a *semantic* capability a person is trusted with, deliberately coarser
 * than the method surface it protects.
 */
export const PERMISSIONS = Object.freeze([
  'records.read',
  'records.write',
  'approvals.decide',
  'commercial.approve',
  'signature.send',
  'signature.reconcile',
  'contracts.activate',
  'delivery.manage',
  'service.manage',
  'customer_identity.decide',
  'admin.memberships.manage',
]);

/**
 * Role bundles.
 *
 * `owner` is not "every permission plus future ones" — it is an explicit list,
 * so that adding a permission later does not silently widen an existing role.
 * A new capability must be granted on purpose.
 */
export const ROLE_BUNDLES = Object.freeze({
  owner: Object.freeze([
    'records.read', 'records.write', 'approvals.decide', 'commercial.approve',
    'signature.send', 'signature.reconcile', 'contracts.activate', 'delivery.manage',
    'service.manage', 'customer_identity.decide', 'admin.memberships.manage',
  ]),
  administrator: Object.freeze([
    'records.read', 'records.write', 'approvals.decide', 'commercial.approve',
    'signature.send', 'signature.reconcile', 'contracts.activate', 'delivery.manage',
    'service.manage', 'customer_identity.decide', 'admin.memberships.manage',
  ]),
  manager: Object.freeze([
    'records.read', 'records.write', 'approvals.decide', 'commercial.approve',
    'signature.send', 'contracts.activate', 'delivery.manage', 'service.manage',
    'customer_identity.decide',
  ]),
  member: Object.freeze(['records.read', 'records.write']),
  viewer: Object.freeze(['records.read']),
});

export const ROLES = Object.freeze(Object.keys(ROLE_BUNDLES));

/** Only a human may hold an organization role. */
export const ROLE_BEARING_KINDS = Object.freeze(['verified-user', 'asserted-local']);

/**
 * System identities get **bounded** authority, never a role.
 *
 * A signature webhook must be able to reconcile what a provider told it. It must
 * never be able to approve a discount, decide an approval or change a
 * membership — and the way to guarantee that is to enumerate what a system may
 * do rather than to give it a powerful role and hope.
 */
export const SYSTEM_PERMISSIONS = Object.freeze(['records.read', 'signature.reconcile']);

/** A stable fingerprint of the model, so a changed bundle is a changed digest. */
export function authorizationFingerprint() {
  return computeDefinitionFingerprint({
    kind: 'authorization-model',
    name: 'spine-permissions',
    version: 1,
    config: { permissions: [...PERMISSIONS], roles: ROLE_BUNDLES, system: [...SYSTEM_PERMISSIONS] },
  });
}

/** @param {unknown} permission */
export function assertPermissionKey(permission) {
  if (typeof permission !== 'string' || !PERMISSIONS.includes(permission)) {
    // An unknown permission is a *programming* error, and it fails closed: the
    // caller does not get a pass for asking for something that does not exist.
    throw new ValidationError(
      `unknown permission "${String(permission)}" — permissions are a closed set: ${PERMISSIONS.join(', ')}`,
      { field: 'permission' },
    );
  }
  return permission;
}

/**
 * The authorization decision.
 *
 * Always an object, always explaining itself, and never a bare boolean: the
 * reason is what audit and trace record, and what the Admin renders when a
 * person is refused.
 *
 * @typedef {{
 *   allowed: boolean,
 *   permission: string,
 *   organizationId: string|null,
 *   subject: string|null,
 *   kind: string,
 *   role: string|null,
 *   reason: string,
 *   code: string|null,
 * }} AuthorizationDecision
 */

/**
 * Decide one authorization question.
 *
 * @param {{
 *   identity: any,
 *   organizationId?: string|null,
 *   permission: string,
 *   membership?: {role?: string, organizationId?: string, status?: string}|null,
 *   mode: {mode: string, allowsAssertedActors: boolean},
 * }} question
 * @returns {AuthorizationDecision}
 */
export function decideAuthorization({ identity, organizationId, permission, membership, mode }) {
  assertPermissionKey(permission);
  const base = {
    permission,
    organizationId: organizationId ?? null,
    subject: identity?.subject ?? null,
    kind: identity?.kind ?? 'anonymous',
    role: null,
  };
  const deny = (code, reason) => Object.freeze({ ...base, allowed: false, code, reason });

  if (!identity || typeof identity !== 'object') {
    return deny('IDENTITY_MISSING', 'no identity context reached the authorizer');
  }
  if (identity.kind === 'anonymous') {
    return deny('IDENTITY_ANONYMOUS', 'the request carried no verified identity');
  }

  // An asserted developer identity is acceptable only where the operator said
  // assertions are acceptable. This is the single line that keeps local mode
  // from being a production bypass.
  if (identity.kind === 'asserted-local' && !mode?.allowsAssertedActors) {
    return deny(
      'ASSERTED_IDENTITY_REFUSED',
      'an asserted developer identity is never accepted outside local-development mode',
    );
  }

  if (identity.kind === 'system') {
    if (!SYSTEM_PERMISSIONS.includes(permission)) {
      return deny(
        'SYSTEM_AUTHORITY_EXCEEDED',
        `a system identity may only ${SYSTEM_PERMISSIONS.join(' and ')}; it may never "${permission}"`,
      );
    }
    return Object.freeze({
      ...base, allowed: true, code: null,
      reason: `system identity within its bounded authority (${permission})`,
    });
  }

  if (!ROLE_BEARING_KINDS.includes(identity.kind)) {
    return deny('IDENTITY_KIND_CANNOT_HOLD_ROLE', `identity kind "${identity.kind}" cannot hold an organization role`);
  }

  if (!organizationId) {
    // No ambient tenant. Ever.
    return deny('ORGANIZATION_REQUIRED', 'no authoritative organization context reached the authorizer');
  }

  // The verified identity's own organization is authoritative. A caller who
  // supplies a different one is attempting exactly the override C9 forbids.
  if (identity.organizationId && identity.organizationId !== organizationId) {
    return deny(
      'ORGANIZATION_MISMATCH',
      'the requested organization is not the one this identity was verified for',
    );
  }

  if (!membership) {
    return deny('MEMBERSHIP_MISSING', 'this identity holds no membership in that organization');
  }
  if (membership.status && membership.status !== 'active') {
    return deny('MEMBERSHIP_INACTIVE', `the membership is ${membership.status}, not active`);
  }
  if (membership.organizationId && membership.organizationId !== organizationId) {
    return deny('MEMBERSHIP_ORGANIZATION_MISMATCH', 'the membership belongs to a different organization');
  }

  const role = typeof membership.role === 'string' ? membership.role : null;
  const bundle = role && Object.prototype.hasOwnProperty.call(ROLE_BUNDLES, role)
    ? ROLE_BUNDLES[/** @type {keyof typeof ROLE_BUNDLES} */ (role)]
    : null;
  if (!bundle) {
    return deny('ROLE_UNKNOWN', `"${String(role)}" is not a role this framework grants`);
  }
  if (!bundle.includes(permission)) {
    return Object.freeze({
      ...base, allowed: false, role, code: 'PERMISSION_NOT_IN_ROLE',
      reason: `the role "${role}" does not carry "${permission}"`,
    });
  }

  return Object.freeze({
    ...base, allowed: true, role, code: null,
    reason: `the role "${role}" carries "${permission}"`,
  });
}

/**
 * Decide, and throw when refused.
 *
 * 401 when nothing was verified, 403 when somebody verified is not permitted —
 * the distinction the SDK preserves and the Admin renders differently.
 *
 * @param {Parameters<typeof decideAuthorization>[0]} question
 */
export function requireAuthorization(question) {
  const decision = decideAuthorization(question);
  if (decision.allowed) return decision;

  const unauthenticated = decision.code === 'IDENTITY_MISSING'
    || decision.code === 'IDENTITY_ANONYMOUS'
    || decision.code === 'ASSERTED_IDENTITY_REFUSED';

  if (unauthenticated) {
    throw new AppError(decision.reason, {
      code: 'UNAUTHENTICATED',
      status: 401,
      details: Object.freeze({ permission: decision.permission, reason: decision.code }),
    });
  }
  throw new ForbiddenError(decision.reason, Object.freeze({
    permission: decision.permission,
    reason: decision.code,
    role: decision.role,
  }));
}
