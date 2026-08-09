// @ts-check

import { AppError, ValidationError, definePackage, nowIso } from '../../core/index.js';

/**
 * **M16a — Renewal & Expansion Operations.**
 *
 * The operational lifecycle *after* activation: what is coming up for renewal,
 * what a human decided about it, and what Commercial has been asked to do
 * next. Named `lifecycle` rather than `renewals` because non-renewal,
 * expansion and contraction all live here and none of them is a renewal.
 *
 * **What it deliberately cannot do, and why.** A real amendment changes what
 * was agreed: a new signed instrument, re-priced lines, a new order. Pricing
 * lives in Commercial and signature in Signature, and both are still inside
 * `packages/core` with no capability to reach them. Building amendment
 * execution here would need a private import — exactly what the package seam
 * refuses — so M16a stops where those domains begin and hands off instead.
 * That is M16b, and it is deferred by decision rather than forgotten.
 *
 * **The truth problem this package must not create.** M12 records activation
 * terms as *operational metadata*; `termsSource` exists because those dates
 * may never have been signed. So nothing here says "renewed", "cancelled" or
 * "churned". A decision is *intent evidence*, a term is *term evidence*, and
 * every date it reports carries the provenance it came with.
 */

export const LIFECYCLE_PACKAGE = 'lifecycle';
export const LIFECYCLE_RESOURCES = Object.freeze(['renewal-decision', 'commercial-followup']);
export const SOURCE_CAPABILITY = Object.freeze({ package: 'contracts', capability: 'contract-lifecycle-source', version: 1 });

export const DECISIONS = Object.freeze(['pursue_renewal', 'not_renewing', 'needs_changes', 'undecided']);
export const INTENTS = Object.freeze(['renewal', 'expansion', 'contraction', 'pricing_change', 'scope_change']);
export const FOLLOWUP_OPEN = 'pending_commercial_followup';
export const FOLLOWUP_TERMINAL = Object.freeze(['resolved_externally', 'withdrawn']);

const MAX_REASON = 300;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** @param {Record<string, string>} [moduleNames] */
function resolvedNames(moduleNames = {}) {
  return {
    contract: moduleNames['commercial-contract'] ?? 'commercial-contract',
    decision: moduleNames['renewal-decision'] ?? 'renewal-decision',
    followup: moduleNames['commercial-followup'] ?? 'commercial-followup',
  };
}

/** @param {{domains: any, modules: any, actor?: unknown, now?: () => string}} ctx */
function lifecycleSource({ domains, modules, actor, now }) {
  try {
    return domains.capability({
      consumer: LIFECYCLE_PACKAGE,
      capability: SOURCE_CAPABILITY.capability,
      version: SOURCE_CAPABILITY.version,
      context: { modules, actor, now },
    });
  } catch (error) {
    if (error instanceof AppError && error.status !== 404) throw error;
    throw new AppError(
      'The lifecycle package requires the contracts package capability contract-lifecycle-source@1, which is not available',
      { code: 'PACKAGE_DEPENDENCY_MISSING', status: 409 },
    );
  }
}

/**
 * A **real** calendar date, returned canonically.
 *
 * The shape is not the check. JavaScript turns `2027-02-30` into March 2 and
 * `2027-06-31` into July 1, so a value that matches `YYYY-MM-DD` can still name
 * a day that never existed. Accepting one stores evidence twice over wrong: the
 * `asOfDate` on the record is a date nobody could have decided anything on, and
 * the `daysToBoundary` beside it is measured from a *different* day — a record
 * whose own two fields disagree.
 *
 * M12 already refuses this for the term dates (`requireCalendarDate` in the
 * contracts package). The rule is repeated rather than imported because a
 * package reaches another only through a declared capability, and a shared
 * date-validation helper is not what `contract-lifecycle-source@1` is for.
 *
 * @param {unknown} value @param {string} field
 */
export function requireCalendarDate(value, field) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new ValidationError(`${field} must be a calendar date (YYYY-MM-DD)`, { field });
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ValidationError(`${field} is not a real calendar date`, { field });
  }
  return value;
}

