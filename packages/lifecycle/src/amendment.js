// @ts-check

import { AppError, ValidationError, requireCalendarDate } from '../../core/index.js';

/**
 * **M16b — renewal and amendment execution.**
 *
 * M16a stopped at intent: it recorded what a human decided and handed the
 * commercial work to a person. This is the execution counterpart, and it exists
 * only because two things landed after M16a: Signature and Commercial became
 * package-native with declared capabilities, and ADR-033 made a commercial term
 * *signed evidence* rather than post-signature operational metadata.
 *
 * **What it orchestrates, and what it does not own.** Lifecycle owns the
 * renewal *cycle*: a governed run over a source agreement, its state, and the
 * human decisions that move it. It owns none of the commercial truth. The
 * successor agreement, the line delta and the classification derived from it
 * are produced by Contracts through `contracts-successor-activation@1`, inside
 * this action's transaction — because a classification computed here and handed
 * over would be a client-supplied label, which is exactly what a renewal record
 * must never contain.
 *
 * **The recorded state is an observation, never an authorisation.** A run reads
 * `ready` because the evidence looked coherent at the moment somebody attached
 * an order to it. Execution recomputes every one of those facts inside its own
 * transaction and refuses on the recomputation, so a stale `ready` authorises
 * nothing at all.
 *
 * **No clock moves anything here.** There is no scheduler, nothing renews
 * itself, no notice period fires, and no customer is told that any of this
 * happened.
 */

export const AMENDMENT_RESOURCE = 'amendment-run';

/** The declared capability this package consumes to reach Contracts' write path. */
export const SUCCESSOR_CAPABILITY = Object.freeze({
  package: 'contracts', capability: 'contracts-successor-activation', version: 1,
});

export const AMENDMENT_STATES = Object.freeze([
  'planned', 'awaiting_signed_order', 'ready', 'executed', 'abandoned',
]);
export const AMENDMENT_TERMINAL = Object.freeze(['executed', 'abandoned']);

/**
 * **The allowed-transition table**, written down rather than implied by a rank.
 *
 * Two properties are deliberate and are asserted by test rather than trusted:
 * every terminal state has an empty row, so nothing regresses; and no row is
 * reachable by anything other than a named human action — there is no clock
 * input anywhere in this table.
 */
export const AMENDMENT_TRANSITIONS = Object.freeze({
  planned: Object.freeze(['awaiting_signed_order', 'ready', 'abandoned']),
  awaiting_signed_order: Object.freeze(['awaiting_signed_order', 'ready', 'abandoned']),
  ready: Object.freeze(['awaiting_signed_order', 'ready', 'executed', 'abandoned']),
  executed: Object.freeze([]),
  abandoned: Object.freeze([]),
});

const MAX_REASON = 300;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const MAX_ID = 200;

/** The business identity of one round on one source agreement. */
export const amendmentRunKey = (contractId, round) => `amendment-run:${contractId}:${round}`;
/** The opaque execution reference Contracts records on the lineage row. */
export const executionRefOf = (runId) => `amendment-run:${runId}`;

/** @param {Record<string, string>} [moduleNames] */
export function amendmentNames(moduleNames = {}) {
  return {
    contract: moduleNames['commercial-contract'] ?? 'commercial-contract',
    run: moduleNames['amendment-run'] ?? 'amendment-run',
    decision: moduleNames['renewal-decision'] ?? 'renewal-decision',
    followup: moduleNames['commercial-followup'] ?? 'commercial-followup',
  };
}

/** A bounded, control-character-free human reason. Shared shape with M16a. */
function requireText(value, field, max = MAX_REASON) {
  if (typeof value !== 'string') throw new ValidationError(`${field} is required`, { field });
  const trimmed = value.trim();
  if (trimmed === '') throw new ValidationError(`${field} is required`, { field });
  if (trimmed.length > max) throw new ValidationError(`${field} must be at most ${max} characters`, { field });
  if (CONTROL_RE.test(trimmed)) {
    throw new ValidationError(`${field} must not contain control characters or line breaks`, { field });
  }
  return trimmed;
}

