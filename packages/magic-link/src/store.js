// @ts-check

/**
 * Magic-link token store (backlog:0cbae947, BO-F0-05).
 *
 * The store is an injected edge, like every custody boundary in this
 * repository: the package owns the rule (single use), the deployment owns
 * the rows. `createMemoryMagicLinkStore` is the local/test default; a
 * durable deployment backs the same three methods with its database, where
 * `spend` MUST be one conditional write
 * (`UPDATE ... SET spent WHERE tokenId = ? AND spent = false`) so two
 * concurrent consumes still elect exactly one winner.
 *
 * A stored row never carries the raw email address — only its hash (see
 * `hashLoginEmail` in rules.js). The mailbox itself travels only through
 * the delivery edge at issue time.
 *
 * @typedef {{ tokenId: string, emailHash: string, subject: string, issuedAtMs: number, expiresAtMs: number, spent: boolean }} MagicLinkRecord
 */

/**
 * In-process store. `spend` checks and marks in one synchronous step, which
 * is atomic on this thread: concurrent consumes elect exactly one winner.
 */
export function createMemoryMagicLinkStore() {
  /** @type {Map<string, MagicLinkRecord>} */
  const rows = new Map();
  return {
    /** @param {MagicLinkRecord} record */
    save(record) {
      rows.set(record.tokenId, { ...record });
    },
    /** @param {string} tokenId @returns {MagicLinkRecord | null} */
    find(tokenId) {
      const row = rows.get(tokenId);
      return row ? { ...row } : null;
    },
    /**
     * Mark spent only when still pending. Returns true for the single
     * winner, false for a missing or already-spent token.
     *
     * @param {string} tokenId
     */
    spend(tokenId) {
      const row = rows.get(tokenId);
      if (!row || row.spent) return false;
      rows.set(tokenId, { ...row, spent: true });
      return true;
    },
  };
}
