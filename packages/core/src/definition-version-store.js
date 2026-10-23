// @ts-check

import { randomUUID } from 'node:crypto';
import { AppError, ValidationError } from './errors.js';
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
 * collection of definition identities and persists exactly the four identity
 * fields (the optional approved history never lands in a row — it only names
 * which stored fingerprints the current one may replace);
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

/**
 * The closed identity shape a caller may hand over. `id` and `registeredAt`
 * are the store's. `supersededFingerprints` is optional: the exact historical
 * fingerprints this identity may still carry after a fingerprint-scheme
 * change, so one persist-or-verify transaction can both accept and move them
 * instead of a separate migration step that could commit half a batch.
 */
const ENTRY_FIELDS = Object.freeze(['type', 'name', 'version', 'fingerprint', 'supersededFingerprints']);
const REQUIRED_ENTRY_FIELDS = Object.freeze(['type', 'name', 'version', 'fingerprint']);

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
  // A class instance or a null-prototype bag can carry the required fields and
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
  const missing = REQUIRED_ENTRY_FIELDS.find((field) => !Object.hasOwn(entry, field));
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
    ...validateSupersededFingerprints(record.supersededFingerprints, index),
  });
}

/**
 * Historical fingerprints one identity may still carry after a
 * fingerprint-scheme change. One identity carries a handful of historical
 * forms at most; a longer list is a runaway generator refused fail-closed.
 * Absent means no history: the entry verifies by exact match only.
 * @param {unknown} value
 * @param {number} index
 */
const MAX_SUPERSEDED_FINGERPRINTS = 100;

/** @param {unknown} value @param {number} index */
function validateSupersededFingerprints(value, index) {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SUPERSEDED_FINGERPRINTS) {
    throw new ValidationError(
      `Definition version entry supersededFingerprints must be a non-empty array of at most ${MAX_SUPERSEDED_FINGERPRINTS} fingerprints when present`,
      { index, field: 'supersededFingerprints' },
    );
  }
  return {
    supersededFingerprints: Object.freeze(value.map((candidate, candidateIndex) => assertIdentityText(
      candidate,
      'Definition version superseded fingerprint',
      { index, field: 'supersededFingerprints', candidateIndex },
    ))),
  };
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
    // Machine-readable identity beside the human-readable message. The
    // message, code and status above are the store's stable refusal contract
    // (asserted byte-identical by the M2B suite); the details let a
    // multi-workspace host tell "this workspace's registered definitions
    // moved" apart from every other startup failure without parsing prose.
    { definitionVersionDrift: true, type: entry.type, name: entry.name, version: entry.version },
  );
}

/**
 * Classify a persisted row against the entry that claims it. A current row
 * verifies; a row carrying one of the entry's approved superseded
 * fingerprints verifies too and — on a writable composition — moves to the
 * current fingerprint inside the same transaction, so classification,
 * migration and verification can never land in different transactions and a
 * batch that refuses elsewhere persists nothing. Anything else is genuine
 * drift and refuses with the established message.
 * @param {{type: string, name: string, version: number, fingerprint: string, supersededFingerprints?: readonly string[]}} entry
 * @param {unknown} persisted
 * @returns {boolean} true when the write path must move the row to current
 */
function fingerprintNeedsMove(entry, persisted) {
  if (String(persisted.fingerprint) === entry.fingerprint) return false;
  if ((entry.supersededFingerprints ?? []).includes(String(persisted.fingerprint))) return true;
  throw driftError(entry, persisted.fingerprint);
}

/**
 * A guarded migration write applied exactly one row. Both SQLite and
 * PostgreSQL adapters report `{ affectedRows }`; a handle that reports
 * nothing (a double, an older adapter) reads as zero, which is the
 * fail-closed direction — the re-read below then decides.
 * @param {unknown} outcome — the value the handle's `execute` returned
 */
function moveApplied(outcome) {
  return Number(/** @type {{ affectedRows?: unknown } | null | undefined} */ (outcome)?.affectedRows ?? 0) === 1;
}

/** The identity predicate every migration move and re-read selects on. */
function identityPredicate(entry) {
  return [
    { column: 'type', op: 'eq', value: entry.type },
    { column: 'name', op: 'eq', value: entry.name },
    { column: 'version', op: 'eq', value: entry.version },
  ];
}

