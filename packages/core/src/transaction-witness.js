// @ts-check

import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from './errors.js';

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
 * **Who owns the transaction that is open right now.**
 *
 * The witness registry above answers "is this a real witness for this handle".
 * It cannot answer "did *this* call open it", because one connection serves the
 * whole instance and nothing on the handle distinguishes one async flow from
 * another. This does: the witness is published into the async context that
 * opened the transaction, so a flow that did not open one reads `undefined`
 * even while a transaction is genuinely open on the connection.
 *
 * Node carries this across `await`, `queueMicrotask`, `process.nextTick`,
 * `setTimeout`, `setImmediate` and an `EventEmitter` emitted inside the scope.
 * It does **not** carry across a callback that leaves the scope and is invoked
 * later — a stored function, or a listener registered inside and emitted
 * outside. `AsyncResource.bind` carries it across those deliberately. The
 * refusal names all of this rather than leaving a caller to guess.
 */
const OWNERSHIP = new AsyncLocalStorage();

/**
 * The witness for the transaction currently open on each storage handle.
 *
 * It lives here rather than in the database wrapper so that minting, publishing
 * and clearing are one operation in one place — there is no second slot that
 * could disagree with this one.
 */
const CURRENT = new WeakMap();

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
  /**
   * A real transaction is open on this handle, and this call is not the flow
   * that opened it — either another flow owns it, or this call crossed a
   * boundary that dropped its async context.
   */
  NOT_TRANSACTION_OWNER: 'not-transaction-owner',
});

/** Claimed exactly once, by the database wrapper, at module load. */
let minterClaimed = false;

/**
 * **Claim the right to open an owned transaction scope. Once, per process.**
 *
 * Not exporting the mint was never the boundary it looked like. The rule that
 * keeps a package out of `packages/core/src/…` reads import *specifiers*, so
 * `const p = '…'; await import(p)` walks straight past it — and a package that
 * reaches the mint can manufacture the ownership this module exists to prove.
 * Documenting that as a limitation was honest while the witness only claimed
 * connection scope. It is not honest now, so the hole is closed instead.
 *
 * It is closed by **exhaustion, not by analysis**: the first caller takes the
 * capability and every later caller is refused, whatever import spelling it
 * used. `packages/core/src/database.js` claims it at module load, so by the
 * time any package can run, there is nothing left to take. A package that
 * somehow loads first and claims it does not get a quiet forgery either — the
 * database wrapper's own claim then throws and the application fails to boot,
 * loudly, which is the direction this framework fails in.
 *
 * There is deliberately no way to mint a witness *without* running the body
 * that owns it: minting, publishing into the async context, and clearing are
 * one operation. A caller cannot obtain a witness and use it somewhere else,
 * because it never holds one.
 *
 * @returns {(storage: object, body: () => any) => any}
 */
export function claimTransactionMinter() {
  if (minterClaimed) {
    throw new Error(
      'The transaction witness minter is already claimed. It is claimed once per process by the database '
        + 'wrapper, so that no other code can mint the witness that proves transaction ownership.',
    );
  }
  minterClaimed = true;
  /**
   * Open the owned scope for one outer transaction, run `body` inside it, and
   * drop the witness whatever happens.
   *
   * `allowAsync` is false for the **synchronous** wrapper, which commits as soon
   * as this returns. An async body handed to it would have its `COMMIT` executed
   * while it was still running — and, once ownership existed, its continuation
   * would be told `ACTIVE` for a transaction that had already committed. That is
   * the false green this whole module exists to prevent, so it is refused rather
   * than accommodated.
   *
   * @param {object} storage @param {() => any} body
   * @param {{allowAsync?: boolean}} [options]
   */
  return function openTransactionScope(storage, body, { allowAsync = true } = {}) {
    // No fields, and frozen. A witness is an identity, not a value — there is
    // nothing here for a caller to observe and replicate.
    const witness = Object.freeze({});
    MINTED.add(witness);
    OWNER.set(witness, storage);
    CURRENT.set(storage, witness);
    // The scope has to close when the BODY finishes, not when `run` returns.
    // A `finally` here fires the moment an async body hands back its pending
    // promise, which would drop the witness while the transaction is still
    // open — the first version did exactly that, and every consumer inside the
    // transaction was told there was none.
    let closed = false;
    const close = () => { if (!closed) { closed = true; CURRENT.delete(storage); } };
    try {
      const result = OWNERSHIP.run(witness, body);
      if (result && typeof (/** @type {any} */ (result).then) === 'function') {
        if (!allowAsync) {
          // Ownership is dropped BEFORE throwing, so the body's continuation —
          // which keeps running, and which this function cannot stop — is
          // refused by the proof rather than served a committed transaction.
          close();
          throw new AppError(
            'database.transaction() is synchronous and commits as soon as its callback returns, so an async '
              + 'callback would be committed while it was still running and its continuation would be told it '
              + 'is inside a transaction that has already committed. Use database.transactionAsync() instead.',
            { code: 'SYNC_TRANSACTION_ASYNC_BODY', status: 500 },
          );
        }
        return /** @type {any} */ (result).then(
          (/** @type {any} */ value) => { close(); return value; },
          (/** @type {any} */ error) => { close(); throw error; },
        );
      }
      close();
      return result;
    } catch (error) {
      close();
      throw error;
    }
  };
}

