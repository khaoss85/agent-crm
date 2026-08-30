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
 * Bounds on what may be stored and quoted back. Every identity string lands in
 * a database row *and* in a refusal a person reads at boot, so an unbounded one
 * is both an unbounded row and an unbounded error message. 200 sits far above
 * anything real — the longest `type` in the repository is
 * `domain-policy:<domain>:<kind>` over a 64-character package name, and a
 * fingerprint is 64 hex characters.
 */
const MAX_IDENTITY = 200;

/**
 * A batch is the checked-in definitions of one application, registered once at
 * startup. The cap exists so an accidental runaway generator is a framework
 * refusal rather than an out-of-memory crash; it is orders of magnitude above
 * any real composition.
 */
const MAX_BATCH = 10_000;

/**
 * Characters that never appear in a real identity and do appear in
 * log-splitting and terminal-escape payloads: C0, DEL, the C1 range, and the
 * Unicode line and paragraph separators. Refusing them keeps both a stored
 * identity and the refusal quoting it readable.
 */
const FORBIDDEN_IDENTITY_TEXT = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

/**
 * **One rule for every piece of identity text this store handles.**
 *
 * `type`, `name`, `fingerprint` and the id the store generates are all stored
 * in the same row and all interpolated into the same boot-time refusals, so
 * they all earn the same bounds. Applying the rule to some of them and not
 * others is precisely what produced a run of near-identical review findings:
 * one place validated, another not, the difference invisible until someone
 * went looking. There is one bound for all four, deliberately — a UUID is 36
 * characters and `MAX_IDENTITY` is a generous ceiling for it, so a second limit
 * would be a number to justify rather than a rule to follow.
 *
 * `subject` is the caller's own phrase, so the refusal still names the exact
 * field. A shared validator that said only "identity invalid" would trade a
 * class of bug for a loss of diagnosability, and this text is what a person
 * reads when a boot fails.
 *
 * @param {unknown} value
 * @param {string} subject — how the refusal names this value
 * @param {unknown} [details]
 */
function assertIdentityText(value, subject, details) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${subject} must be a non-empty string`, details);
  }
  if (value.length > MAX_IDENTITY) {
    throw new ValidationError(
      `${subject} is too long (${value.length} characters; the limit is ${MAX_IDENTITY})`, details,
    );
  }
  if (FORBIDDEN_IDENTITY_TEXT.test(value)) {
    throw new ValidationError(`${subject} must not contain a control character`, details);
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
  // `isSafeInteger`, not `isInteger`: past 2^53 a version cannot survive a round
  // trip through JS, so two different versions would read back as the same one.
  const version = record.version;
  if (!Number.isSafeInteger(version) || /** @type {number} */ (version) < 0) {
    throw new ValidationError('Definition version version must be a non-negative integer', { index, field: 'version' });
  }
  return Object.freeze({
    type: assertIdentityText(record.type, 'Definition version type', { index, field: 'type' }),
    name: assertIdentityText(record.name, 'Definition version name', { index, field: 'name' }),
    version: /** @type {number} */ (version),
    fingerprint: assertIdentityText(record.fingerprint, 'Definition version fingerprint', { index, field: 'fingerprint' }),
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
  // The same rule the entry's own identity fields get: the id is persisted in
  // the same row and quoted into the same refusals, so it earns the same bounds.
  return () => assertIdentityText(newId(), 'The id newId returned', { field: 'id' });
}

/**
 * Turn whatever the caller passed into a bounded array, refusing in this
 * store's own words rather than letting `[...entries]` raise a bare
 * `TypeError: … is not iterable` that names no contract.
 * @param {unknown} entries
 */
function boundedBatch(entries) {
  if (entries === null || entries === undefined || typeof (/** @type {any} */ (entries)[Symbol.iterator]) !== 'function') {
    throw new ValidationError('Definition versions to persist must be iterable');
  }
  const collected = [];
  for (const item of /** @type {Iterable<unknown>} */ (entries)) {
    if (collected.length >= MAX_BATCH) {
      throw new ValidationError(
        `Too many definition versions in one batch (the limit is ${MAX_BATCH})`,
      );
    }
    collected.push(item);
  }
  return collected;
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
  const sync = database?.storage?.sync;
  const storage = sync ?? database?.storage;
  if (!storage) {
    throw new ValidationError('The definition-version store requires a database with Storage Contract v1');
  }

  return Object.freeze({
    /**
     * Persist-or-verify every identity in one transaction.
     * @param {Iterable<{type: string, name: string, version: number, fingerprint: string}>} entries
     */
    persist(entries) {
      const bounded = boundedBatch(entries).map(validateEntry);
      // Mint every id and timestamp before the transaction opens, so a source
      // that returns a bad value or repeats itself is refused *without* a
      // `BEGIN IMMEDIATE` to roll back — the same guarantee the rest of this
      // store's validation gives. The cost is one discarded id per entry that
      // turns out to verify rather than insert, which is free for a UUID source
      // and buys something better than tidiness: a broken generator fails every
      // boot, not only the boot that happens to have something new to write.
      const minted = bounded.map(() => ({ id: newId(), registeredAt: now() }));
      const seen = new Set();
      for (const { id } of minted) {
        if (seen.has(id)) {
          throw new ValidationError(
            `newId issued the same id twice in one batch ("${id}"); every definition version needs its own id`,
          );
        }
        seen.add(id);
      }
      const persistWith = async (handle) => {
        for (const [index, entry] of bounded.entries()) {
          const persisted = await handle.maybeOne({
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
            const taken = await handle.maybeOne({
              kind: 'select',
              table: TABLE,
              columns: ['id'],
              where: [{ column: 'id', op: 'eq', value: minted[index].id }],
            });
            if (taken) {
              throw new ValidationError(
                `newId returned an id that is already registered ("${minted[index].id}"); `
                  + 'every definition version needs its own id',
              );
            }
            await handle.execute({
              kind: 'insert',
              table: TABLE,
              values: [
                { column: 'id', value: minted[index].id },
                { column: 'type', value: entry.type },
                { column: 'name', value: entry.name },
                { column: 'version', value: entry.version },
                { column: 'fingerprint', value: entry.fingerprint },
                { column: 'registered_at', value: minted[index].registeredAt },
              ],
            });
            continue;
          }
          if (String(persisted.fingerprint) !== entry.fingerprint) throw driftError(entry, persisted.fingerprint);
        }
      };
      if (sync) {
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
              const taken = storage.maybeOne({
                kind: 'select',
                table: TABLE,
                columns: ['id'],
                where: [{ column: 'id', op: 'eq', value: minted[index].id }],
              });
              if (taken) {
                throw new ValidationError(
                  `newId returned an id that is already registered ("${minted[index].id}"); `
                    + 'every definition version needs its own id',
                );
              }
              storage.execute({
                kind: 'insert',
                table: TABLE,
                values: [
                  { column: 'id', value: minted[index].id },
                  { column: 'type', value: entry.type },
                  { column: 'name', value: entry.name },
                  { column: 'version', value: entry.version },
                  { column: 'fingerprint', value: entry.fingerprint },
                  { column: 'registered_at', value: minted[index].registeredAt },
                ],
              });
              continue;
            }
            if (String(persisted.fingerprint) !== entry.fingerprint) throw driftError(entry, persisted.fingerprint);
          }
        });
        return;
      }
      return storage.transaction((tx) => persistWith(tx));
    },
  });
}