/** @param {unknown} value */
function optionalId(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return requireText(value, field, MAX_ID);
}

/** @param {unknown} actor */
function requireHuman(actor, what) {
  if (!actor || typeof actor !== 'object' || /** @type {any} */ (actor).type !== 'user') {
    throw new AppError(`${what} is a human decision`, { code: 'HUMAN_APPROVAL_REQUIRED', status: 403 });
  }
  return String(/** @type {any} */ (actor).id ?? 'unknown');
}

/**
 * Open `contracts-successor-activation@1`, or refuse with the edge named.
 *
 * In practice unreachable at runtime — the registry refuses a composition whose
 * declared edge is unmet at startup — and it exists so that a project which
 * somehow reaches it gets a sentence rather than a stack trace.
 *
 * @param {{domains: any, modules: any, actor?: unknown, now?: () => string}} ctx
 */
export function successorActivation({ domains, modules, actor, now }) {
  try {
    return domains.capability({
      consumer: 'lifecycle',
      capability: SUCCESSOR_CAPABILITY.capability,
      version: SUCCESSOR_CAPABILITY.version,
      // `domains` travels with the context because the provider resolves its
      // OWN versioned activation policy through the registry. Lifecycle never
      // reads a contracts policy itself, and never names one it did not
      // receive as an explicit input.
      context: { modules, actor, now, domains },
    });
  } catch (error) {
    if (error instanceof AppError && error.status !== 404) throw error;
    throw new AppError(
      `The lifecycle package requires the contracts package capability ${SUCCESSOR_CAPABILITY.capability}@${SUCCESSOR_CAPABILITY.version}, which is not available`,
      { code: 'PACKAGE_DEPENDENCY_MISSING', status: 409 },
    );
  }
}

/** The run service, or a stable refusal naming what the project did not apply. */
function runService(modules, names) {
  const service = modules.get(names.run)?.service;
  if (!service?.createManaged) {
    throw new AppError(`The lifecycle package is installed without its "${names.run}" records`, {
      code: 'LIFECYCLE_STORAGE_INVALID', status: 500,
    });
  }
  return service;
}

/**
 * Every run recorded on one source agreement, oldest round first.
 *
 * An exact indexed read (`listWhere`, no page bound): the round number and the
 * open-run guard must both be complete, not the first 500 rows.
 */
function runsOf(runs, contractId) {
  return runs.listWhere({ sourceContractId: contractId })
    .sort((a, b) => a.round - b.round);
}

/** The one run that is still movable, if any. */
function openRun(rows) {
  return rows.find((row) => !AMENDMENT_TERMINAL.includes(row.state)) ?? null;
}

/** Whether an error is the framework's normalized unique-constraint refusal. */
function isUniqueConflict(error) {
  return error instanceof AppError && error.status === 409
    && /already exists|unique constraint/i.test(String(error.message));
}

/**
 * Derive the run state a plan result implies.
 *
 * `ready` means every refusal is gone. `awaiting_signed_order` means the only
 * refusals left are ones a **maturing order** resolves on its own — it has not
 * been signed yet, its snapshot is still being written, its components still
 * need a human classification. Anything else is a wrong pairing that waiting
 * will never fix, and the attach refuses outright rather than parking the run in
 * a state that quietly promises it might resolve.
 *
 * The maturity flag is computed by Contracts and travels on each refusal, so
 * this package never keeps a code list of its own that could drift from the one
 * that produces the refusals.
 *
 * @param {any} plan
 */
export function readinessFrom(plan) {
  if (plan.coherent) return { state: 'ready', gaps: [], blocking: [] };
  const blocking = plan.refusals.filter((entry) => !entry.resolvableByMaturity);
  return {
    state: 'awaiting_signed_order',
    gaps: plan.refusals.map((entry) => ({ code: entry.code, message: entry.message, resolvableByMaturity: entry.resolvableByMaturity })),
    blocking,
  };
}