/**
 * Re-read after a guarded migration write matched nothing (lost race), on an
 * async handle. The row a concurrent boot already moved to current verifies;
 * a row that still carries an approved historical form is retried once,
 * guarded on the fresh value; anything else — a vanished row, or a
 * fingerprint no scheme explains — refuses as drift. Never proceeds on the
 * stale SELECT image (review khaoss85/agent-crm#333).
 *
 * A failed retry re-reads once more instead of refusing: the row may have
 * moved to current between the re-read and the retry, in which case this
 * boot verifies. Only a still-unexplained fingerprint is drift.
 */
async function recoverLostMove(handle, entry, expectedFingerprint) {
  const fresh = await handle.maybeOne({
    kind: 'select',
    table: TABLE,
    columns: ['fingerprint'],
    where: identityPredicate(entry),
  });
  if (!fresh) throw driftError(entry, expectedFingerprint);
  if (!fingerprintNeedsMove(entry, fresh)) return;
  const retried = await handle.execute({
    kind: 'update',
    table: TABLE,
    values: [{ column: 'fingerprint', value: entry.fingerprint }],
    where: [...identityPredicate(entry), { column: 'fingerprint', op: 'eq', value: String(fresh.fingerprint) }],
  });
  if (moveApplied(retried)) return;
  const reread = await handle.maybeOne({
    kind: 'select',
    table: TABLE,
    columns: ['fingerprint'],
    where: identityPredicate(entry),
  });
  if (!reread) throw driftError(entry, fresh.fingerprint);
  if (fingerprintNeedsMove(entry, reread)) {
    // Still an approved historical form after two lost races. No writer ever
    // stores a historical fingerprint, so the row is being rewritten under
    // us — refuse rather than chase it.
    throw driftError(entry, reread.fingerprint);
  }
}

/**
 * Re-read after a guarded migration write matched nothing (lost race), on a
 * synchronous handle. Same rule as `recoverLostMove`, without awaiting: the
 * sync persist path runs inside a synchronous transaction callback.
 */
function recoverLostMoveSync(handle, entry, expectedFingerprint) {
  const fresh = handle.maybeOne({
    kind: 'select',
    table: TABLE,
    columns: ['fingerprint'],
    where: identityPredicate(entry),
  });
  if (!fresh) throw driftError(entry, expectedFingerprint);
  if (!fingerprintNeedsMove(entry, fresh)) return;
  const retried = handle.execute({
    kind: 'update',
    table: TABLE,
    values: [{ column: 'fingerprint', value: entry.fingerprint }],
    where: [...identityPredicate(entry), { column: 'fingerprint', op: 'eq', value: String(fresh.fingerprint) }],
  });
  if (moveApplied(retried)) return;
  const reread = handle.maybeOne({
    kind: 'select',
    table: TABLE,
    columns: ['fingerprint'],
    where: identityPredicate(entry),
  });
  if (!reread) throw driftError(entry, fresh.fingerprint);
  if (fingerprintNeedsMove(entry, reread)) {
    // Still an approved historical form after two lost races. No writer ever
    // stores a historical fingerprint, so the row is being rewritten under
    // us — refuse rather than chase it.
    throw driftError(entry, reread.fingerprint);
  }
}

/**
 * Whether this error is a definition-version drift refusal: a registered
 * definition version whose source moved underneath it. True for the store's
 * own refusal (thrown where no workspace is named) and for the workspace
 * composition's `DEFINITION_VERSION_DRIFT` refusal (thrown where one is), so a
 * multi-workspace host needs exactly one check to refuse one workspace and
 * keep serving the rest. The message stays addressed to the person reading
 * the boot log; the host matches on this, never on prose.
 *
 * The code alone never matches: both branches require the store's
 * `definitionVersionDrift` marker in `details`, so a package-thrown `AppError`
 * reusing the `DEFINITION_VERSION_DRIFT` code cannot quarantine a workspace.
 * @param {unknown} error
 */
