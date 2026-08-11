// @ts-check

import {
  AppError, ValidationError, calendarDaysBetween, definePackage, requireCalendarDate,
} from '../../core/index.js';

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
export const SOURCE_CAPABILITY = Object.freeze({ package: 'contracts', capability: 'contract-lifecycle-source', version: 2 });

export const DECISIONS = Object.freeze(['pursue_renewal', 'not_renewing', 'needs_changes', 'undecided']);
export const INTENTS = Object.freeze(['renewal', 'expansion', 'contraction', 'pricing_change', 'scope_change']);
export const FOLLOWUP_OPEN = 'pending_commercial_followup';
export const FOLLOWUP_TERMINAL = Object.freeze(['resolved_externally', 'withdrawn']);

const MAX_REASON = 300;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

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
      `The lifecycle package requires the contracts package capability ${SOURCE_CAPABILITY.capability}@${SOURCE_CAPABILITY.version}, which is not available`,
      { code: 'PACKAGE_DEPENDENCY_MISSING', status: 409 },
    );
  }
}

/**
 * A **real** calendar date, returned canonically — the framework's one
 * round-trip authority, re-exported so this package's callers ask exactly the
 * question every other package asks.
 *
 * The shape is not the check. JavaScript turns `2027-02-30` into March 2 and
 * `2027-06-31` into July 1, so a value that matches `YYYY-MM-DD` can still name
 * a day that never existed. Accepting one stores evidence twice over wrong: the
 * `asOfDate` on the record is a date nobody could have decided anything on, and
 * the `daysToBoundary` beside it is measured from a *different* day — a record
 * whose own two fields disagree. Against a real database it is worse than
 * untidy: two contradicting decisions taken on `2027-02-28` and `2027-02-30`
 * both persist under different keys while naming the same real day, defeating
 * this package's own "one decision per contract per date" promise.
 *
 * M12 refuses the same thing for its term dates. The rule was independently
 * re-implemented in four packages before it moved to `packages/core`; a
 * validator is a runtime primitive with no domain vocabulary in it, so sharing
 * it is not a package reaching across the seam (ADR-018).
 */
export { requireCalendarDate };

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
  return calendarDaysBetween(asOf, endDate);
}

/**
 * Group a commercial baseline **honestly**: by currency and by the full
 * recurrence, never as one number. Summing a one-time fee with a monthly charge
 * produces a figure that is not money, and summing across currencies produces
 * one that is a lie — there is no FX here and there will not be one.
 *
 * **`intervalCount` is part of the recurrence, not decoration.** M12 expresses
 * quarterly as `interval: 'month', intervalCount: 3` and semi-annual as
 * `intervalCount: 6`. Grouping on `interval` alone folded €400 quarterly into
 * the same row as €400 monthly — a three-fold overstatement of the baseline
 * Commercial reads, produced silently, with both rows byte-identical
 * afterwards. A recurrence is the pair or it is not a recurrence.
 *
 * A one-time charge has no recurrence at all, so both members of the pair are
 * null for it rather than a `1` that would read as "every one of something".
 *
 * @param {any[]} lines
 */
export function groupBaseline(lines) {
  const groups = new Map();
  for (const line of lines) {
    const recurring = line.chargeType === 'recurring';
    const interval = recurring ? line.interval ?? null : null;
    const intervalCount = recurring && Number.isSafeInteger(line.intervalCount) ? line.intervalCount : null;
    const key = `${line.currency}|${line.chargeType}|${interval ?? 'none'}|${intervalCount ?? 'none'}`;
    const existing = groups.get(key) ?? {
      currency: line.currency, chargeType: line.chargeType, interval, intervalCount,
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
    if (byCharge !== 0) return byCharge;
    const byInterval = String(a.interval).localeCompare(String(b.interval));
    return byInterval !== 0 ? byInterval : Number(a.intervalCount ?? 0) - Number(b.intervalCount ?? 0);
  });
}

/**
 * The grouped baseline, serialized for storage in one deterministic order.
 *
 * A scalar cannot carry a mixed baseline: "EUR 120000" is three different asks
 * depending on whether it recurs monthly, annually or once, and a contract
 * routinely carries all three at the same time. Dropping every dimension the
 * moment the baseline stops collapsing — which is what a nullable scalar does —
 * loses exactly the evidence the follow-up exists to hand over. So the groups
 * themselves travel with the record, immutably, and the scalar summary is kept
 * only for the one case where it is unambiguous.
 *
 * Stored as text rather than as a child table for the same reason M12 stores
 * `tiersJson` and `obligationsJson` that way: it is one immutable evidence
 * blob, written once with its parent, never queried across and never updated.
 *
 * @param {ReturnType<typeof groupBaseline>} groups
 */
export function serializeBaselineGroups(groups) {
  return JSON.stringify(groups.map((group) => ({
    currency: group.currency,
    chargeType: group.chargeType,
    interval: group.interval,
    intervalCount: group.intervalCount,
    lineCount: group.lineCount,
    netAmountCents: group.netAmountCents,
  })));
}