/**
 * The witness for the outer transaction currently open on this handle, or null.
 *
 * Read-only, and the value is meaningless on its own: holding it proves
 * nothing, because {@link proveCallerTransaction} never accepts a witness from
 * a caller — it looks one up.
 *
 * @param {object} storage
 */
export function currentTransactionWitness(storage) {
  return CURRENT.get(storage) ?? null;
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
 * ### What this proves
 *
 * Three things, and the third is the one the name promises:
 *
 * 1. every service that must commit together writes on **one** storage handle;
 * 2. an outer transaction is open on that handle right now;
 * 3. **this call's asynchronous flow is the one that opened it.**
 *
 * (3) is why the name is honest. An earlier cut of this module proved only (1)
 * and (2), and documented the gap: if flow A opened a transaction and awaited,
 * a flow B that opened nothing was told `ACTIVE`, wrote inside A's transaction
 * and lost those writes to A's rollback. The witness is now published into the
 * async context that opened the transaction, so B reads a different store — or
 * none — and is refused `NOT_TRANSACTION_OWNER`.
 *
 * ### The false refusal this buys, and how a caller gets out of it
 *
 * Ownership is real, so it can be lost. Async context survives `await`,
 * `queueMicrotask`, `process.nextTick`, `setTimeout`, `setImmediate` and an
 * event emitted inside the transaction — all measured, in
 * `tests/spine-v2-m2d-transaction-context.test.js`, not assumed. It is lost by
 * a callback that leaves the transaction and is invoked later, including a
 * listener registered inside it and emitted outside.
 *
 * A caller in that position is refused, and the refusal **names the cause and
 * the fix** rather than reporting a missing transaction while one is plainly
 * open: wrap the callback with `AsyncResource.bind` before it leaves. That is
 * measured too — the bound callback reads `ACTIVE`, the plain one reads
 * `NOT_TRANSACTION_OWNER`.
 *
 * ### What it still assumes
 *
 * - **One connection per application instance.** `createDatabase` opens one and
 *   every module service receives that same object, which is what makes (1) a
 *   comparison rather than a guess.
 * - **One loaded core module instance per process.** The registries above are
 *   module-private; two copies of `packages/core` in one process do not share
 *   them, and the proof fails closed as `FORGED_WITNESS`.
 *
 * `NESTED_TRANSACTION` is no longer load-bearing for correctness here — it was
 * what made the ownership gap unreachable in production, and the gap is closed.
 * It remains the framework's answer to a second outer transaction on one
 * connection.
 *
 * Under a pooled connection (`docs/plans/production-spine-v2-postgresql.md`)
 * both halves need the adapter's help: the handle compared by identity must be
 * the pooled client bound to the active transaction, and the ownership scope
 * must be opened around that client's work. Recorded as an obligation in
 * `DECISIONS.md` (ADR-018 addendum 8).
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
  // The ownership half. A transaction is genuinely open on the connection; this
  // asks whether *this* call is the flow that opened it. A caller running in
  // another flow's window reads a different store — or none — and is refused
  // rather than silently joining a transaction it does not control.
  if (OWNERSHIP.getStore() !== witness) return TRANSACTION_PROOF.NOT_TRANSACTION_OWNER;
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
