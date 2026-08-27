// @ts-check

import { randomUUID } from 'node:crypto';
import { ValidationError } from './errors.js';
import { resolveClock } from './time.js';

/**
 * **The one persist-or-verify loop for registered definition versions (ADR-015).**
 *
 * A definition version is immutable once registered: re-registering the same
 * `{type, name, version}` with the same fingerprint is a no-op, and the same
 * identity with a *changed* fingerprint stops the boot. Every registry that
 * publishes versioned definitions needs that rule, and each of them used to
 * carry its own copy of it, prepared against the SQLite driver by hand.
 *
 * Several copies of one rule is several places for it to drift, and the rule is
 * the one that decides whether an application starts. This store is the single
 * implementation, behind Storage Contract v1: it renders no SQL, names no
 * table but its own, and gives a caller no way to reach the driver. It knows
 * nothing about any domain — `type` is an opaque identity string its callers
 * choose.
 *
 * ### What it deliberately is not
 *
 * Not a repository, not an ORM, not a query surface. It accepts a bounded
 * collection of definition identities and persists exactly those four fields;
 * there is no predicate builder, no table parameter and no raw escape hatch.
 * It never stores an executable definition or its config — only the identity
 * and the fingerprint computed from them.
 *
 * ### Whole-batch semantics
 *
 * Every entry is verified-or-inserted inside ONE storage transaction — the same
 * `BEGIN IMMEDIATE` wrapper the application handle opens, so nesting
 * refusal (`NESTED_TRANSACTION`) and the retryable `CONFLICT` a busy database
 * produces are unchanged. A batch that refuses halfway persists nothing, and
 * two applications booting concurrently serialize on the write lock: the loser
 * re-reads the committed rows and verifies instead of racing to a UNIQUE
 * violation. Reads happen before the matching write inside the transaction, so
 * an identity that appears twice in one batch verifies against what the batch
 * itself just wrote.
 *
 * The batch is validated in full *before* the transaction opens: a malformed
 * identity is a startup-time defect, and it should never be the reason a
 * transaction has to roll back.
 */

/** The one table this store persists into. Not a parameter, deliberately. */
const TABLE = 'definition_versions';

/** How much of a fingerprint the drift refusal quotes. */
const FINGERPRINT_PREVIEW = 12;

/** The closed identity shape a caller may hand over. `id` and `registeredAt` are the store's. */
const ENTRY_FIELDS = Object.freeze(['type', 'name', 'version', 'fingerprint']);

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} index
 */
function requireIdentityString(value, field, index) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(
      `Definition version ${field} must be a non-empty string`,
      { index, field },
    );
  }
  return value;
}

/**
 * Reject anything that is not one of the four identity fields. A caller that
 * hands over `config`, `evaluate` or a stray key is asking this store to
 * persist something it must never persist, and silently dropping the key would
 * make that request look as if it had succeeded.
 * @param {unknown} entry
 * @param {number} index
 */
function validateEntry(entry, index) {
  // The same "plain object" test the storage contract's own `closed()` applies.
  // A class instance or a null-prototype bag can carry the four fields and
  // still not be the shape this contract names, and `typeof` alone says yes to
  // both of them.
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
    || Object.getPrototypeOf(entry) !== Object.prototype) {
    throw new ValidationError('Definition version entry must be a plain object', { index });
  }
  // `Reflect.ownKeys`, not `Object.keys`: a field hidden behind
  // `Object.defineProperty(…, {enumerable: false})`, or held under a symbol, is
  // still a field the caller is asking this store to accept. A closed shape
  // checked with `Object.keys` is not closed against either spelling.
  const unknown = Reflect.ownKeys(entry).find((key) => !ENTRY_FIELDS.includes(key));
  if (unknown !== undefined) {
    const named = typeof unknown === 'symbol' ? unknown.toString() : unknown;
    throw new ValidationError(`Definition version entry has an unsupported field "${named}"`, { index, field: named });
  }
  // The other half of closing the shape. Refusing keys nobody named is not
  // enough: every named key must be present on the object *itself*. A polluted
  // `Object.prototype` otherwise supplies a missing field through the chain —
  // no unsupported own key to find, a prototype that genuinely is
  // `Object.prototype`, and a read that quietly returns the inherited value.
  const missing = ENTRY_FIELDS.find((field) => !Object.hasOwn(entry, field));
  if (missing !== undefined) {
    throw new ValidationError(`Definition version entry requires own field "${missing}"`, { index, field: missing });
  }
  const record = /** @type {Record<string, unknown>} */ (entry);
  const version = record.version;
  if (!Number.isInteger(version) || /** @type {number} */ (version) < 0) {
    throw new ValidationError('Definition version version must be a non-negative integer', { index, field: 'version' });
  }
  return Object.freeze({
    type: requireIdentityString(record.type, 'type', index),
    name: requireIdentityString(record.name, 'name', index),
    version: /** @type {number} */ (version),
    fingerprint: requireIdentityString(record.fingerprint, 'fingerprint', index),
  });
}

