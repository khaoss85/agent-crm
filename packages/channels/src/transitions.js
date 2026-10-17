// @ts-check

import { AppError } from '../../core/index.js';

/**
 * Explicit lifecycle machines for channel rows (backlog:e5532d1c9146).
 *
 * Review round 3: inbox and outbox states were scattered across ad-hoc
 * `processed`/`effect`/`state` checks, so every new path re-decided the
 * lifecycle and two of them decided wrong (quarantine replay applied,
 * adapter worker-codes bypassed the dead letter, concurrent requeues
 * double-sent). The tables below are the single definition of the
 * lifecycles; {@link transitionInbox} and {@link transitionLetter} are the
 * only functions that move a row, and every package path goes through them.
 *
 * Inbox rows (`channel-inbox-event`) carry `processed` + `effect`; the state
 * is derived, never stored twice:
 * - `received`: recorded, effect not final (`processed === false`).
 * - `quarantined`: held as evidence, terminal (`processed`, `quarantined`).
 * - `applied`: provider state applied (`processed`, `applied`).
 * - `discarded`: set aside with reason, terminal (`processed`, `ignored`).
 *
 * Dead letters (`channel-dead-letter`) carry `state` directly:
 * `open` -> `requeued` (one human retry) or `resolved`; both terminal.
 */

export const INBOX_STATES = Object.freeze(['received', 'quarantined', 'applied', 'discarded']);
export const INBOX_EVENTS = Object.freeze(['apply', 'discard', 'quarantine', 'replay']);

export const INBOX_TRANSITIONS = Object.freeze({
  received: Object.freeze({ apply: 'applied', discard: 'discarded', quarantine: 'quarantined' }),
  quarantined: Object.freeze({ replay: 'quarantined' }),
  applied: Object.freeze({ replay: 'applied' }),
  discarded: Object.freeze({ replay: 'discarded' }),
});

export const LETTER_STATES = Object.freeze(['open', 'requeued', 'resolved']);
export const LETTER_EVENTS = Object.freeze(['requeue', 'resolve']);

export const LETTER_TRANSITIONS = Object.freeze({
  open: Object.freeze({ requeue: 'requeued', resolve: 'resolved' }),
  requeued: Object.freeze({ resolve: 'resolved' }),
  resolved: Object.freeze({}),
});

/** Derive the inbox lifecycle state from a stored row. Never stored twice. */
export function inboxState(row) {
  if (!row || typeof row !== 'object' || row.processed !== true) return 'received';
  if (row.effect === 'applied') return 'applied';
  if (row.effect === 'ignored') return 'discarded';
  if (row.effect === 'quarantined') return 'quarantined';
  return 'received';
}

/** @param {string} from @param {string} event */
export function assertInboxTransition(from, event) {
  const to = Object.hasOwn(INBOX_TRANSITIONS, from)
    ? /** @type {Record<string, string>} */ (INBOX_TRANSITIONS[/** @type {keyof typeof INBOX_TRANSITIONS} */ (from)])[event]
    : undefined;
  if (typeof to !== 'string') {
    throw new AppError(`Channel inbox row cannot "${event}" from "${from}"`, {
      code: 'CHANNEL_TRANSITION_INVALID', status: 409,
    });
  }
  return to;
}

/** @param {string} from @param {string} event */
export function assertLetterTransition(from, event) {
  const to = Object.hasOwn(LETTER_TRANSITIONS, from)
    ? /** @type {Record<string, string>} */ (LETTER_TRANSITIONS[/** @type {keyof typeof LETTER_TRANSITIONS} */ (from)])[event]
    : undefined;
  if (typeof to !== 'string') {
    throw new AppError(`Channel dead letter cannot "${event}" from "${from}"`, {
      code: 'CHANNEL_TRANSITION_INVALID', status: 409,
    });
  }
  return to;
}

const INBOX_STATE_PATCH = Object.freeze({
  applied: Object.freeze({ processed: true, effect: 'applied' }),
  discarded: Object.freeze({ processed: true, effect: 'ignored' }),
  quarantined: Object.freeze({ processed: true, effect: 'quarantined' }),
});

/**
 * Move one inbox row through the machine. Re-reads the row, refuses any
 * (state, event) pair the table does not allow, and applies the move with a
 * single managed write. `patch` carries reason fields only — `processed`
 * and `effect` stay owned by the table, so callers cannot smuggle a state.
 */
export async function transitionInbox(service, id, { event, patch = {}, actor } = {}) {
  const current = await service.get(id);
  const from = inboxState(current);
  const to = assertInboxTransition(from, event);
  if (to === from) return current;
  const { processed: _p, effect: _e, ...reasons } = patch ?? {};
  void _p;
  void _e;
  return service.applyManaged(id, {
    ...INBOX_STATE_PATCH[/** @type {keyof typeof INBOX_STATE_PATCH} */ (to)],
    ...reasons,
  }, { actor });
}

/**
 * Move one dead letter through the machine. Same contract: re-read, refuse
 * what the table does not allow, one managed write. Callers that raced
 * (a concurrent requeue won first) get CHANNEL_TRANSITION_INVALID and
 * decide there — the requeue path cancels its just-created job and reports
 * the settled letter instead of sending twice.
 */
export async function transitionLetter(service, id, { event, patch = {}, actor } = {}) {
  const current = await service.get(id);
  const from = typeof current?.state === 'string' ? current.state : '';
  const to = assertLetterTransition(from, event);
  const { state: _s, ...reasons } = patch ?? {};
  void _s;
  return service.applyManaged(id, { state: to, ...reasons }, { actor });
}
