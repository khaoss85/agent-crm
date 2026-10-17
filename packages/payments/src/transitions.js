// @ts-check

import { AppError, TRANSACTION_PROOF, proveCallerTransaction } from '../../core/index.js';

/**
 * Explicit lifecycle machines for payment rows (backlog:1972e16d33f2).
 *
 * One table is the single definition of each lifecycle;
 * {@link advancePaymentRequest} is the single path every package write
 * takes to move a payment request (mint, ingest, resume, cancel).
 * `transitionRequest` stays as the thin assertion-plus-write the single
 * path is built on.
 *
 * Payment requests (`payment-request.status`, stored directly):
 * `open` (intent recorded) -> `pending` (provider checkout minted) ->
 * `paid` | `failed`; `open` or `pending` -> `canceled` (human cancel).
 * Terminal states (`paid`, `failed`, `canceled`) never regress — a repeated
 * webhook for an already-final request resolves identically instead of
 * writing a second payment.
 *
 * Payment events (`payment-event`) carry `processed` + `effect`; the state
 * is derived, never stored twice:
 * - `received`: recorded, effect not final (`processed === false`).
 * - `quarantined`: held as evidence, terminal (`processed`, `quarantined`).
 * - `applied`: provider state applied to the request (`processed`, `applied`).
 * - `discarded`: set aside with reason, terminal (`processed`, `ignored`).
 */

export const REQUEST_STATUSES = Object.freeze(['open', 'pending', 'paid', 'failed', 'canceled']);
export const REQUEST_EVENTS = Object.freeze(['mint', 'pay', 'fail', 'cancel']);

export const REQUEST_TRANSITIONS = Object.freeze({
  open: Object.freeze({ mint: 'pending', cancel: 'canceled' }),
  pending: Object.freeze({ pay: 'paid', fail: 'failed', cancel: 'canceled' }),
  paid: Object.freeze({}),
  failed: Object.freeze({}),
  canceled: Object.freeze({}),
});

/** Terminal: no event leaves them, and a repeated finalize resolves without writing. */
export const REQUEST_TERMINAL = Object.freeze(['paid', 'failed', 'canceled']);

export const EVENT_STATES = Object.freeze(['received', 'quarantined', 'applied', 'discarded']);
export const EVENT_EVENTS = Object.freeze(['apply', 'discard', 'quarantine']);

export const EVENT_TRANSITIONS = Object.freeze({
  received: Object.freeze({ apply: 'applied', discard: 'discarded', quarantine: 'quarantined' }),
  quarantined: Object.freeze({}),
  applied: Object.freeze({}),
  discarded: Object.freeze({}),
});

/** Derive the event lifecycle state from a stored row. Never stored twice. */
export function paymentEventState(row) {
  if (!row || typeof row !== 'object' || row.processed !== true) return 'received';
  if (row.effect === 'applied') return 'applied';
  if (row.effect === 'ignored') return 'discarded';
  if (row.effect === 'quarantined') return 'quarantined';
  return 'received';
}

/** @param {string} from @param {string} event */
export function assertRequestTransition(from, event) {
  const to = Object.hasOwn(REQUEST_TRANSITIONS, from)
    ? /** @type {Record<string, string>} */ (REQUEST_TRANSITIONS[/** @type {keyof typeof REQUEST_TRANSITIONS} */ (from)])[event]
    : undefined;
  if (typeof to !== 'string') {
    throw new AppError(`Payment request cannot "${event}" from "${from}"`, {
      code: 'PAYMENT_TRANSITION_INVALID', status: 409,
    });
  }
  return to;
}

/** @param {string} from @param {string} event */
export function assertPaymentEventTransition(from, event) {
  const to = Object.hasOwn(EVENT_TRANSITIONS, from)
    ? /** @type {Record<string, string>} */ (EVENT_TRANSITIONS[/** @type {keyof typeof EVENT_TRANSITIONS} */ (from)])[event]
    : undefined;
  if (typeof to !== 'string') {
    throw new AppError(`Payment event cannot "${event}" from "${from}"`, {
      code: 'PAYMENT_TRANSITION_INVALID', status: 409,
    });
  }
  return to;
}

const EVENT_STATE_PATCH = Object.freeze({
  applied: Object.freeze({ processed: true, effect: 'applied' }),
  discarded: Object.freeze({ processed: true, effect: 'ignored' }),
  quarantined: Object.freeze({ processed: true, effect: 'quarantined' }),
});

/**
 * Move one payment request through the machine. Re-reads the row, refuses
 * any (state, event) pair the table does not allow, and applies the move
 * with a single managed write. `patch` carries reason fields only —
 * `status` stays owned by the table, so callers cannot smuggle a state.
 */
export async function transitionRequest(service, id, { event, patch = {}, actor } = {}) {
  const current = await service.get(id);
  const from = typeof current?.status === 'string' ? current.status : '';
  const to = assertRequestTransition(from, event);
  if (to === from) return current;
  const { status: _s, ...reasons } = patch ?? {};
  void _s;
  return service.applyManaged(id, { status: to, ...reasons }, { actor });
}

