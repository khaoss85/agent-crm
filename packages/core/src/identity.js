// @ts-check

import { createHash } from 'node:crypto';
import { ValidationError } from './errors.js';

/**
 * **The verified identity contract (ADR-038, Production Spine v1).**
 *
 * Before this module the framework had one identity primitive, `normalizeActor`,
 * and it failed **open**: `null`, a string, or an unknown `type` all produced
 * `SYSTEM_ACTOR` — the most privileged identity there is. The safest input
 * produced the strongest identity, and the HTTP layer manufactured
 * `{type:'user', id:'api-user'}` out of two forgeable headers. Every "a human
 * decided" in this repository rested on that.
 *
 * This module does not authenticate anybody. That is deliberate: authenticating
 * means holding credentials, and a framework that invents a credential store is
 * a framework with a new class of vulnerability. The **deployment adapter**
 * verifies the request; this module states, in a bounded and versioned shape,
 * *what a verified identity is allowed to look like* — and refuses everything
 * else.
 *
 * ### The four kinds, which must never blur
 *
 * - `verified-user`  an adapter verified a human. The only kind that may hold
 *                    an organization role.
 * - `system`         a provider, webhook or internal operation, with **bounded
 *                    authority**: a webhook may reconcile, it may never approve
 *                    a discount.
 * - `asserted-local` a developer said who they are. Accepted **only** in
 *                    explicit local-development mode, never in production.
 * - `anonymous`      nothing was verified. Authorizes nothing, ever.
 *
 * ### What never enters this contract
 *
 * No token, password, cookie, bearer, assertion blob, private key or any other
 * credential — not in the object, not in audit, not in trace, not in an error
 * message. The contract carries a **fingerprint** of the claims the adapter
 * accepted, so two identities can be compared and an audit row can be tied to
 * the evidence, without the evidence itself ever being stored.
 */

/** The contract version. A shape or guarantee change bumps this deliberately. */
export const IDENTITY_CONTRACT = 1;

/**
 * The control-character policy, identical code point for code point to the one
 * `packages/signature/src/operations.js` applies to signer input and
 * `packages/customer-data/src/normalize.js` applies to imported PII.
 *
 * It is re-declared here rather than imported because `packages/core` is the
 * lowest layer and may not import from a package. `tests/spine-identity.test.js`
 * compares all three literals, so a widened copy fails rather than drifts.
 */
export const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Identity kinds, closed. */
export const IDENTITY_KINDS = Object.freeze(['verified-user', 'system', 'asserted-local', 'anonymous']);

/**
 * Evidence classes — *what kind of proof* the adapter had, never the proof.
 * Closed, because an open vocabulary here is an invitation to smuggle a
 * credential through as a "method".
 */
export const IDENTITY_METHODS = Object.freeze([
  'oidc-id-token',
  'oauth2-access-token',
  'session-cookie',
  'mtls-client-certificate',
  'signed-webhook',
  'internal-process',
  'developer-assertion',
]);

/** Hard bounds. An identity is a small, bounded thing or it is refused. */
export const MAX_IDENTITY_FIELD = 200;
export const MAX_ORGANIZATION_ID = 64;

/**
 * Validate one bounded identity string.
 *
 * @param {unknown} value @param {string} field
 * @param {{required?: boolean, max?: number}} [options]
 * @returns {string|null}
 */
