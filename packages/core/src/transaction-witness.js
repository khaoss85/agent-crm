// @ts-check

/**
 * **Proving a caller-owned transaction without handing out the driver.**
 *
 * Some writes are only correct as a set. A follow-up Task and its creation
 * Activity are one business fact in two rows; a handover marks N obligations
 * or none; a successor agreement is a contract, its version, its lines, its
 * subscription, its obligations and the lineage row that says what it
 * replaced. Every one of those goes through a generated module service, and a
 * generated service writes on a `SAVEPOINT` (`packages/cli/src/module-factory.js`)
 * precisely so it nests safely inside an enclosing transaction.
 *
 * Outside one, a `SAVEPOINT` is its own transaction and `RELEASE` commits it.
 * So the set stops being a set: the first row commits, the third fails, and
 * what is left on disk is a half of something the package's own documentation
 * promises never exists. That is not theoretical — it was measured on three
 * separate capabilities before this module existed
 * (`docs/plans/spine-v2-m2d-transaction-context.md` §2).
 *
 * The old way to check was to read the SQLite driver's `isTransaction` flag
 * straight off the module service's database handle, which meant a business
 * package holding the raw driver: every table in the application, `exec`,
 * `prepare` and no boundary at all, for one boolean. This module is that
 * boolean without the driver.
 *
 * (The spelling of that old reach is deliberately not written out here. The
 * M2D structural guard is a token scan over the raw source, comments included,
 * and a file that names the thing it removed would trip it — which is the
 * guard behaving correctly, so the prose bends rather than the guard.)
 *
 * ### What a witness is
 *
 * An empty frozen object, minted by the database wrapper when it opens an
 * outer transaction and dropped when that transaction commits or rolls back.
 * It carries no fields, so there is nothing to read, copy or reconstruct, and
 * the only record that it is genuine lives in this module's private `WeakSet`.
 * A caller can pass `true`, `{}`, `{isTransaction: true}` or a structural copy
 * of a real one and be refused, because none of them was ever put in the set —
 * and nothing exported from here can put one there.
 *
 * ### What it is NOT
 *
 * Not authentication, and not a capability. It proves a transaction is open on
 * a storage handle; it says nothing about who opened it or what they may do.
 * The security model remains trusted checked-in source (ADR-018 addendum 4).
 */

/**
 * The witnesses this module minted. Private, with no exported mutator, which
 * is the whole of the unforgeability argument: membership cannot be granted
 * from outside this file.
 */
const MINTED = new WeakSet();

/**
 * Which storage handle each witness was minted for. A witness from another
 * database proves nothing about the connection the write is about to land on,
 * so the binding is recorded rather than assumed.
 */
const OWNER = new WeakMap();

/**
 * The outcomes of {@link proveCallerTransaction}, as data.
 *
 * They are deliberately distinct rather than a boolean: a consumer maps them
 * onto its own refusal codes and its own sentences, so this module publishes
 * no message and owns no package's vocabulary.
 */
export const TRANSACTION_PROOF = Object.freeze({
  /** One handle, and an outer transaction genuinely open on it. */
  ACTIVE: 'active',
  /** A service exposed no storage handle at all. */
  NO_STORAGE: 'no-storage',
  /** Two services that must commit together are on two different handles. */
  SPLIT_STORAGE: 'split-storage',
  /** The handle cannot answer the question — not a storage contract this framework built. */
  NO_WITNESS_API: 'no-witness-api',
  /** Something answered, but with a value this module never minted for this handle. */
  FORGED_WITNESS: 'forged-witness',
  /** A genuine handle, honestly reporting that no outer transaction is open. */
  NO_TRANSACTION: 'no-transaction',
});

/**
 * Mint the witness for one outer transaction on one storage handle.
 *
 * Called by the database wrapper's `begin()` and by nothing else. It is
 * deliberately **not** re-exported from `packages/core/index.js`: a package
 * that could mint could manufacture the proof it is supposed to be subject to.
 *
 * @param {object} storage the storage handle the transaction is open on
 * @returns {object} the opaque witness
 */
export function mintTransactionWitness(storage) {
  // No fields, and frozen. A witness is an identity, not a value — there is
  // nothing here for a caller to observe and replicate.
  const witness = Object.freeze({});
  MINTED.add(witness);
  OWNER.set(witness, storage);
  return witness;
}

/**
 * The storage handle a module service writes through, or null.
 *
 * A generated service holds the application database object and writes through
 * `database.storage` (`this.database.storage.sync.savepoint(...)`). That
 * property — never the driver beside it — is the handle a write lands on, so
 * it is the handle the proof is about.
 *
 * @param {any} service
 */
function storageOf(service) {
  const storage = service?.database?.storage;
  return storage && typeof storage === 'object' ? storage : null;
}

