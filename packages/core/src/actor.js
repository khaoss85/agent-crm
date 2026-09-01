// @ts-check

import { ValidationError } from './errors.js';

/**
 * @typedef {{type: 'user'|'agent'|'system', id: string}} Actor
 */

/**
 * **The actor boundary, and why it now fails closed (ADR-038, amended).**
 *
 * `normalizeActor` used to return {@link SYSTEM_ACTOR} — the most privileged
 * identity this framework has — for `null`, for a string, for an unknown
 * `type` and for any malformed object. The safest possible input produced the
 * strongest possible identity, which is the wrong direction for a value that
 * security decisions are later made from.
 *
 * A review argued this was unreachable from any public adapter, and that was
 * true of the code as it stood. It was true because of two properties nothing
 * tested: `actor` happening to be spread *last* in two request handlers, and
 * `identityToActor` happening to be total. A boundary that holds by coincidence
 * holds until somebody writes `{ actor, ...body }`.
 *
 * So it was measured rather than argued. Instrumenting the fallback and running
 * the whole suite took it **three times**, every one the same shape — an e2e
 * fixture passing `{type: 'human', id: 'e2e'}`, an unknown type silently
 * promoted to the system actor. Nothing legitimate depended on the fail-open
 * branch; the only thing it did in practice was launder a typo into root.
 *
 * ### The rule now
 *
 * - A **well-formed** actor is returned as given. Deliberate `system` and
 *   `agent` actors keep working exactly as before.
 * - Anything else becomes {@link ANONYMOUS_ACTOR} — the least privileged
 *   identity, which holds no membership and therefore authorizes nothing.
 * - {@link SYSTEM_ACTOR} is never *fallen back to*. The sanctioned way to ask
 *   for it is {@link trustedSystemActor}, which takes a reason so the call site
 *   states why it is entitled to.
 *
 * ### What that does and does not prove
 *
 * A review checked the audit claim rather than accepting it, and the honest
 * statement is narrower than "grep is a complete audit". Two things are true:
 *
 * - **One bounded framework runtime claims system authority today.**
 *   The transactional-outbox worker uses `trustedSystemActor` for its named,
 *   payload-free job/audit transitions. No module outside this file directly
 *   references {@link SYSTEM_ACTOR}. Both facts are measured because a second
 *   claim site or a direct privileged constant reference needs fresh review.
 * - **Grep alone does not bound it.** {@link SYSTEM_ACTOR} is exported, and a
 *   deliberately well-formed `{type: 'system', id: 'x'}` normalizes to a system
 *   actor by design — the signature webhook depends on exactly that. So an
 *   audit of framework self-authority is `trustedSystemActor` **plus** direct
 *   {@link SYSTEM_ACTOR} references **plus** hand-built system actors.
 *   `tests/actor-fails-closed.test.js` pins the first two at their counts, so
 *   the day one of them stops being zero is a day a test says so.
 */

/**
 * The framework acting as itself.
 *
 * **Never a fallback.** Reachable through {@link trustedSystemActor}, or by an
 * explicit, well-formed `{type: 'system'}` value a caller deliberately built.
 */
export const SYSTEM_ACTOR = Object.freeze({ type: 'system', id: 'accordo' });

/**
 * The least-privileged actor: what an unusable actor value becomes.
 *
 * A `user` rather than a new kind, because every consumer already understands
 * users, and `anonymous` holds no membership anywhere — so an authorization
 * decision made from it refuses.
 */
export const ANONYMOUS_ACTOR = Object.freeze({ type: 'user', id: 'anonymous' });

/** The actor types this framework recognises. Closed on purpose. */
const ACTOR_TYPES = Object.freeze(['user', 'agent', 'system']);

/**
 * Keys a caller may never supply in a request payload.
 *
 * The server decides who you are and which tenant you are in; a body carrying
 * its own answer is trying to decide for it. **Stripped rather than
 * overridden**, so the property does not depend on the order of an object
 * spread at some call site — which is precisely the fragility a review flagged.
 */
export const SERVER_CONTROLLED_KEYS = Object.freeze([
  'actor', 'identity', 'organizationId', 'organization_id', 'tenantId', 'tenant_id',
]);

/**
 * Remove server-controlled keys from a caller-supplied payload.
 *
 * @param {unknown} payload
 * @returns {Record<string, unknown>}
 */
export function stripServerControlledKeys(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const out = /** @type {Record<string, unknown>} */ ({});
  for (const [key, value] of Object.entries(payload)) {
    if (SERVER_CONTROLLED_KEYS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Normalize an actor, failing **closed**.
 *
 * @param {unknown} actor
 * @returns {Actor}
 */
export function normalizeActor(actor) {
  if (!actor || typeof actor !== 'object') return ANONYMOUS_ACTOR;
  // **Own properties only.** An actor whose `type` comes from a prototype is
  // not an actor somebody wrote down; it is one somebody arranged to be found.
  if (!Object.hasOwn(actor, 'type') || !Object.hasOwn(actor, 'id')) return ANONYMOUS_ACTOR;
  const candidate = /** @type {{type?: unknown, id?: unknown}} */ (actor);
  const type = candidate.type;
  const id = candidate.id;
  if (ACTOR_TYPES.includes(/** @type {any} */ (type)) && typeof id === 'string' && id.trim()) {
    return { type: /** @type {any} */ (type), id: id.trim() };
  }
  // Least privilege, not most. This branch used to return SYSTEM_ACTOR.
  return ANONYMOUS_ACTOR;
}

/**
 * The strict form: refuse rather than degrade.
 *
 * Used where an actor is a *precondition* rather than a label — a caller that
 * cannot say who it is has not asked a well-formed question. Kept separate from
 * {@link normalizeActor} because the audit log must still be able to record an
 * event whose actor was unusable: recording it as anonymous is true, while
 * refusing to record it would lose the evidence that it happened at all.
 *
 * @param {unknown} actor
 * @param {string} [field]
 * @returns {Actor}
 */
export function requireActor(actor, field = 'actor') {
  if (!actor || typeof actor !== 'object') {
    throw new ValidationError('an actor is required, and must be an object naming a type and an id', { field });
  }
  const candidate = /** @type {{type?: unknown, id?: unknown}} */ (actor);
  if (!ACTOR_TYPES.includes(/** @type {any} */ (candidate.type))) {
    throw new ValidationError(`actor.type must be one of ${ACTOR_TYPES.join(' | ')}`, { field: `${field}.type` });
  }
  if (typeof candidate.id !== 'string' || candidate.id.trim() === '') {
    throw new ValidationError('actor.id is required', { field: `${field}.id` });
  }
  return { type: /** @type {any} */ (candidate.type), id: candidate.id.trim() };
}

/**
 * **The named trusted-system path.**
 *
 * The only sanctioned way to obtain {@link SYSTEM_ACTOR}. It takes a reason, so
 * that every place the framework acts with its own authority states at the call
 * site why it is entitled to.
 *
 * @param {string} reason
 * @returns {Actor}
 */
export function trustedSystemActor(reason) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new ValidationError(
      'the framework may only act as itself for a stated reason: name the system action',
      { field: 'reason' },
    );
  }
  return SYSTEM_ACTOR;
}
