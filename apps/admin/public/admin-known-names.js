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
  /** @type {Map<string, string>} */
  const offers = new Map();
  /** @param {Map<string, string>} map @param {string} key @param {string} value */
  const keep = (map, key, value) => {
    map.delete(key);
    map.set(key, value);
    while (map.size > limit) map.delete(/** @type {string} */ (map.keys().next().value));
  };
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
      keep(names, key, text);
    },
    /**
     * backlog:a060a4aa65b6: the offer page this customer was opened from —
     * the scheda asks its state history at once, beside its own first reads,
     * instead of after the profile names the offer.
     * @param {unknown} resource @param {unknown} id @param {unknown} offerId
     */
    rememberOffer(resource, id, offerId) {
      const key = keyOf(resource, id);
      if (key === null || typeof offerId !== 'string' || offerId === '') return;
      keep(offers, key, offerId);
    },
    /**
     * The offer last opened for this customer in this space, or null.
     * @param {unknown} resource @param {unknown} id
     * @returns {string | null}
     */
    offer(resource, id) {
      const key = keyOf(resource, id);
      return key === null ? null : (offers.get(key) ?? null);
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