/**
 * Prove that these services will write on **one** storage handle, inside an
 * outer transaction that is open on that handle right now.
 *
 * Both halves matter and neither implies the other. Two services on two
 * connections break atomicity even when each is inside a transaction, because
 * they are inside *different* ones — so the handles are compared before the
 * transaction is looked for. It is one identity comparison and it closes a
 * hole nothing else was checking.
 *
 * The witness is **pulled** from the handle that will do the writing rather
 * than accepted from the caller. That is what binds the proof to the right
 * connection: a caller cannot satisfy it by holding some other transaction's
 * token, because its token is never consulted.
 *
 * ### What this proves, and what it does not
 *
 * The name says "caller". What the code checks is that **an outer transaction
 * is open on this connection** — it cannot see which async flow opened it, and
 * there is nothing on the handle that would tell it.
 *
 * The two are the same statement only while three invariants hold:
 *
 * 1. **One connection per application instance.** `createDatabase` opens one,
 *    and every module service receives that same object.
 * 2. **Nested outer transactions are refused.** `begin()` raises
 *    `NESTED_TRANSACTION`, so a transaction open on this connection cannot
 *    belong to an inner scope the caller does not own.
 * 3. **One loaded core module instance per process.** The witness registry is
 *    the module-private `WeakSet` above; two copies of `packages/core` in one
 *    process do not share it, and the proof fails closed as `FORGED_WITNESS`.
 *
 * **The gap those invariants leave, stated plainly.** If flow A opens
 * `transactionAsync` and awaits, a flow B that opened nothing can call a
 * consumer of this function during that window, be told `ACTIVE`, write inside
 * A's transaction, and lose those writes when A rolls back. That is measured,
 * not hypothetical — `tests/spine-v2-m2d-transaction-context.test.js` pins it.
 *
 * It is unreachable in production **today**, and by invariant 2 rather than by
 * luck: every caller of every consumer is a record action, and a concurrent
 * record action opens its own transaction and is refused `NESTED_TRANSACTION`
 * before it can reach here. **A caller that invokes one of those consumers
 * outside a record action would reach it**, which is the thing to check before
 * adding one.
 *
 * This is also strictly better than what it replaced: reading the driver's
 * `isTransaction` flag answered the same connection-wide question, and two of
 * the four consumers had no check at all, so a transactionless caller used to
 * corrupt unconditionally rather than only inside another flow's window.
 *
 * Closing the gap means binding the witness to the async caller rather than to
 * the connection — the same ownership question as the pooled-connection
 * affinity obligation recorded in `DECISIONS.md` (ADR-018 addendum 8), and it
 * belongs there rather than here.
 *
 * @param {any[]} services the module services whose writes must commit together
 * @returns {string} one of {@link TRANSACTION_PROOF}
 */
export function proveCallerTransaction(services) {
  const list = Array.isArray(services) ? services : [services];
  if (list.length === 0) return TRANSACTION_PROOF.NO_STORAGE;

  const storage = storageOf(list[0]);
  if (!storage) return TRANSACTION_PROOF.NO_STORAGE;
  for (const service of list.slice(1)) {
    const other = storageOf(service);
    if (!other) return TRANSACTION_PROOF.NO_STORAGE;
    // Identity, not equality: two handles onto the same file are still two
    // connections, and two connections cannot share a transaction.
    if (other !== storage) return TRANSACTION_PROOF.SPLIT_STORAGE;
  }

  if (typeof (/** @type {any} */ (storage).activeTransaction) !== 'function') {
    return TRANSACTION_PROOF.NO_WITNESS_API;
  }
  let witness;
  try {
    witness = /** @type {any} */ (storage).activeTransaction();
  } catch {
    // A handle whose answer throws has not answered. Fail closed.
    return TRANSACTION_PROOF.NO_WITNESS_API;
  }
  // A genuine handle says `null` when nothing is open. That is an honest
  // answer to the question and it is reported as its own outcome, because it
  // is the one a caller can fix by opening a transaction.
  if (witness === null || witness === undefined) return TRANSACTION_PROOF.NO_TRANSACTION;
  if (!isActiveTransactionWitness(storage, witness)) return TRANSACTION_PROOF.FORGED_WITNESS;
  return TRANSACTION_PROOF.ACTIVE;
}

/**
 * Is this a witness this module minted, for this exact storage handle?
 *
 * `MINTED` rejects anything constructed outside this file — a boolean, a bare
 * object, a hand-built stand-in. `OWNER` rejects a genuine witness that belongs
 * to a different database, which is the case a caller could otherwise produce
 * honestly by holding two applications open at once.
 *
 * @param {object} storage @param {unknown} witness
 */
export function isActiveTransactionWitness(storage, witness) {
  if (typeof witness !== 'object' || witness === null) return false;
  const token = /** @type {object} */ (witness);
  return MINTED.has(token) && OWNER.get(token) === storage;
}