/**
 * The refusal a registered definition's changed source produces. Byte-identical
 * across all four registries by construction — it used to be four copies of one
 * template, and a boot failure is the worst place for two of them to disagree.
 * @param {{type: string, name: string, version: number, fingerprint: string}} entry
 * @param {unknown} persisted
 */
function driftError(entry, persisted) {
  return new ValidationError(
    `${entry.type} "${entry.name}@${entry.version}" source changed after registration (persisted fingerprint ${String(persisted).slice(0, FINGERPRINT_PREVIEW)}…, current ${entry.fingerprint.slice(0, FINGERPRINT_PREVIEW)}…). `
      + 'Registered definition versions are immutable: publish a new version instead of editing this one.',
  );
}

/**
 * The id source, given the same treatment `resolveClock` gives the clock: an
 * injected generator is *input*, so what it returns is validated on every call
 * rather than only that it is callable. A generator returning `null`, a number
 * or an empty string would otherwise reach `storage.execute` and let the
 * adapter's `PRIMARY KEY` decide — which is both a leak of the driver's words
 * and a refusal arriving far later than it should.
 *
 * The two refusals differ deliberately. A non-function is construction-time
 * misuse and raises `TypeError`, exactly as `resolveClock` does. A bad *value*
 * is on its way to a write, so it raises `ValidationError` and carries the
 * framework's stable code like every other refusal in this store.
 *
 * @param {unknown} newId
 */
function resolveIdSource(newId) {
  if (newId === undefined || newId === null) return randomUUID;
  if (typeof newId !== 'function') throw new TypeError('newId must be a function returning an id');
  return () => {
    const value = newId();
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ValidationError('newId must return a non-empty string id');
    }
    return value;
  };
}

/**
 * @param {any} database — an application database handle carrying `storage.sync`
 * @param {{clock?: () => string, newId?: () => string}} [options]
 *   `clock` and `newId` exist so a test can pin `registered_at` and `id`; the
 *   defaults are the framework clock and `randomUUID`, which is what every
 *   registry used before this store existed.
 */
export function createDefinitionVersionStore(database, options = {}) {
  const now = resolveClock(options.clock);
  const newId = resolveIdSource(options.newId);
  const storage = database?.storage?.sync;
  if (!storage) {
    throw new ValidationError('The definition-version store requires a database with Storage Contract v1');
  }

  return Object.freeze({
    /**
     * Persist-or-verify every identity in one transaction.
     * @param {Iterable<{type: string, name: string, version: number, fingerprint: string}>} entries
     */
    persist(entries) {
      const bounded = [...entries].map(validateEntry);
      // Mint every id before the transaction opens, so a generator that returns
      // a bad value or repeats itself is refused *without* a `BEGIN IMMEDIATE`
      // to roll back — the same guarantee the rest of this store's validation
      // gives. The cost is one discarded id per entry that turns out to verify
      // rather than insert, which is free for a UUID source and buys something
      // better than tidiness: a broken generator fails every boot, not only the
      // boot that happens to have something new to write.
      const ids = bounded.map(() => newId());
      const seen = new Set();
      for (const id of ids) {
        if (seen.has(id)) {
          throw new ValidationError(
            `newId issued the same id twice in one batch ("${id}"); every definition version needs its own id`,
          );
        }
        seen.add(id);
      }
      storage.transaction(() => {
        for (const [index, entry] of bounded.entries()) {
          const persisted = storage.maybeOne({
            kind: 'select',
            table: TABLE,
            columns: ['fingerprint'],
            where: [
              { column: 'type', op: 'eq', value: entry.type },
              { column: 'name', op: 'eq', value: entry.name },
              { column: 'version', op: 'eq', value: entry.version },
            ],
          });
          if (!persisted) {
            storage.execute({
              kind: 'insert',
              table: TABLE,
              values: [
                { column: 'id', value: ids[index] },
                { column: 'type', value: entry.type },
                { column: 'name', value: entry.name },
                { column: 'version', value: entry.version },
                { column: 'fingerprint', value: entry.fingerprint },
                { column: 'registered_at', value: now() },
              ],
            });
            continue;
          }
          if (String(persisted.fingerprint) !== entry.fingerprint) throw driftError(entry, persisted.fingerprint);
        }
      });
    },
  });
}