export function identityString(value, field, options = {}) {
  const { required = false, max = MAX_IDENTITY_FIELD } = options;
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`${field} is required`, { field });
    return null;
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`, { field });
  const trimmed = value.trim();
  if (trimmed === '') {
    if (required) throw new ValidationError(`${field} is required`, { field });
    return null;
  }
  if (trimmed.length > max) {
    throw new ValidationError(`${field} must be at most ${max} characters`, { field });
  }
  if (CONTROL_RE.test(trimmed)) {
    throw new ValidationError(`${field} must not contain control characters`, { field });
  }
  return trimmed;
}

/**
 * The digest of the claims an adapter accepted.
 *
 * The claims themselves are **never** stored. This is what lets an audit row say
 * "this decision rested on exactly these claims" without the audit log becoming
 * a place credentials live.
 *
 * @param {unknown} claims
 * @returns {string} 64-hex
 */
export function claimsFingerprint(claims) {
  return createHash('sha256').update(canonicalJson(claims)).digest('hex');
}

/** Stable JSON: key order must not change a fingerprint. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(/** @type {any} */ (value)[k])}`).join(',')}}`;
}

/**
 * Build a verified identity context.
 *
 * Every field is bounded and checked. An input this refuses is an input the
 * framework will not authorize — there is no lenient path and no default that
 * upgrades a caller's authority.
 *
 * @param {{
 *   kind: string,
 *   subject: string,
 *   issuer?: string|null,
 *   method?: string|null,
 *   verifiedAt?: string|null,
 *   organizationId?: string|null,
 *   requestId?: string|null,
 *   claims?: unknown,
 *   claimsFingerprint?: string|null,
 * }} input
 */
export function defineIdentity(input) {
  if (!input || typeof input !== 'object') {
    throw new ValidationError('an identity context is required', { field: 'identity' });
  }
  const kind = identityString(input.kind, 'identity.kind', { required: true });
  if (!IDENTITY_KINDS.includes(/** @type {any} */ (kind))) {
    throw new ValidationError(
      `identity.kind must be one of ${IDENTITY_KINDS.join(', ')}`,
      { field: 'identity.kind' },
    );
  }

  // Anonymous is the one kind with no subject: it names nobody by definition,
  // and inventing a subject for it would be exactly the fail-open this module
  // exists to remove.
  if (kind === 'anonymous') {
    return Object.freeze({
      identityContract: IDENTITY_CONTRACT,
      kind: 'anonymous',
      subject: null,
      issuer: null,
      method: null,
      verifiedAt: null,
      organizationId: null,
      requestId: identityString(input.requestId, 'identity.requestId'),
      claimsFingerprint: null,
    });
  }

  const subject = identityString(input.subject, 'identity.subject', { required: true });
  const method = identityString(input.method, 'identity.method');
  if (method !== null && !IDENTITY_METHODS.includes(/** @type {any} */ (method))) {
    throw new ValidationError(
      `identity.method must be one of ${IDENTITY_METHODS.join(', ')}`,
      { field: 'identity.method' },
    );
  }

  // A verified user must say who verified it. "Verified by nobody" is not
  // verified, and accepting it would let an adapter launder an assertion.
  const issuer = identityString(input.issuer, 'identity.issuer', { required: kind === 'verified-user' });

  const verifiedAt = identityString(input.verifiedAt, 'identity.verifiedAt');
  if (verifiedAt !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(verifiedAt)) {
    throw new ValidationError(
      'identity.verifiedAt must be a canonical UTC ISO instant',
      { field: 'identity.verifiedAt' },
    );
  }

  const organizationId = identityString(input.organizationId, 'identity.organizationId', {
    max: MAX_ORGANIZATION_ID,
  });

  const supplied = identityString(input.claimsFingerprint, 'identity.claimsFingerprint');
  if (supplied !== null && !/^[0-9a-f]{64}$/.test(supplied)) {
    throw new ValidationError('identity.claimsFingerprint must be a 64-character hex digest', {
      field: 'identity.claimsFingerprint',
    });
  }
  const fingerprint = supplied ?? (input.claims === undefined ? null : claimsFingerprint(input.claims));

  return Object.freeze({
    identityContract: IDENTITY_CONTRACT,
    kind,
    subject,
    issuer,
    method,
    verifiedAt,
    organizationId,
    requestId: identityString(input.requestId, 'identity.requestId'),
    claimsFingerprint: fingerprint,
  });
}

/** The identity that names nobody. Authorizes nothing. */
export const ANONYMOUS_IDENTITY = defineIdentity({ kind: 'anonymous', subject: 'unused' });

/**
 * The audit/trace projection of an identity.
 *
 * This is what may be written down. It deliberately cannot carry a credential,
 * because the source object cannot either — but stating the projection
 * explicitly means a future field cannot leak into evidence by being added.
 *
 * @param {any} identity
 */
export function identityEvidence(identity) {
  if (!identity) return null;
  return Object.freeze({
    kind: identity.kind,
    subject: identity.subject,
    issuer: identity.issuer,
    method: identity.method,
    organizationId: identity.organizationId,
    claimsFingerprint: identity.claimsFingerprint,
  });
}

/**
 * The legacy `Actor` shape, derived from an identity.
 *
 * Actions, audit and trace speak `{type, id}` throughout the repository and
 * ADR-038 does not rewrite that vocabulary — it puts something trustworthy
 * behind it. A `verified-user` becomes `user`; `system` becomes `system`; an
 * `asserted-local` developer becomes `user` **only because local mode already
 * said assertions are acceptable there**.
 *
 * @param {any} identity
 */
export function actorFromIdentity(identity) {
  if (!identity || identity.kind === 'anonymous') return null;
  if (identity.kind === 'system') return Object.freeze({ type: 'system', id: identity.subject });
  return Object.freeze({ type: 'user', id: identity.subject });
}