export function isDefinitionVersionDrift(error) {
  if (error instanceof AppError && error.code === 'DEFINITION_VERSION_DRIFT') {
    const details = error.details;
    return typeof details === 'object' && details !== null
      && /** @type {Record<string, unknown>} */ (details).definitionVersionDrift === true;
  }
  if (!(error instanceof ValidationError) || error.code !== 'VALIDATION_ERROR') return false;
  const details = error.details;
  return typeof details === 'object' && details !== null
    && /** @type {Record<string, unknown>} */ (details).definitionVersionDrift === true;
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
     * Persist-or-verify every identity in one transaction. An entry whose
     * persisted row carries one of its approved `supersededFingerprints`
     * moves to the current fingerprint inside that same transaction (a
     * read-only composition accepts it without writing); classification,
     * migration and verification never land in different transactions, so a
     * batch that refuses elsewhere persists nothing.
     * @param {Iterable<{type: string, name: string, version: number, fingerprint: string, supersededFingerprints?: string[]}>} entries
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
          if (fingerprintNeedsMove(entry, persisted)) {
            // A row under an approved superseded fingerprint: move it to
            // current, guarded on the value just read so a concurrent writer's
            // update is never silently overwritten. The guard is checked: on
            // zero affected rows the row is re-read in-transaction instead of
            // proceeding on the stale SELECT image.
            const moved = await handle.execute({
              kind: 'update',
              table: TABLE,
              values: [{ column: 'fingerprint', value: entry.fingerprint }],
              where: [
                { column: 'type', op: 'eq', value: entry.type },
                { column: 'name', op: 'eq', value: entry.name },
                { column: 'version', op: 'eq', value: entry.version },
                { column: 'fingerprint', op: 'eq', value: String(persisted.fingerprint) },
              ],
            });
            if (!moveApplied(moved)) {
              await recoverLostMove(handle, entry, String(persisted.fingerprint));
            }
          }
        }
      };
      // A read-only composition verifies what is registered and registers
      // nothing. The transaction below opens unconditionally — even when every
      // fingerprint already matches and there is nothing to write — so a
      // read-only storage refuses it and the application does not compose at
      // all. That is the whole point of the mode, applied to the one caller
      // that runs before anything else.
      //
      // Absence is tolerated on purpose. A definition the database has never
      // seen carries nothing that could be misread: there are no rows under it.
      // A definition that *is* registered under a different fingerprint is the
      // dangerous case, and that still refuses — unless the difference is one
      // of the entry's approved superseded fingerprints, which verifies
      // without writing.
      if (storage.readOnly === true) {
        return (async () => {
          for (const entry of bounded) {
            // Selected on `(type, name)` and **not** on the version, which is
            // the whole difference. Keying on the version too makes a
            // definition registered at another version invisible: not a match,
            // so no fingerprint to compare — and not "never seen" either,
            // because the database knows that definition perfectly well, just
            // at a different version. It falls between the two cases below, and
            // it is the only one this mode creates: a writer cannot produce it,
            // because a writer inserts and the two agree from then on.
            //
            // What it looks like when it bites: a policy moves from v1 to v2,
            // the web is redeployed and the worker is not. Rows written under
            // v1 are then read back through v2 logic — a total nobody ever
            // wrote and the worker would not reproduce — with `health()`
            // answering ready, no error, and no audit row, because an audit row
            // would be a write.
            const registered = await storage.many({
              kind: 'select',
              table: TABLE,
              columns: ['version', 'fingerprint'],
              where: [
                { column: 'type', op: 'eq', value: entry.type },
                { column: 'name', op: 'eq', value: entry.name },
              ],
            });
            // Nothing under this identity at all: a different composition. The
            // web may compose a package the worker does not, and there are no
            // rows beneath a definition nobody ever registered.
            if (registered.length === 0) continue;
            const persisted = registered.find((row) => Number(row.version) === Number(entry.version));
            if (!persisted) {
              throw new ValidationError(
                `${entry.type} "${entry.name}" is registered at ${registered.map((row) => `v${row.version}`).join(', ')}`
                  + ` and this application renders v${entry.version}; a read-only composition may not read rows written`
                  + ' under a version it does not carry',
              );
            }
            // A read-only composition registers and moves nothing: a current or
            // approved-superseded row verifies, anything else refuses.
            fingerprintNeedsMove(entry, persisted);
          }
        })();
      }
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
            if (fingerprintNeedsMove(entry, persisted)) {
              // Same move as the async path above, in this transaction: a
              // batch that refuses elsewhere rolls this move back with it.
              // The guard is checked here too: on zero affected rows the row
              // is re-read in-transaction instead of passing silently.
              const moved = storage.execute({
                kind: 'update',
                table: TABLE,
                values: [{ column: 'fingerprint', value: entry.fingerprint }],
                where: [
                  { column: 'type', op: 'eq', value: entry.type },
                  { column: 'name', op: 'eq', value: entry.name },
                  { column: 'version', op: 'eq', value: entry.version },
                  { column: 'fingerprint', op: 'eq', value: String(persisted.fingerprint) },
                ],
              });
              if (!moveApplied(moved)) {
                recoverLostMoveSync(storage, entry, String(persisted.fingerprint));
              }
            }
          }
        });
        return;
      }
      return storage.transaction((tx) => persistWith(tx));
    },

  });
}