/** What is missing from the evidence, named so an agent stops guessing. */
export function evidenceGaps(source) {
  const gaps = [];
  if (!source.term.endDate) gaps.push('NO_TERM_END_DATE');
  if (!source.term.source) gaps.push('NO_DECLARED_TERM_SOURCE');
  // `signed: null` is Contracts saying it will not decide for a provenance
  // nobody classified. It is a gap, not a `false`, and it is reported as one.
  if (source.term.source && source.term.signed === null) gaps.push('UNCLASSIFIED_TERM_SOURCE');
  if (!source.currentVersionId) gaps.push('NO_CURRENT_CONTRACT_VERSION');
  return gaps.sort();
}

/**
 * **The idempotent replay rule, in one place.**
 *
 * The defect this closes is not a duplicate row — the unique constraint and the
 * pending check already prevent that. It is the client whose *response* was
 * lost: it retries the identical ask and is told 409, so from where it stands
 * the work never happened and there is no way to find out that it did. A key
 * that identifies a business fact is only half an idempotency story; the other
 * half is answering a repeat of that fact with the fact.
 *
 * So a repeat is compared against what was recorded:
 *
 * - **identical** → the existing record is returned, exactly as the first call
 *   returned it. A retry is safe, however many times it happens.
 * - **different** → 409, **naming the fields that differ**. Somebody's recorded
 *   intent is never silently overwritten, and the refusal says what to look at
 *   rather than making the caller diff two records to find out.
 *
 * The compared fields are the caller's own inputs only. Everything else on the
 * row is derived from evidence the caller does not control, and comparing it
 * would turn an unrelated change elsewhere into a spurious conflict.
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
    `${what} was already recorded with a different ${conflictingFields.join(' and ')}; `
      + 'it is not overwritten. Read the existing record, or resolve it first.',
    { code, status: 409, details: { conflictingFields, existingId: existing.id } },
  );
}

/**
 * Whether an error is the framework's normalized unique-constraint refusal.
 *
 * The generated services translate `UNIQUE constraint failed` into a
 * `ConflictError` before it leaves the module, so no driver text ever reaches a
 * client. This recognizes that normalized error so the losing side of a race
 * can re-read and replay instead of surfacing a conflict for work that
 * demonstrably succeeded.
 *
 * @param {unknown} error
 */
