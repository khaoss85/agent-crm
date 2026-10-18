// @ts-check

import { AppError, TRANSACTION_PROOF, proveCallerTransaction } from '../../core/index.js';

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
 *
 * The send lifecycle (`JOB_*`) is the job-side vocabulary of the same
 * history, one send attempt from queue to outcome:
 * `queued` (job in the outbox) -> `sent` (provider id proven) or `failed`
 * (job terminal) -> `dead-letter` (inventory row open) -> `requeued`
 * (human retry claimed the letter and queued a new send). The letter row is
 * the persisted projection of the tail: it is written on the
 * `failed` -> `dead-letter` edge and moved on the `dead-letter` ->
 * `requeued` edge, and {@link advanceLetter} is the single function that
 * moves it — conditioned on the state it re-read, never on a stale copy.
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

export const JOB_STATES = Object.freeze(['queued', 'sent', 'failed', 'dead-letter', 'requeued']);
export const JOB_EVENTS = Object.freeze(['send', 'fail', 'letter', 'requeue']);

export const JOB_TRANSITIONS = Object.freeze({
  queued: Object.freeze({ send: 'sent', fail: 'failed' }),
  sent: Object.freeze({}),
  failed: Object.freeze({ letter: 'dead-letter' }),
  'dead-letter': Object.freeze({ requeue: 'requeued' }),
  requeued: Object.freeze({}),
});

/** @param {string} from @param {string} event */
export function assertJobTransition(from, event) {
  const to = Object.hasOwn(JOB_TRANSITIONS, from)
    ? /** @type {Record<string, string>} */ (JOB_TRANSITIONS[/** @type {keyof typeof JOB_TRANSITIONS} */ (from)])[event]
    : undefined;
  if (typeof to !== 'string') {
    throw new AppError(`Channel send cannot "${event}" from "${from}"`, {
      code: 'CHANNEL_TRANSITION_INVALID', status: 409,
    });
  }
  return to;
}

/**
 * Derive one send attempt's lifecycle state from the outbox job row and its
 * dead-letter row. The letter is the persisted projection of the tail, so it
 * wins when present: `open` means the send is waiting as inventory,
 * `requeued` means a human retry claimed it. A `resolved` letter closes the
 * human queue without retrying, so the send outcome stands: failed. Without
 * a letter the durable-job row decides: proven sends are sent, terminal jobs
 * are failed, everything else is still queued. Unknown shapes fall back to
 * `queued`, like the inbox deriver falls back to `received`.
 *
 * @param {{ jobState?: unknown, letterState?: unknown }} observed
 */
export function jobSendState({ jobState = null, letterState = null } = {}) {
  if (letterState === 'requeued') return 'requeued';
  if (letterState === 'open') return 'dead-letter';
  if (letterState === 'resolved') return 'failed';
  if (jobState === 'succeeded') return 'sent';
  if (jobState === 'failed_terminal') return 'failed';
  return 'queued';
}

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
 * what the table does not allow, one managed write. `transitionLetter`
 * stays as the thin assertion-plus-write the single path below is built on.
 */
export async function transitionLetter(service, id, { event, patch = {}, actor } = {}) {
  const current = await service.get(id);
  const from = typeof current?.state === 'string' ? current.state : '';
  const to = assertLetterTransition(from, event);
  const { state: _s, ...reasons } = patch ?? {};
  void _s;
  return service.applyManaged(id, { state: to, ...reasons }, { actor });
}

/**
 * Same-process serialization for every letter move, one global FIFO chain:
 * two requeues racing the same letter commit in order, so the loser
 * re-reads the winner's state instead of deciding on its stale snapshot.
 * Cross-process writers still serialize on the storage transaction above.
 * (MEM_ACC_REUSE: the same tail pattern the payments package uses for its
 * request moves — a package imports only core, so the helper lives here
 * rather than crossing the boundary.)
 */
const letterWriteChain = { tail: Promise.resolve() };

/** @param {() => Promise<any>} critical */
export async function withLetterWrite(critical) {
  const previous = letterWriteChain.tail;
  let release = () => {};
  const current = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => current, () => current);
  letterWriteChain.tail = tail;
  // Synchronous until here: two callers racing in the same tick still order.
  await previous;
  try {
    return await critical();
  } finally {
    if (letterWriteChain.tail === tail) letterWriteChain.tail = Promise.resolve();
    release();
  }
}

/**
 * The single choke point for EVERY dead-letter state change. One chain
 * slot, one durable unit, one fresh read of the letter row, one move
 * derived from LETTER_TRANSITIONS, one managed write. A move racing the
 * winner reads the winner's state and gets CHANNEL_TRANSITION_INVALID,
 * which each caller maps onto its own contract — never a raw error, never
 * a second send. `patch` carries reason fields only.
 *
 * `write`, when given, runs inside the SAME durable unit as the move — the
 * claim and its follow-up commit together or roll back together, so a
 * failure between them never leaves a claimed letter without its send (and
 * a process death loses both, never one). It receives the moved letter plus
 * the unit's transaction handle, and its return value surfaces as `wrote`.
 * Only storage work belongs there: never a provider call, never another
 * chained section. Where the store opens no unit, the follow-up still runs
 * in the same chain slot right after the move, and the move's `stateReason`
 * carries the intended follow-up identity so the gap stays observable.
 * A call already inside a unit joins it instead of opening a nested one (a
 * nested BEGIN would roll back the outer unit).
 *
 * @param {{ letters: any, database?: any }} stores
 * @returns {Promise<{ letter: any, wrote: any }>} `wrote` is the `write`
 * follow-up's return, or null when no follow-up ran.
 */
export async function advanceLetter(stores, id, { event, patch = {}, actor, write = null } = {}) {
  return withLetterWrite(async () => {
    const storage = stores?.database?.storage;
    const openUnit = storage && typeof storage.transaction === 'function'
      ? (/** @type {() => Promise<any>} */ critical) => storage.transaction(critical)
      : null;
    let proof = null;
    try {
      proof = proveCallerTransaction([stores?.letters]);
    } catch {
      proof = null;
    }
    const run = async (transaction) => {
      const current = await stores.letters.get(id);
      const from = typeof current?.state === 'string' ? current.state : '';
      const to = assertLetterTransition(from, event);
      const { state: _s, ...reasons } = patch ?? {};
      void _s;
      const letter = await stores.letters.applyManaged(id, { state: to, ...reasons }, { actor });
      const wrote = typeof write === 'function' ? await write({ letter, transaction }) : null;
      return { letter, wrote };
    };
    if (proof === TRANSACTION_PROOF.NO_TRANSACTION && openUnit) {
      return openUnit(run);
    }
    return run(null);
  });
}