/** A bounded, control-character-free human reason. */
export function requireReason(value, field = 'reason') {
  if (typeof value !== 'string') throw new ValidationError(`${field} is required`, { field });
  const trimmed = value.trim();
  if (trimmed === '') throw new ValidationError(`${field} is required`, { field });
  if (trimmed.length > MAX_REASON) {
    throw new ValidationError(`${field} must be at most ${MAX_REASON} characters`, { field });
  }
  if (CONTROL_RE.test(trimmed)) {
    throw new ValidationError(`${field} must not contain control characters or line breaks`, { field });
  }
  return trimmed;
}

/** @param {unknown} actor */
function requireHuman(actor, what) {
  if (!actor || /** @type {any} */ (actor).type !== 'user') {
    throw new AppError(`${what} is a human decision`, { code: 'HUMAN_APPROVAL_REQUIRED', status: 403 });
  }
  return String(/** @type {any} */ (actor).id ?? 'unknown');
}

/**
 * Whole days from `asOf` to an **inclusive** term end date.
 *
 * Inclusive is the M12 convention and it decides the arithmetic: a term ending
 * on the 31st is live *on* the 31st, so that day is 0 days to the boundary and
 * the 30th is 1 — not the other way round. A term that already ended is
 * negative, and reported as ended rather than as a renewal opportunity.
 *
 * @param {string} asOf @param {string} endDate
 */