/** The limitations every M16b surface repeats, so no reader has to find them. */
export const AMENDMENT_LIMITATIONS = Object.freeze([
  'NO_SCHEDULER — nothing here fires on a date; a run moves only when a human moves it',
  'NO_AUTOMATIC_RENEWAL — autoRenew and renewalNoticeDays are recorded only, on both provenances, and nothing acts on them',
  'NO_CUSTOMER_NOTIFICATION — no customer, signer or colleague is told that any of this happened',
  'NO_BILLING — no invoice, payment, tax, proration, usage rating or revenue recognition follows from an execution',
  'NO_RBAC — a human actor is an audit identity, not Sales, Legal or Finance role enforcement',
  'NO_RETROACTIVE_MUTATION — the source agreement, its version, its lines, its subscription and its obligations are never modified',
  'NO_CANCELLATION — succeeding an agreement is not cancelling it, and no cancellation primitive exists',
  'SIGNED_TERM_REQUIRED — a successor is built only from an order whose signed document carried the commercial term',
]);

/* ---------------------------------------------------------------- actions */

/**
 * `plan-amendment` — **writes nothing.**
 *
 * The whole answer in one read: which cycle is open on this agreement, which
 * signed order is a candidate, what the delta would be, what it would be
 * classified as, how the terms line up, and every reason execution would be
 * refused. No record, no audit entry, no domain event. The action runtime still
 * records a trace, which is the framework's existing policy for a read-shaped
 * action.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function buildPlanAmendmentAction(moduleNames) {
  const names = amendmentNames(moduleNames);
  return {
    module: names.contract,
    name: 'plan-amendment',
    label: 'Plan renewal or amendment',
    description:
      'Show what executing a successor commercial agreement from a candidate signed order would produce, and every reason it would be refused. Writes nothing and commits nobody.',
    actionContract: 1,
    input: [
      { name: 'successorOrderId', type: 'string', required: false, hint: 'The candidate signed Order. Defaults to the order attached to the open run, when there is one.' },
      { name: 'policy', type: 'string', required: false, hint: 'Registered order activation policy name — supply it to see the classification refusals execution would raise.' },
      { name: 'policyVersion', type: 'integer', required: false, hint: 'Explicit policy version; never an implicit latest.' },
      { name: 'classificationOverrides', type: 'json', required: false, hint: 'Preview overrides: [{orderComponentId, dimension, value, reason}].' },
    ],
    async execute({ record, input, actor, modules, domains, now }) {
      const runs = runService(modules, names);
      const history = runsOf(runs, record.id);
      const open = openRun(history);
      const candidate = optionalId(input.successorOrderId, 'successorOrderId') ?? open?.successorOrderId ?? null;
      const capability = successorActivation({ domains, modules, actor, now });

      const plan = candidate
        ? capability.planSuccession({
          sourceContractId: record.id,
          successorOrderId: candidate,
          policy: typeof input.policy === 'string' && input.policy !== '' ? input.policy : null,
          policyVersion: Number.isSafeInteger(input.policyVersion) ? input.policyVersion : null,
          classificationOverrides: input.classificationOverrides ?? null,
        })
        : null;

      return {
        amendmentPlanContract: 1,
        writes: 'nothing — this is a read-only plan',
        contractId: record.id,
        cycle: {
          rounds: history.length,
          openRun: open ? summarizeRun(open) : null,
          nextRound: open ? open.round : history.length + 1,
          rule:
            'at most one run is open on a contract at a time. A new round may be opened once the previous one is abandoned; '
            + 'a round that EXECUTED closes the agreement to further rounds permanently, because a contract is succeeded exactly once '
            + 'and the next round belongs to its successor',
        },
        candidateOrderId: candidate,
        // Every gap named, so an agent stops guessing what is missing.
        gaps: candidate ? [] : ['NO_CANDIDATE_ORDER'],
        succession: plan,
        stateMachine: { states: [...AMENDMENT_STATES], terminal: [...AMENDMENT_TERMINAL], transitions: AMENDMENT_TRANSITIONS },
        approvalRequired:
          'opening, attaching, executing and abandoning all require actor.type === "user". A human-actor boundary for audit, not RBAC',
        limitations: [...AMENDMENT_LIMITATIONS],
      };
    },
  };
}

/**
 * `open-amendment-run` — start a governed round on this agreement.
 *
 * It commits nothing commercial: opening a run creates no quote, no order, no
 * contract and no successor. It exists so that the work has an identity, a
 * reason and a terminal state, which is the lesson Delivery's handover and
 * M16a's follow-up both taught.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function buildOpenAmendmentRunAction(moduleNames) {
  const names = amendmentNames(moduleNames);
  return {
    module: names.contract,
    name: 'open-amendment-run',
    label: 'Open amendment run',
    description:
      'Open a governed renewal or amendment round on this contract. Creates no quote, order, contract or successor, and changes no signed record.',
    actionContract: 1,
    confirm: true,
    input: [
      { name: 'reason', type: 'string', required: true, hint: 'Why this round is being opened. Recorded with it.' },
      { name: 'decisionId', type: 'string', required: false, hint: 'The M16a renewal decision this follows from, when there is one.' },
      { name: 'followupId', type: 'string', required: false, hint: 'The M16a commercial follow-up this follows from, when there is one.' },
      { name: 'asOf', type: 'string', required: false, hint: 'The calendar date the round was opened against, YYYY-MM-DD. Recorded only; nothing fires on it.' },
    ],
    async execute({ record, input, actor, modules, domains, now }) {
      const openedBy = requireHuman(actor, 'Opening an amendment run');
      const reason = requireText(input.reason, 'reason');
      const decisionId = optionalId(input.decisionId, 'decisionId');
      const followupId = optionalId(input.followupId, 'followupId');
      if (input.asOf !== undefined && input.asOf !== null) requireCalendarDate(input.asOf, 'asOf');

      const capability = successorActivation({ domains, modules, actor, now });
      const existing = capability.succession(record.id);
      if (existing) {
        throw new AppError(
          'This contract already has a successor agreement; a contract is succeeded exactly once, and the next round belongs to its successor',
          { code: 'CONFLICTING_SUCCESSOR', status: 409, details: { successionId: existing.id, successorContractId: existing.successorContractId } },
        );
      }
      if (decisionId) {
        const decisions = modules.get(names.decision)?.service;
        const found = decisions?.listWhere({ contractId: record.id }).find((row) => row.id === decisionId);
        if (!found) throw new ValidationError('decisionId does not name a decision recorded on this contract', { field: 'decisionId' });
      }
      if (followupId) {
        const followups = modules.get(names.followup)?.service;
        const found = followups?.listWhere({ contractId: record.id }).find((row) => row.id === followupId);
        if (!found) throw new ValidationError('followupId does not name a follow-up recorded on this contract', { field: 'followupId' });
      }

      const runs = runService(modules, names);
      const history = runsOf(runs, record.id);
      const open = openRun(history);
      const submitted = { reason, decisionId, followupId };
      if (open) {
        // An identical repeat answers with the run it already opened: a client
        // whose response was lost must be able to reach the record it created.
        // A DIFFERENT ask is refused, naming the fields that differ, because
        // recorded intent is never silently overwritten.
        return replayOrConflict(open, submitted, {
          code: 'AMENDMENT_RUN_ALREADY_OPEN',
          what: `An amendment run on this contract (round ${open.round}, ${open.state})`,
        });
      }

      const round = history.length + 1;
      const sourceKey = amendmentRunKey(record.id, round);
      const openedAt = now();
      const patch = {
        sourceKey,
        sourceContractId: record.id,
        round,
        state: 'planned',
        ...submitted,
        successorOrderId: null,
        readinessGapsJson: null,
        readinessObservedAt: null,
        observedClassification: null,
        openedBy,
        openedAt,
        attachedBy: null,
        attachedAt: null,
        successionId: null,
        successorContractId: null,
        executedClassification: null,
        executedBy: null,
        executedAt: null,
        abandonReason: null,
        abandonedBy: null,
        abandonedAt: null,
      };
      try {
        return await runs.createManaged(patch, { actor });
      } catch (error) {
        // Two connections computed the same round and the unique constraint
        // picked the winner. The loser answers from the winner's row rather
        // than from a driver error.
        if (!isUniqueConflict(error)) throw error;
        const raced = runs.listWhere({ sourceKey })[0];
        if (!raced) throw error;
        return replayOrConflict(raced, submitted, {
          code: 'AMENDMENT_RUN_ALREADY_OPEN',
          what: `An amendment run on this contract (round ${raced.round}, ${raced.state})`,
        });
      }
    },
  };
}

/**
 * `attach-successor-order` — name the candidate signed Order, and record what
 * the evidence says about it right now.
 *
 * The recorded readiness is **an observation with a timestamp**, not a licence.
 * A pairing that a maturing order can still fix parks the run in
 * `awaiting_signed_order` with the gaps named; a pairing nothing will ever fix —
 * the wrong customer, an order already consumed, a successor that predates its
 * source — is refused here rather than parked, because parking it would promise
 * a resolution that cannot arrive.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function buildAttachSuccessorOrderAction(moduleNames) {
  const names = amendmentNames(moduleNames);
  return {
    module: names.run,
    name: 'attach-successor-order',
    label: 'Attach successor order',
    description:
      'Name the candidate signed Order for this round and record what the evidence says about it. Records an observation; authorises nothing and creates no successor.',
    actionContract: 1,
    confirm: true,
    input: [
      { name: 'successorOrderId', type: 'string', required: true, hint: 'The signed immutable Order the successor agreement would be built from.' },
      { name: 'policy', type: 'string', required: false, hint: 'Registered order activation policy name — supply it so classification gaps are observed too.' },
      { name: 'policyVersion', type: 'integer', required: false, hint: 'Explicit policy version.' },
    ],
    async execute({ record, input, actor, modules, domains, managed, now }) {
      requireHuman(actor, 'Attaching a successor order');
      const successorOrderId = requireText(input.successorOrderId, 'successorOrderId', MAX_ID);
      requireMovable(record);

      const capability = successorActivation({ domains, modules, actor, now });
      const plan = capability.planSuccession({
        sourceContractId: record.sourceContractId,
        successorOrderId,
        policy: typeof input.policy === 'string' && input.policy !== '' ? input.policy : null,
        policyVersion: Number.isSafeInteger(input.policyVersion) ? input.policyVersion : null,
      });
      const readiness = readinessFrom(plan);
      if (readiness.blocking.length > 0) {
        const first = readiness.blocking[0];
        throw new AppError(first.message, {
          code: first.code,
          status: first.status,
          ...(first.details ? { details: { ...first.details } } : {}),
        });
      }
      const attachedAt = now();
      return managed(record.id, {
        successorOrderId,
        state: readiness.state,
        readinessGapsJson: JSON.stringify(readiness.gaps),
        readinessObservedAt: attachedAt,
        observedClassification: plan.classification ?? null,
        attachedBy: String(/** @type {any} */ (actor).id ?? 'unknown'),
        attachedAt,
      });
    },
  };
}