function isUniqueConflict(error) {
  return error instanceof AppError && error.status === 409
    && /already exists|unique constraint/i.test(String(error.message));
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
          note: 'grouped by currency, charge type, interval AND interval count. Never summed into one number: a one-time fee, a monthly charge and a quarterly charge (month x 3) are three different kinds of money, and no FX is applied',
          groups: groupBaseline(lines),
          contractLineCount: lines.length,
          subscriptionLineCount: subscriptionLines.length,
        },
        evidenceGaps: evidenceGaps(evidence),
        approvalRequired: 'recording a decision, requesting a follow-up and resolving one all require actor.type === "user". No successor is recorded anywhere in M16a',
        limitations: [
          'NO_SCHEDULER — nothing fires on a boundary; this is asked, never pushed',
          'NOT_A_LEGAL_RENEWAL — no automatic or legal renewal is modelled or claimed',
          'NO_SUCCESSOR_LINK — nothing here records or synthesizes a successor contract',
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
      // **The business identity of a decision: (contract, calendar date).**
      // Nothing smaller identifies it — a contract alone would collapse two
      // genuinely different decisions taken months apart — and nothing larger
      // is needed, because "what did we decide about this contract on this day"
      // has exactly one answer. The clock is not in it: an identity that moves
      // every millisecond identifies nothing.
      //
      // `input.asOf` is canonical by construction here, because
      // `requireCalendarDate` above already refused every other spelling of the
      // same day. That is what makes the key trustworthy rather than merely
      // deterministic.
      const sourceKey = `renewal-decision:${record.id}:${input.asOf}`;
      const submitted = { decision: input.decision, reason };
      const replay = { code: 'RENEWAL_DECISION_CONFLICT', what: 'A renewal decision for this contract on this date' };

      const existing = decisions.listWhere({ sourceKey })[0];
      if (existing) return replayOrConflict(existing, submitted, replay);

      const decidedAt = now();
      try {
        return await decisions.createManaged({
          sourceKey,
          contractId: record.id,
          ...submitted,
          asOfDate: input.asOf,
          termEndDate: evidence.term.endDate ?? null,
          termSource: evidence.term.source ?? null,
          daysToBoundary: evidence.term.endDate ? daysToBoundary(input.asOf, evidence.term.endDate) : null,
          planFingerprint: null,
          decidedBy,
          decidedAt,
        }, { actor });
      } catch (error) {
        // Lost the insert race to another connection. The read above and the
        // write are not one atomic step across connections, and no amount of
        // re-reading makes them one — so the unique constraint decides, and the
        // loser answers from the winner's row rather than from a driver error.
        if (!isUniqueConflict(error)) throw error;
        const raced = decisions.listWhere({ sourceKey })[0];
        if (!raced) throw error;
        return replayOrConflict(raced, submitted, replay);
      }
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
      // **The business identity of an ask: (contract, intent, round).**
      //
      // The documented rule is that at most one follow-up of a given intent is
      // open on a contract at a time, so *the open one is the current ask* —
      // there is nothing smaller to key on and nothing else to disambiguate.
      // The round number only advances when the previous ask reached a terminal
      // state, which is what keeps genuinely repeated future work from being
      // collapsed: renewal comes round every year and each round is its own row.
      //
      // Both reads are exact (`listWhere`, no page bound): the guard and the
      // round number must be complete, not the first 500 rows.
      const history = followups.listWhere({ contractId: record.id, intent: input.intent });
      const submitted = { summary, decisionId: input.decisionId ?? null };
      const replay = { code: 'FOLLOWUP_ALREADY_PENDING', what: `A ${input.intent} follow-up on this contract` };

      // An open ask of the same intent answers a repeat of itself. This is the
      // whole fix: before, the identical retry of a client whose response was
      // lost got a bare 409 and no way to reach the record it had just created.
      // A *different* ask is still refused — and now says which field differs.
      const open = history.filter((row) => row.status === FOLLOWUP_OPEN);
      if (open.length > 0) return replayOrConflict(open[0], submitted, replay);

      const lines = source.listContractLines(record.id);
      const groups = groupBaseline(lines);
      // A one-time €1,200 and an annual €1,200 must not be byte-identical rows,
      // and a mixed baseline must not lose its money evidence to a null scalar.
      // The groups themselves are stored, immutably; the scalars below are a
      // convenience that exists only where it cannot mislead.
      const only = groups.length === 1 ? groups[0] : null;
      const sourceKey = `commercial-followup:${record.id}:${input.intent}:${history.length + 1}`;
      const requestedAt = now();
      const patch = {
        sourceKey,
        contractId: record.id,
        intent: input.intent,
        status: FOLLOWUP_OPEN,
        ...submitted,
        // One currency only when the baseline has exactly one; otherwise none,
        // because a mixed-currency total is not a number anybody should act on.
        currency: groups.length > 0 && groups.every((g) => g.currency === groups[0].currency) ? groups[0].currency : null,
        // An amount travels with the recurrence that gives it meaning, or it
        // does not travel. "EUR 171.00" is not a fact: monthly, quarterly,
        // annually and once are four different asks, and this row is what
        // Commercial reads. `intervalCount` is part of that recurrence — M12
        // spells quarterly as month × 3 — so it travels too.
        baselineNetAmountCents: only ? only.netAmountCents : null,
        baselineChargeType: only ? only.chargeType : null,
        baselineInterval: only ? only.interval : null,
        baselineIntervalCount: only ? only.intervalCount : null,
        // How many kinds of money the baseline holds, so "there is no single
        // amount" is a stated fact rather than an absence somebody has to infer
        // from three nulls.
        baselineGroupCount: groups.length,
        baselineGroupsJson: serializeBaselineGroups(groups),
        requestedBy,
        requestedAt,
        resolutionReason: null,
        resolvedBy: null,
        resolvedAt: null,
      };
      try {
        return await followups.createManaged(patch, { actor });
      } catch (error) {
        // Two connections computed the same round and the unique constraint
        // picked the winner. The loser answers from the winner's row.
        if (!isUniqueConflict(error)) throw error;
        const raced = followups.listWhere({ sourceKey })[0];
        if (!raced) throw error;
        return replayOrConflict(raced, submitted, replay);
      }
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
          'term dates come from M12 activation metadata and may never have been signed. Every date is reported with its declared source, and whether a term from that source is signed is derived from the source itself (contract-lifecycle-source@2), never asserted beside it. An unclassified source reports signed: null and the gap UNCLASSIFIED_TERM_SOURCE rather than a confident false',
        idempotency: {
          'renewal-decision':
            'identity is (contract, calendar date). An identical repeat returns the record already recorded; a repeat that differs is refused 409 RENEWAL_DECISION_CONFLICT naming the fields that differ. Recorded intent is never overwritten',
          'commercial-followup':
            'identity is (contract, intent, round). At most one follow-up of an intent is open at a time and the open one answers an identical repeat; a repeat that differs is refused 409 FOLLOWUP_ALREADY_PENDING naming the fields. The round advances only once the previous one is resolved_externally or withdrawn, so genuinely repeated future work is never collapsed',
          clock: 'no key contains a timestamp; a key that moves every millisecond identifies nothing',
        },
        baselineEvidence:
          'a follow-up carries its commercial baseline grouped by currency, charge type, interval AND interval count — quarterly is month x 3 and is not monthly. No total is computed across recurrences or currencies and no FX is applied; a single scalar amount is recorded only when the baseline holds exactly one kind of money',
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