export function daysToBoundary(asOf, endDate) {
  // A date that is not a real day yields null rather than a confident number
  // measured from whatever JavaScript rolled it over to.
  if (!isRealCalendarDate(asOf) || !isRealCalendarDate(endDate)) return null;
  const from = Date.parse(`${asOf}T00:00:00.000Z`);
  const to = Date.parse(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

/** @param {unknown} value */
function isRealCalendarDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Group a commercial baseline **honestly**: by currency and recurrence, never
 * as one number. Summing a one-time fee with a monthly charge produces a figure
 * that is not money, and summing across currencies produces one that is a lie —
 * there is no FX here and there will not be one.
 *
 * @param {any[]} lines
 */
export function groupBaseline(lines) {
  const groups = new Map();
  for (const line of lines) {
    const key = `${line.currency}|${line.chargeType}|${line.interval ?? 'none'}`;
    const existing = groups.get(key) ?? {
      currency: line.currency, chargeType: line.chargeType, interval: line.interval ?? null,
      lineCount: 0, netAmountCents: 0,
    };
    existing.lineCount += 1;
    existing.netAmountCents += Number.isSafeInteger(line.netAmountCents) ? line.netAmountCents : 0;
    groups.set(key, existing);
  }
  return [...groups.values()].sort((a, b) => {
    const byCurrency = a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0;
    if (byCurrency !== 0) return byCurrency;
    const byCharge = a.chargeType < b.chargeType ? -1 : a.chargeType > b.chargeType ? 1 : 0;
    return byCharge !== 0 ? byCharge : String(a.interval).localeCompare(String(b.interval));
  });
}

/** What is missing from the evidence, named so an agent stops guessing. */
export function evidenceGaps(source) {
  const gaps = [];
  if (!source.term.endDate) gaps.push('NO_TERM_END_DATE');
  if (!source.term.source) gaps.push('NO_DECLARED_TERM_SOURCE');
  if (!source.currentVersionId) gaps.push('NO_CURRENT_CONTRACT_VERSION');
  return gaps.sort();
}

/**
 * `plan-renewal` — **writes nothing.**
 *
 * A read-only computation over evidence that already exists. It is deliberately
 * not a workflow step and creates no record: an agent must be able to ask "what
 * is coming up and on what basis" without committing anybody to anything.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function buildPlanRenewalAction(moduleNames) {
  const names = resolvedNames(moduleNames);
  return {
    module: names.contract,
    name: 'plan-renewal',
    label: 'Plan renewal',
    description:
      'Read this contract\'s term evidence, its commercial baseline and the gaps in both, as of a given date. Writes nothing and commits nobody.',
    actionContract: 1,
    input: [
      { name: 'asOf', type: 'string', required: true, hint: 'A calendar date, YYYY-MM-DD. The clock is injected, never read from the wall.' },
      { name: 'windowDays', type: 'integer', required: false, hint: 'How far ahead a boundary counts as upcoming. Defaults to 90.' },
    ],
    async execute({ record, input, actor, modules, domains, now }) {
      requireCalendarDate(input.asOf, 'asOf');
      const windowDays = Number.isSafeInteger(input.windowDays) && input.windowDays > 0 ? input.windowDays : 90;
      const source = lifecycleSource({ domains, modules, actor, now });
      const evidence = source.termEvidence(record.id);
      if (!evidence) {
        throw new AppError('This contract has no readable term evidence', { code: 'CONTRACT_NOT_READABLE', status: 404 });
      }
      const days = evidence.term.endDate ? daysToBoundary(input.asOf, evidence.term.endDate) : null;
      const lines = source.listContractLines(record.id);
      const subscriptionLines = source.listSubscriptionLines(record.id);

      return {
        lifecyclePlanContract: 1,
        writes: 'nothing — this is a read-only plan',
        contractId: evidence.contractId,
        asOf: input.asOf,
        windowDays,
        term: evidence.term,
        boundary: {
          daysToBoundary: days,
          // Three honest states, and "ended" is not an opportunity.
          category: days === null ? 'unknown'
            : days < 0 ? 'term_already_ended'
              : days <= windowDays ? 'within_window' : 'beyond_window',
          endDateIsInclusive: true,
        },
        baseline: {
          note: 'grouped by currency and recurrence. Never summed into one number: a one-time fee and a monthly charge are not the same kind of money, and no FX is applied',
          groups: groupBaseline(lines),
          contractLineCount: lines.length,
          subscriptionLineCount: subscriptionLines.length,
        },
        evidenceGaps: evidenceGaps(evidence),
        approvalRequired: 'recording a decision, an intent, a follow-up or a successor all require actor.type === "user"',
        limitations: [
          'NO_SCHEDULER — nothing fires on a boundary; this is asked, never pushed',
          'NOT_A_LEGAL_RENEWAL — no automatic or legal renewal is modelled or claimed',
          'TERMS_MAY_BE_UNSIGNED — see term.source; activation terms are operational metadata',
          'NO_REVENUE_RECOGNITION — no ARR, MRR, TCV or forecast is computed',
        ],
      };
    },
  };
}

/**
 * `record-renewal-decision` — immutable intent evidence.
 *
 * Note what it does **not** do: it never touches the contract. A decision to
 * pursue is not a renewal, and a decision not to renew is not a cancellation —
 * it is a person saying what they intend, recorded so that later work has a
 * reason attached to it.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function buildRecordRenewalDecisionAction(moduleNames) {
  const names = resolvedNames(moduleNames);
  return {
    module: names.contract,
    name: 'record-renewal-decision',
    label: 'Record renewal decision',
    description:
      'Record a human decision about this contract\'s upcoming term boundary. Intent evidence: it renews nothing, ends nothing and cancels nothing.',
    actionContract: 1,
    confirm: true,
    input: [
      { name: 'decision', type: 'enum', values: [...DECISIONS], required: true },
      { name: 'reason', type: 'string', required: true, hint: 'Why. Recorded with the decision and required for every value.' },
      { name: 'asOf', type: 'string', required: true, hint: 'The date the decision was taken against, YYYY-MM-DD.' },
    ],
    async execute({ record, input, actor, modules, domains, now }) {
      const decidedBy = requireHuman(actor, 'Recording a renewal decision');
      const reason = requireReason(input.reason);
      requireCalendarDate(input.asOf, 'asOf');
      const source = lifecycleSource({ domains, modules, actor, now });
      const evidence = source.termEvidence(record.id);
      if (!evidence) {
        throw new AppError('This contract has no readable term evidence', { code: 'CONTRACT_NOT_READABLE', status: 404 });
      }
      const decisions = modules.get(names.decision)?.service;
      if (!decisions?.createManaged) {
        throw new AppError(`The lifecycle package is installed without its "${names.decision}" records`, {
          code: 'LIFECYCLE_STORAGE_INVALID', status: 500,
        });
      }
      const decidedAt = now();
      return decisions.createManaged({
        // One decision per contract per date: a second one on the same day is a
        // 409, not a silent overwrite of somebody's recorded intent.
        sourceKey: `renewal-decision:${record.id}:${input.asOf}`,
        contractId: record.id,
        decision: input.decision,
        reason,
        asOfDate: input.asOf,
        termEndDate: evidence.term.endDate ?? null,
        termSource: evidence.term.source ?? null,
        daysToBoundary: evidence.term.endDate ? daysToBoundary(input.asOf, evidence.term.endDate) : null,
        planFingerprint: null,
        decidedBy,
        decidedAt,
      }, { actor });
    },
  };
}

/**
 * `request-commercial-followup` — the governed handoff.
 *
 * It is a **request**, never an instruction. It creates no quote, no order and
 * no contract, and it mutates no signed record: Commercial does that work, as
 * humans, through its own surface. This exists so the ask is recorded with its
 * reason and its baseline instead of living in somebody's inbox.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function buildRequestCommercialFollowupAction(moduleNames) {
  const names = resolvedNames(moduleNames);
  return {
    module: names.contract,
    name: 'request-commercial-followup',
    label: 'Request commercial follow-up',
    description:
      'Ask Commercial to pick up renewal, expansion, contraction, pricing or scope work arising from a recorded decision. Creates nothing commercial and changes no signed record.',
    actionContract: 1,
    confirm: true,
    input: [
      { name: 'intent', type: 'enum', values: [...INTENTS], required: true },
      { name: 'summary', type: 'string', required: true, hint: 'What is being asked for, in one line.' },
      { name: 'decisionId', type: 'string', required: false, hint: 'The recorded decision this follows from, when there is one.' },
    ],
    async execute({ record, input, actor, modules, domains, now }) {
      const requestedBy = requireHuman(actor, 'Requesting commercial follow-up');
      const summary = requireReason(input.summary, 'summary');
      const source = lifecycleSource({ domains, modules, actor, now });
      const evidence = source.termEvidence(record.id);
      if (!evidence) {
        throw new AppError('This contract has no readable term evidence', { code: 'CONTRACT_NOT_READABLE', status: 404 });
      }
      const decisions = modules.get(names.decision)?.service;
      if (input.decisionId) {
        const decision = decisions?.listWhere({ contractId: record.id })
          .find((row) => row.id === input.decisionId);
        if (!decision) {
          throw new ValidationError('decisionId does not name a decision recorded on this contract', { field: 'decisionId' });
        }
      }
      const followups = modules.get(names.followup)?.service;
      if (!followups?.createManaged) {
        throw new AppError(`The lifecycle package is installed without its "${names.followup}" records`, {
          code: 'LIFECYCLE_STORAGE_INVALID', status: 500,
        });
      }
      // An OPEN follow-up of the same intent is not duplicated. A resolved one
      // does not block a new ask — the work genuinely came round again.
      //
      // Both reads are exact (`listWhere`, no page bound): the guard and the
      // round number below must be complete, not the first 500 rows.
      const history = followups.listWhere({ contractId: record.id, intent: input.intent });
      const open = history.filter((row) => row.status === FOLLOWUP_OPEN);
      if (open.length > 0) {
        throw new AppError(`A ${input.intent} follow-up is already pending on this contract`, {
          code: 'FOLLOWUP_ALREADY_PENDING', status: 409,
        });
      }
      const lines = source.listContractLines(record.id);
      const groups = groupBaseline(lines);
      const requestedAt = now();
      return followups.createManaged({
        // The key is (contract, intent, round) — derived from state, never from
        // the clock. A timestamp here looked like an idempotency key and was
        // not one: under an injected clock two rounds collide forever, so the
        // second genuine ask was refused 409 for all time; under a wall clock
        // every call produces a different key, so it identified nothing and
        // guarded nothing. The round number is deterministic, lets the work
        // come round again exactly as documented, and makes the unique
        // constraint a real second line of defence behind the pending check.
        sourceKey: `commercial-followup:${record.id}:${input.intent}:${history.length + 1}`,
        contractId: record.id,
        decisionId: input.decisionId ?? null,
        intent: input.intent,
        status: FOLLOWUP_OPEN,
        summary,
        // One currency only when the baseline has exactly one; otherwise none,
        // because a mixed-currency total is not a number anybody should act on.
        currency: groups.length > 0 && groups.every((g) => g.currency === groups[0].currency) ? groups[0].currency : null,
        baselineNetAmountCents: groups.length === 1 ? groups[0].netAmountCents : null,
        requestedBy,
        requestedAt,
        resolutionReason: null,
        resolvedBy: null,
        resolvedAt: null,
      }, { actor });
    },
  };
}

/**
 * `resolve-commercial-followup` — the exit.
 *
 * Delivery's handover taught this: a handoff with no terminal transition
 * becomes a queue of things nobody can close, and the record stops meaning
 * anything. Every follow-up can be resolved or withdrawn, and both require a
 * human reason.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function buildResolveCommercialFollowupAction(moduleNames) {
  const names = resolvedNames(moduleNames);
  return {
    module: names.followup,
    name: 'resolve-commercial-followup',
    label: 'Resolve commercial follow-up',
    description:
      'Close a pending follow-up as resolved elsewhere or withdrawn, with a human reason. Records the outcome; performs no commercial work.',
    actionContract: 1,
    confirm: true,
    stateField: 'status',
    fromStates: [FOLLOWUP_OPEN],
    input: [
      { name: 'outcome', type: 'enum', values: [...FOLLOWUP_TERMINAL], required: true },
      { name: 'reason', type: 'string', required: true },
    ],
    async execute({ record, input, actor, managed, now }) {
      const resolvedBy = requireHuman(actor, 'Resolving a commercial follow-up');
      const reason = requireReason(input.reason);
      if (record.status !== FOLLOWUP_OPEN) {
        throw new AppError(`This follow-up is already ${record.status}`, { code: 'FOLLOWUP_NOT_PENDING', status: 409 });
      }
      return managed(record.id, {
        status: input.outcome,
        resolutionReason: reason,
        resolvedBy,
        resolvedAt: now(),
      });
    },
  };
}

/** @param {{modules?: Record<string, string>}} [options] */
export function createLifecyclePackage(options = {}) {
  return definePackage({
    packageContract: 1,
    name: LIFECYCLE_PACKAGE,
    version: 1,
    label: 'Renewal and expansion operations',
    description:
      'Reads a contract\'s term evidence, records human renewal and expansion intent, and hands governed follow-up work to Commercial. Renews nothing, cancels nothing and signs nothing.',
    resources: [...LIFECYCLE_RESOURCES],
    requires: [{ ...SOURCE_CAPABILITY }],
    capabilities: [],
    actions: [
      buildPlanRenewalAction(options.modules),
      buildRecordRenewalDecisionAction(options.modules),
      buildRequestCommercialFollowupAction(options.modules),
      buildResolveCommercialFollowupAction(options.modules),
    ],
    policies: [],
    metadata() {
      return {
        lifecycleContract: 1,
        decisions: [...DECISIONS],
        intents: [...INTENTS],
        followupStates: { open: FOLLOWUP_OPEN, terminal: [...FOLLOWUP_TERMINAL] },
        humanApproval:
          'every writing action requires actor.type === "user"; agent actors are refused 403 HUMAN_APPROVAL_REQUIRED. A human-actor boundary, not RBAC',
        termProvenance:
          'term dates come from M12 activation metadata and may never have been signed. Every date is reported with its declared source, and none of them is a signed renewal term',
        wording: {
          recorded: ['renewal decision recorded', 'non-renewal intent recorded', 'commercial follow-up requested'],
          neverClaimed: ['renewed', 'amended', 'cancelled', 'churned', 'invoiced', 'signed'],
        },
        notModeled: [
          'amendment execution', 'quoting', 'pricing', 'signature', 'billing', 'invoicing',
          'cancellation', 'churn analytics', 'revenue recognition', 'ARR/MRR/TCV', 'FX',
          'outreach', 'scheduling', 'automatic or legal renewal',
        ],
        limitation:
          'M16a plans and records. Commercial amendment execution is M16b and waits on Commercial and Signature becoming reachable through capabilities',
      };
    },
  });
}