/**
 * Open the transaction the single state move runs in, or null when the
 * move must run unwrapped: no storage handle, no witness API, or a
 * transaction already open (a nested BEGIN would roll back the outer
 * unit — record actions already run inside one). The wrapped body is
 * fully synchronous storage work (re-reads plus one write, no provider
 * calls), so on one connection a second move cannot interleave inside it:
 * it re-reads the winner and takes the loser's contract instead.
 *
 * @param {{ requests: any, database?: any }} stores
 */
export function paymentTransact(stores) {
  const requests = stores?.requests;
  const database = stores?.database ?? requests?.database ?? null;
  if (!database || typeof database.transactionAsync !== 'function') return null;
  let proof;
  try {
    proof = proveCallerTransaction([requests]);
  } catch {
    return null;
  }
  if (proof !== TRANSACTION_PROOF.NO_TRANSACTION) return null;
  return (/** @type {() => Promise<any>} */ critical) => database.transactionAsync(critical);
}

/**
 * Fresh connection read for one request row, scoped to the request's own
 * space and binding. A sibling connection's row is never returned here:
 * cross-connection finalization stays refused at the lookup, not trusted
 * to a status check.
 */
async function readRequestConnection(stores, request) {
  const listWhere = stores?.connections?.listWhere;
  if (typeof listWhere !== 'function' || !request
    || typeof request.spaceId !== 'string' || typeof request.connectionKey !== 'string') {
    return null;
  }
  const rows = await listWhere.call(stores.connections, {
    spaceId: request.spaceId, sourceKey: request.connectionKey,
  });
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

/**
 * Same-process serialization for every payment write, one global FIFO
 * chain: on one connection a statement executed while another flow's
 * transaction is open JOINS that transaction — a winner's event row
 * inserted during the loser's move window dies with the loser's rollback.
 * Ordering every payment write (moves and their event rows) on one chain
 * closes that window: acquisition attaches synchronously (no `await`
 * before the chain is extended), so two callers racing in the same tick
 * still order. Across connections the storage transaction below
 * serializes writers on real storage. Tails never reject, so a refused
 * move never wedges the chain.
 */
const paymentWriteChain = { tail: Promise.resolve() };

/** @param {() => Promise<any>} critical */
export async function withPaymentWrite(critical) {
  const previous = paymentWriteChain.tail;
  let release = () => {};
  const current = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => current, () => current);
  paymentWriteChain.tail = tail;
  // Synchronous until here: two callers racing in the same tick still order.
  await previous;
  try {
    return await critical();
  } finally {
    if (paymentWriteChain.tail === tail) paymentWriteChain.tail = Promise.resolve();
    release();
  }
}

/**
 * The single choke point for EVERY payment-request state change — mint,
 * ingest finalization, resume after reactivation, and cancel. One chain
 * slot, one transaction, one fresh read of the request row plus one fresh
 * read of its connection row, one move derived from REQUEST_TRANSITIONS,
 * one managed write. A move racing the winner reads the winner's state
 * and gets PAYMENT_TRANSITION_INVALID, which each caller maps onto its own
 * idempotent contract (duplicate / terminal / refused) — never a raw
 * error, never a second payment. `patch` carries reason fields only.
 *
 * `write`, when given, runs inside the same chain slot and transaction
 * right after the move — the move and its event row commit together, so a
 * concurrent loser's rollback can never swallow the winner's row. It
 * receives the move result and its return value surfaces as `wrote`.
 * Only storage work belongs there: never a provider call, never another
 * chained section.
 *
 * @param {{ requests: any, connections?: any, database?: any }} stores
 */
export async function advancePaymentRequest(stores, id, { event, patch = {}, actor, requireActiveConnection = false, write = null } = {}) {
  return withPaymentWrite(async () => {
    const transact = paymentTransact(stores);
    const run = async () => {
      const current = await stores.requests.get(id);
      const from = typeof current?.status === 'string' ? current.status : '';
      const to = assertRequestTransition(from, event);
      // Re-read HERE, inside the same transaction as the move: a suspend
      // racing an in-flight delivery is seen, never decided on stale state.
      const connection = await readRequestConnection(stores, current);
      if (requireActiveConnection && (!connection || connection.status !== 'active')) {
        throw new AppError(`Payment connection is ${connection?.status ?? 'unknown'}`, {
          code: 'PAYMENT_CONNECTION_NOT_ACTIVE', status: 409,
        });
      }
      const { status: _s, ...reasons } = patch ?? {};
      void _s;
      const updated = await stores.requests.applyManaged(id, { status: to, ...reasons }, { actor });
      const moved = { request: updated, connection };
      if (typeof write === 'function') {
        return { ...moved, wrote: await write(moved) };
      }
      return moved;
    };
    return transact ? transact(run) : run();
  });
}

/**
 * Move one payment event through the machine. Same contract: re-read,
 * refuse what the table does not allow, one managed write.
 */
export async function transitionPaymentEvent(service, id, { event, patch = {}, actor } = {}) {
  const current = await service.get(id);
  const from = paymentEventState(current);
  const to = assertPaymentEventTransition(from, event);
  if (to === from) return current;
  const { processed: _p, effect: _e, ...reasons } = patch ?? {};
  void _p;
  void _e;
  return service.applyManaged(id, {
    ...EVENT_STATE_PATCH[/** @type {keyof typeof EVENT_STATE_PATCH} */ (to)],
    ...reasons,
  }, { actor });
}