/**
 * `execute-amendment` — the one action that creates a successor agreement.
 *
 * Human-only, and **authoritative**: it trusts nothing the caller computed and
 * nothing the run recorded. Every fact — the signature evidence, the signed
 * term, the customer, the delta, the classification, the term continuity and
 * every refusal — is recomputed by Contracts inside this transaction. A run that
 * read `ready` an hour ago is refused if the evidence moved since.
 *
 * One transaction produces the successor Contract, its version and lines, its
 * Subscription and lines, its pending obligations, the immutable lineage row and
 * the run's move to `executed`. There is no partial successor: a failure
 * anywhere rolls all of it back.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function buildExecuteAmendmentAction(moduleNames) {
  const names = amendmentNames(moduleNames);
  return {
    module: names.run,
    name: 'execute-amendment',
    label: 'Execute renewal or amendment',
    description:
      'Create the successor commercial agreement from the attached signed Order, with immutable lineage to the agreement it replaces (human decision). Recomputes every fact authoritatively; bills, notifies, schedules and cancels nothing.',
    actionContract: 1,
    confirm: true,
    input: [
      { name: 'policy', type: 'string', required: true, hint: 'Registered order activation policy name.' },
      { name: 'policyVersion', type: 'integer', required: true, hint: 'Explicit policy version — never an implicit latest.' },
      { name: 'successorOrderId', type: 'string', required: false, hint: 'Must equal the order attached to this run when supplied; the attached order is authoritative.' },
      { name: 'classificationOverrides', type: 'json', required: false, hint: '[{orderComponentId, dimension, value, reason}] — a human decision per undecided axis, with a reason.' },
    ],
    async execute({ record, input, actor, modules, domains, managed, now, step }) {
      const executedBy = requireHuman(actor, 'Executing a renewal or amendment');
      const asked = optionalId(input.successorOrderId, 'successorOrderId');
      const capability = successorActivation({ domains, modules, actor, now });

      if (record.state === 'executed') {
        // The retry that used to be punished. A client whose response was lost
        // repeats the identical ask and gets the result it already produced;
        // an ask naming a DIFFERENT order is refused with what was recorded.
        if (asked && asked !== record.successorOrderId) {
          throw new AppError(
            'This run already executed against a different successor order; it is not re-executed and nothing is overwritten',
            { code: 'AMENDMENT_RUN_TERMINAL', status: 409, details: { recordedSuccessorOrderId: record.successorOrderId, requested: asked } },
          );
        }
        const recorded = capability.succession(record.sourceContractId);
        return {
          replay: true,
          runId: record.id,
          state: record.state,
          succession: recorded,
          successorContractId: record.successorContractId,
          classification: record.executedClassification,
          note: 'this run had already executed; the recorded result is returned unchanged and nothing was written',
        };
      }
      if (record.state === 'abandoned') {
        throw new AppError('This amendment run was abandoned and does not move again', {
          code: 'AMENDMENT_RUN_TERMINAL', status: 409, details: { state: record.state },
        });
      }
      if (record.state !== 'ready') {
        throw new AppError(
          `This amendment run is ${record.state}: a successor is executed only from "ready", and readiness is re-proved here rather than trusted`,
          { code: 'AMENDMENT_RUN_NOT_READY', status: 409, details: { state: record.state, allowedFrom: 'ready' } },
        );
      }
      if (!record.successorOrderId) {
        throw new AppError('This amendment run has no attached successor order', {
          code: 'AMENDMENT_RUN_NOT_READY', status: 409, details: { state: record.state },
        });
      }
      if (asked && asked !== record.successorOrderId) {
        throw new ValidationError('successorOrderId does not match the order attached to this run', { field: 'successorOrderId' });
      }

      const result = await capability.executeSuccession({
        sourceContractId: record.sourceContractId,
        successorOrderId: record.successorOrderId,
        policy: input.policy,
        policyVersion: input.policyVersion,
        classificationOverrides: input.classificationOverrides ?? null,
        // The run's own id is the execution's identity — no clock is in it, and
        // the lineage row's UNIQUE column on it means one run can never produce
        // two successors.
        executionRef: executionRefOf(record.id),
        actor,
      });

      const executedAt = now();
      const run = await managed(record.id, {
        state: 'executed',
        successionId: result.succession.id,
        successorContractId: result.successorContractId,
        executedClassification: result.classification,
        executedBy,
        executedAt,
      });

      step('amendment.executed', {
        runId: run.id,
        sourceContractId: record.sourceContractId,
        successorContractId: result.successorContractId,
        classification: result.classification,
        termContinuity: result.termContinuity,
      });

      return {
        replay: false,
        runId: run.id,
        state: run.state,
        succession: result.succession,
        successorContractId: result.successorContractId,
        successorContractVersionId: result.successorContractVersionId,
        successorSubscriptionId: result.successorSubscriptionId,
        successorStatus: result.successorStatus,
        counts: result.counts,
        classification: result.classification,
        classificationBasis: result.classificationBasis,
        termContinuity: result.termContinuity,
        termGapDays: result.termGapDays,
        delta: result.delta,
        limitations: [...AMENDMENT_LIMITATIONS],
      };
    },
  };
}

/**
 * `abandon-amendment-run` — the exit.
 *
 * A handoff with no terminal transition becomes a queue of things nobody can
 * close, which is the lesson Delivery's handover taught and M16a repeated. An
 * abandoned round is terminal and never reopens; a new round may be opened on
 * the same agreement, which is how genuinely repeated future work stays
 * distinguishable instead of being collapsed into one row.
 *
 * Abandoning is **not** a cancellation, a non-renewal or a churn event, and it
 * changes nothing commercial.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function buildAbandonAmendmentRunAction(moduleNames) {
  const names = amendmentNames(moduleNames);
  return {
    module: names.run,
    name: 'abandon-amendment-run',
    label: 'Abandon amendment run',
    description:
      'Close this round without executing it, with a human reason. Cancels nothing, ends nothing and changes no commercial record; a new round may be opened afterwards.',
    actionContract: 1,
    confirm: true,
    input: [
      { name: 'reason', type: 'string', required: true, hint: 'Why the round was abandoned.' },
    ],
    async execute({ record, input, actor, managed, now }) {
      const abandonedBy = requireHuman(actor, 'Abandoning an amendment run');
      const reason = requireText(input.reason, 'reason');
      requireMovable(record);
      return managed(record.id, {
        state: 'abandoned',
        abandonReason: reason,
        abandonedBy,
        abandonedAt: now(),
      });
    },
  };
}

/* ---------------------------------------------------------------- helpers */

