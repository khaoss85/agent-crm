// @ts-check

/**
 * backlog:a762c28a646c — the customer names the /bo has already read.
 *
 * The scheda's name used to wait for its own card read (1,3-3,6 s on the
 * pilot) even when the person had just clicked that name in the Clienti
 * list, in an offer's «Per <cliente>» or in the scheda itself a moment ago.
 * Every view that shows a customer's name next to a link to the scheda
 * remembers it here; the scheda paints it at once, in its title and in the
 * crumb, and its own read replaces it when it lands. Names belong to their
 * space; the store is bounded (the oldest name leaves first) and lives only
 * in memory, for this tab.
 *
 * @param {{ space: () => string | null, limit?: number }} options the active space, read late
 */
export function createKnownNames({ space, limit = 500 }) {
  /** @type {Map<string, string>} */
  const names = new Map();
  /** @param {unknown} resource @param {unknown} id */
  const keyOf = (resource, id) => {
    if (typeof resource !== 'string' || !/^[a-z][a-z0-9-]*$/.test(resource)) return null;
    if (typeof id !== 'string' || id === '') return null;
    return `${space() ?? ''}\u0000${resource}\u0000${id}`;
  };
  return {
    /**
     * A view showed this customer's name.
     * @param {unknown} resource @param {unknown} id @param {unknown} name
     */
    remember(resource, id, name) {
      const key = keyOf(resource, id);
      const text = typeof name === 'string' ? name.trim() : '';
      if (key === null || text === '') return;
      names.delete(key);
      names.set(key, text);
      while (names.size > limit) names.delete(/** @type {string} */ (names.keys().next().value));
    },
    /**
     * The name last shown for this customer in this space, or null.
     * @param {unknown} resource @param {unknown} id
     * @returns {string | null}
     */
    get(resource, id) {
      const key = keyOf(resource, id);
      return key === null ? null : (names.get(key) ?? null);
    },
  };
}
