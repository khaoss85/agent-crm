// @ts-check

import { AppError, ValidationError } from '../../core/index.js';

/**
 * Delivery execution states (Milestone 14).
 *
 * M13 produced a *planned* delivery project. This file is the whole answer to
 * "what may become what", and it is an explicit table rather than a rank
 * comparison: `completed > active` is arithmetic, not a business rule, and a
 * rank comparison silently permits every transition somebody later inserts
 * between two numbers.
 *
 * Three deliberate absences:
 *
 * - **no reopen.** `completed` is terminal in M14. Reopening completed work has
 *   its own invariants (what happens to recorded time, to an acceptance already
 *   given) and an untested reopen path is worse than none.
 * - **no clock transition.** Nothing here fires on a date. There is no
 *   scheduler in this framework, so no state changes without an actor.
 * - **acceptance is not completion, and is not here.** A milestone that is
 *   `completed` says the work finished; whether the customer agreed is a
 *   different fact with a different author, and it belongs to M14b. No
 *   acceptance state is declared, because an enum value nothing can reach is a
 *   capability claim without a capability.
 */

export const PROJECT_STATES = Object.freeze(['pending_kickoff', 'in_progress', 'completed']);
export const WORK_PACKAGE_STATES = Object.freeze(['planned', 'in_progress', 'blocked', 'completed']);
export const MILESTONE_STATES = Object.freeze(['planned', 'in_progress', 'completed']);

/**
 * The allowed transitions, as data. Each entry maps a current state to the
 * states it may become. A state absent from a table is terminal.
 */
export const PROJECT_TRANSITIONS = Object.freeze({
  pending_kickoff: Object.freeze(['in_progress']),
  in_progress: Object.freeze(['completed']),
});

export const WORK_PACKAGE_TRANSITIONS = Object.freeze({
  planned: Object.freeze(['in_progress']),
  // Blocked is a real operational state and it is reversible: work resumes.
  in_progress: Object.freeze(['blocked', 'completed']),
  blocked: Object.freeze(['in_progress']),
});

export const MILESTONE_TRANSITIONS = Object.freeze({
  planned: Object.freeze(['in_progress']),
  in_progress: Object.freeze(['completed']),
});

/** The states in which delivery consumption (time, expense) may be recorded. */
export const RECORDING_PROJECT_STATES = Object.freeze(['in_progress', 'completed']);
export const RECORDING_WORK_PACKAGE_STATES = Object.freeze(['in_progress', 'blocked', 'completed']);

const TABLES = Object.freeze({
  'delivery-project': { states: PROJECT_STATES, transitions: PROJECT_TRANSITIONS },
  'delivery-work-package': { states: WORK_PACKAGE_STATES, transitions: WORK_PACKAGE_TRANSITIONS },
  'delivery-milestone': { states: MILESTONE_STATES, transitions: MILESTONE_TRANSITIONS },
});

/** @param {string} kind */
function tableFor(kind) {
  const table = Object.prototype.hasOwnProperty.call(TABLES, kind) ? TABLES[kind] : undefined;
  if (!table) throw new ValidationError(`Unknown delivery record kind "${String(kind)}"`);
  return table;
}

/**
 * Assert a transition is allowed, refusing with a stable, explaining error.
 *
 * A record whose stored state is not in the table at all is a **corrupted
 * historical combination**, not an unknown transition: it fails closed with its
 * own code rather than being treated as "not allowed from here", so a data
 * problem never reads as an ordinary business refusal.
 *
 * @param {{kind: string, from: unknown, to: string, id: string}} request
 */
export function assertTransition({ kind, from, to, id }) {
  const { states, transitions } = tableFor(kind);
  if (typeof from !== 'string' || !states.includes(from)) {
    throw new AppError(`${kind} "${id}" has an unrecognized stored state`, {
      code: 'DELIVERY_STATE_CORRUPT', status: 409,
      details: { kind, id, storedState: typeof from === 'string' ? from.slice(0, 40) : typeof from },
    });
  }
  if (!states.includes(to)) {
    throw new ValidationError(`${kind}: "${to}" is not a ${kind} state`);
  }
  const allowed = Object.prototype.hasOwnProperty.call(transitions, from) ? transitions[from] : [];
  if (!allowed.includes(to)) {
    throw new AppError(`${kind} "${id}" cannot move from "${from}" to "${to}"`, {
      code: 'DELIVERY_TRANSITION_NOT_ALLOWED', status: 409,
      details: { kind, id, from, to, allowed: [...allowed] },
    });
  }
}

/**
 * Optimistic concurrency for a human decision: when the caller states which
 * state it believed the record was in, a different stored state is a stable
 * `409` rather than a silent overwrite of somebody else's transition.
 *
 * @param {{kind: string, id: string, expected: unknown, actual: string}} request
 */
export function assertExpectedState({ kind, id, expected, actual }) {
  if (expected === undefined || expected === null) return;
  if (typeof expected !== 'string') {
    throw new ValidationError(`${kind}: expectedState must be a string when supplied`);
  }
  if (expected !== actual) {
    throw new AppError(`${kind} "${id}" is no longer in state "${expected}"`, {
      code: 'DELIVERY_STATE_CONFLICT', status: 409,
      details: { kind, id, expected: expected.slice(0, 40), actual },
    });
  }
}

/** Assert a record is in one of the states an operation requires. */
export function assertStateIn({ kind, id, state, allowed, operation }) {
  if (!allowed.includes(state)) {
    throw new AppError(`${kind} "${id}" must be ${allowed.join(' or ')} to ${operation} (it is "${state}")`, {
      code: 'DELIVERY_STATE_NOT_ALLOWED', status: 409,
      details: { kind, id, state, allowed: [...allowed], operation },
    });
  }
}

/** The transition tables as function-free schema metadata. */
export function transitionMetadata() {
  return {
    'delivery-project': { states: [...PROJECT_STATES], transitions: plain(PROJECT_TRANSITIONS) },
    'delivery-work-package': { states: [...WORK_PACKAGE_STATES], transitions: plain(WORK_PACKAGE_TRANSITIONS) },
    'delivery-milestone': { states: [...MILESTONE_STATES], transitions: plain(MILESTONE_TRANSITIONS) },
    terminal: 'completed work does not reopen in this milestone, and no state changes on a clock — there is no scheduler',
    acceptance: 'not modeled in this milestone: whether a customer accepted the work is a separate fact with a separate author (M14b)',
  };
}

/** @param {Record<string, readonly string[]>} table */
function plain(table) {
  return Object.fromEntries(Object.entries(table).map(([from, to]) => [from, [...to]]));
}