/** A terminal run never moves again, and says which terminal state it reached. */
function requireMovable(record) {
  if (AMENDMENT_TERMINAL.includes(record.state)) {
    throw new AppError(`This amendment run is ${record.state} and does not move again`, {
      code: 'AMENDMENT_RUN_TERMINAL', status: 409, details: { state: record.state },
    });
  }
}

/**
 * The idempotent replay rule, in the shape M16a established: an identical
 * repeat returns the existing record; a repeat that differs is refused 409
 * naming the diverging fields, so recorded intent is never overwritten and the
 * refusal says what to look at.
 *
 * @param {any} existing @param {Record<string, unknown>} submitted
 * @param {{code: string, what: string}} options
 */
export function replayOrConflict(existing, submitted, { code, what }) {
  const conflictingFields = Object.keys(submitted)
    .filter((field) => (existing[field] ?? null) !== (submitted[field] ?? null))
    .sort();
  if (conflictingFields.length === 0) return existing;
  throw new AppError(
    `${what} is already open with a different ${conflictingFields.join(' and ')}; it is not overwritten. `
      + 'Read the existing run, or abandon it first.',
    { code, status: 409, details: { conflictingFields, existingId: existing.id } },
  );
}

/** The public shape of a run inside a plan payload. */
function summarizeRun(run) {
  return {
    id: run.id,
    round: run.round,
    state: run.state,
    reason: run.reason,
    successorOrderId: run.successorOrderId ?? null,
    observedClassification: run.observedClassification ?? null,
    readinessObservedAt: run.readinessObservedAt ?? null,
    readinessGaps: parseGaps(run.readinessGapsJson),
    successionId: run.successionId ?? null,
    successorContractId: run.successorContractId ?? null,
    openedBy: run.openedBy,
    openedAt: run.openedAt,
    note: 'the recorded state is an observation of the evidence at readinessObservedAt, never an authorisation: execution recomputes all of it',
  };
}

/** @param {unknown} text */
export function parseGaps(text) {
  if (typeof text !== 'string' || text === '') return [];
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** @param {Record<string, string>} [moduleNames] */
export function buildAmendmentActions(moduleNames) {
  return [
    buildPlanAmendmentAction(moduleNames),
    buildOpenAmendmentRunAction(moduleNames),
    buildAttachSuccessorOrderAction(moduleNames),
    buildExecuteAmendmentAction(moduleNames),
    buildAbandonAmendmentRunAction(moduleNames),
  ];
}
