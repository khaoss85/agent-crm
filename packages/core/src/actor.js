// @ts-check

/**
 * @typedef {{type: 'user'|'agent'|'system', id: string}} Actor
 */

/** @type {Actor} */
export const SYSTEM_ACTOR = Object.freeze({ type: 'system', id: 'accordo' });

/** @param {unknown} actor @returns {Actor} */
export function normalizeActor(actor) {
  if (!actor || typeof actor !== 'object') return SYSTEM_ACTOR;
  const candidate = /** @type {{type?: unknown, id?: unknown}} */ (actor);
  const type = candidate.type;
  const id = candidate.id;
  if ((type === 'user' || type === 'agent' || type === 'system') && typeof id === 'string' && id.trim()) {
    return { type, id: id.trim() };
  }
  return SYSTEM_ACTOR;
}
