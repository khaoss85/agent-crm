// @ts-check

import { AppError } from '../../core/index.js';

/**
 * Explicit lifecycle machines for payment rows (backlog:1972e16d33f2).
 *
 * One table is the single definition of each lifecycle; the transition
 * functions below are the only functions that move a row, and every package
 * path goes through them.
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
